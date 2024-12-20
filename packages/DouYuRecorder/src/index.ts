import mitt from "mitt";
import {
  Recorder,
  RecorderCreateOpts,
  RecorderProvider,
  createFFMPEGBuilder,
  RecordHandle,
  defaultFromJSON,
  defaultToJSON,
  genRecorderUUID,
  genRecordUUID,
  StreamManager,
  utils,
} from "@autorecord/manager";
import type { Comment, GiveGift, SuperChat } from "@autorecord/manager";

import { getInfo, getStream } from "./stream.js";
import { getRoomInfo } from "./dy_api.js";
import { assert, ensureFolderExist } from "./utils.js";
import { createDYClient } from "./dy_client/index.js";
import { giftMap, colorTab } from "./danma.js";
import { requester } from "./requester.js";

function createRecorder(opts: RecorderCreateOpts): Recorder {
  // 内部实现时，应该只有 proxy 包裹的那一层会使用这个 recorder 标识符，不应该有直接通过
  // 此标志来操作这个对象的地方，不然会跳过 proxy 的拦截。
  const recorder: Recorder = {
    id: opts.id ?? genRecorderUUID(),
    extra: opts.extra ?? {},
    // @ts-ignore
    ...mitt(),
    ...opts,

    availableStreams: [],
    availableSources: [],
    state: "idle",

    getChannelURL() {
      return `https://www.douyu.com/${this.channelId}`;
    },
    checkLiveStatusAndRecord: utils.singleton(checkLiveStatusAndRecord),

    toJSON() {
      return defaultToJSON(provider, this);
    },

    async getLiveInfo() {
      const channelId = this.channelId;
      const info = await getInfo(channelId);
      return {
        channelId,
        ...info,
      };
    },
  };

  const recorderWithSupportUpdatedEvent = new Proxy(recorder, {
    set(obj, prop, value) {
      Reflect.set(obj, prop, value);

      if (typeof prop === "string") {
        obj.emit("Updated", [prop]);
      }

      return true;
    },
  });

  return recorderWithSupportUpdatedEvent;
}

const ffmpegOutputOptions: string[] = [
  "-c",
  "copy",
  "-movflags",
  "frag_keyframe",
  "-min_frag_duration",
  "60000000",
];

const checkLiveStatusAndRecord: Recorder["checkLiveStatusAndRecord"] = async function ({
  getSavePath,
}) {
  this.tempStopIntervalCheck = false;
  if (this.recordHandle != null) return this.recordHandle;

  const liveInfo = await getInfo(this.channelId);
  this.liveInfo = liveInfo;
  const { living, owner, title } = liveInfo;
  if (!living) return null;

  this.state = "recording";
  let res;
  // TODO: 先不做什么错误处理，就简单包一下预期上会有错误的地方
  try {
    res = await getStream({
      channelId: this.channelId,
      quality: this.quality,
      streamPriorities: this.streamPriorities,
      sourcePriorities: this.sourcePriorities,
    });
  } catch (err) {
    this.state = "idle";
    throw err;
  }
  const { currentStream: stream, sources: availableSources, streams: availableStreams } = res;
  this.availableStreams = availableStreams.map((s) => s.name);
  this.availableSources = availableSources.map((s) => s.name);
  this.usedStream = stream.name;
  this.usedSource = stream.source;
  // TODO: emit update event
  const savePath = getSavePath({ owner, title });
  const hasSegment = !!this.segment;
  const streamManager = new StreamManager(this, getSavePath, owner, title, savePath, hasSegment);
  const templateSavePath = streamManager.getVideoFilepath();
  const extraDataSavePath = streamManager.extraDataSavePath;

  try {
    // TODO: 这个 ensure 或许应该放在 createRecordExtraDataController 里实现？
    ensureFolderExist(extraDataSavePath);
    ensureFolderExist(savePath);
  } catch (err) {
    this.state = "idle";
    throw err;
  }

  const client = createDYClient(Number(this.channelId), {
    notAutoStart: true,
  });
  client.on("message", (msg) => {
    const extraDataController = streamManager.getExtraDataController();
    if (!extraDataController) return;
    switch (msg.type) {
      case "chatmsg": {
        const comment: Comment = {
          type: "comment",
          timestamp: Date.now(),
          text: msg.txt,
          color: colorTab[msg.col] ?? "#ffffff",
          sender: {
            uid: msg.uid,
            name: msg.nn,
            avatar: msg.ic,
            extra: {
              level: msg.level,
            },
          },
        };
        this.emit("Message", comment);
        extraDataController.addMessage(comment);
        break;
      }
      case "dgb": {
        if (this.saveGiftDanma === false) return;
        const gift: GiveGift = {
          type: "give_gift",
          timestamp: Date.now(),
          name: giftMap[msg.gfid]?.name ?? msg.gfn,
          price: (giftMap[msg.gfid]?.pc ?? 0) / 100,
          count: Number(msg.gfcnt),
          color: "#ffffff",
          sender: {
            uid: msg.uid,
            name: msg.nn,
            avatar: msg.ic,
            extra: {
              level: msg.level,
            },
          },
          extra: {
            hits: Number(msg.hits),
          },
          // @ts-ignore
          // raw: msg,
        };
        this.emit("Message", gift);
        extraDataController.addMessage(gift);
        break;

        // TODO: 还有一些其他礼物相关的 msg 要处理，目前先简单点只处理 dgb
      }
      case "comm_chatmsg": {
        if (this.saveSCDanma === false) return;
        switch (msg.btype) {
          case "voiceDanmu": {
            const comment: SuperChat = {
              type: "super_chat",
              timestamp: Date.now(),
              text: msg?.chatmsg?.txt,
              price: Number(msg.cprice) / 100,
              sender: {
                uid: msg.uid,
                name: msg?.chatmsg?.nn,
                avatar: msg?.chatmsg?.ic,
                extra: {
                  level: msg?.chatmsg?.level,
                },
              },
            };
            this.emit("Message", comment);
            extraDataController.addMessage(comment);
            break;
          }
        }
        break;
      }
    }
  });
  // console.log("this.disableProvideCommentsWhenRecording", this.disableProvideCommentsWhenRecording);
  if (!this.disableProvideCommentsWhenRecording) {
    client.start();
  }
  this.on("Updated", (key) => {
    console.log("key", key);
    if (key[0] === "disableProvideCommentsWhenRecording") {
      if (this.disableProvideCommentsWhenRecording) {
        client.stop();
      } else {
        client.start();
      }
    }
  });

  let isEnded = false;
  const onEnd = async (...args: unknown[]) => {
    if (isEnded) return;
    isEnded = true;

    this.emit("DebugLog", {
      type: "common",
      text: `ffmpeg end, reason: ${JSON.stringify(args, (_, v) => (v instanceof Error ? v.stack : v))}`,
    });
    const reason = args[0] instanceof Error ? args[0].message : String(args[0]);
    this.recordHandle?.stop(reason);
  };

  const isInvalidStream = createInvalidStreamChecker();
  const timeoutChecker = createTimeoutChecker(() => onEnd("ffmpeg timeout"), 10e3);
  const command = createFFMPEGBuilder(stream.url)
    .inputOptions(
      "-user_agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.86 Safari/537.36",
    )
    .outputOptions(ffmpegOutputOptions)
    .output(templateSavePath)
    .on("start", () => {
      streamManager.handleVideoStarted();
    })
    .on("error", onEnd)
    .on("end", () => onEnd("finished"))
    .on("stderr", async (stderrLine) => {
      assert(typeof stderrLine === "string");
      if (stderrLine.includes("Opening ")) {
        await streamManager.handleVideoStarted(stderrLine);
      }
      // TODO:解析时间
      this.emit("DebugLog", { type: "ffmpeg", text: stderrLine });

      if (isInvalidStream(stderrLine)) {
        onEnd("invalid stream");
      }
    })
    .on("stderr", timeoutChecker.update);
  if (hasSegment) {
    command.outputOptions(
      "-f",
      "segment",
      "-segment_time",
      String(this.segment! * 60),
      "-reset_timestamps",
      "1",
    );
  }
  const ffmpegArgs = command._getArguments();
  // console.log("ffmpegArgs", ffmpegArgs);
  // extraDataController.setMeta({
  //   recordStartTimestamp: Date.now(),
  //   ffmpegArgs,
  // });
  command.run();

  // TODO: 需要一个机制防止空录制，比如检查文件的大小变化、ffmpeg 的输出、直播状态等

  const stop = utils.singleton<RecordHandle["stop"]>(
    async (reason?: string, tempStopIntervalCheck?: boolean) => {
      if (!this.recordHandle) return;
      this.tempStopIntervalCheck = !!tempStopIntervalCheck;
      this.state = "stopping-record";
      // TODO: emit update event

      timeoutChecker.stop();

      try {
        // 如果给 SIGKILL 信号会非正常退出，SIGINT 可以被 ffmpeg 正常处理。
        // TODO: fluent-ffmpeg 好像没处理好这个 SIGINT 导致的退出信息，会抛一个错。
        // command.kill("SIGINT");
        // @ts-ignore
        command.ffmpegProc?.stdin?.write("q");
        // TODO: 这里可能会有内存泄露，因为事件还没清，之后再检查下看看。
        client.stop();
      } catch (err) {
        // TODO: 这个 stop 经常报错，这里先把错误吞掉，以后再处理。
        this.emit("DebugLog", { type: "common", text: String(err) });
      }

      this.usedStream = undefined;
      this.usedSource = undefined;
      // TODO: other codes
      // TODO: emit update event
      await streamManager.handleVideoCompleted();
      this.emit("RecordStop", { recordHandle: this.recordHandle, reason });
      this.recordHandle = undefined;
      this.state = "idle";
    },
  );

  this.recordHandle = {
    id: genRecordUUID(),
    stream: stream.name,
    source: stream.source,
    url: stream.url,
    ffmpegArgs,
    savePath: savePath,
    stop,
  };
  this.emit("RecordStart", this.recordHandle);

  return this.recordHandle;
};

function createTimeoutChecker(
  onTimeout: () => void,
  time: number,
): {
  update: () => void;
  stop: () => void;
} {
  let timer: NodeJS.Timeout | null = null;
  let stopped: boolean = false;

  const update = () => {
    if (stopped) return;
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onTimeout();
    }, time);
  };

  update();

  return {
    update,
    stop() {
      stopped = true;
      if (timer != null) clearTimeout(timer);
      timer = null;
    },
  };
}

function createInvalidStreamChecker(): (ffmpegLogLine: string) => boolean {
  let prevFrame = 0;
  let frameUnchangedCount = 0;

  return (ffmpegLogLine) => {
    const streamInfo = ffmpegLogLine.match(
      /frame=\s*(\d+) fps=.*? q=.*? size=\s*(\d+)kB time=.*? bitrate=.*? speed=.*?/,
    );
    if (streamInfo != null) {
      const [, frameText] = streamInfo;
      const frame = Number(frameText);

      if (frame === prevFrame) {
        if (++frameUnchangedCount >= 10) {
          return true;
        }
      } else {
        prevFrame = frame;
        frameUnchangedCount = 0;
      }

      return false;
    }

    if (ffmpegLogLine.includes("HTTP error 404 Not Found")) {
      return true;
    }

    return false;
  };
}

export const provider: RecorderProvider<Record<string, unknown>> = {
  id: "DouYu",
  name: "斗鱼",
  siteURL: "https://douyu.com/",

  matchURL(channelURL) {
    return /https?:\/\/(?:.*?\.)?douyu.com\//.test(channelURL);
  },

  async resolveChannelInfoFromURL(channelURL) {
    if (!this.matchURL(channelURL)) return null;

    channelURL = channelURL.trim();
    const res = await requester.get(channelURL);
    const html = res.data;

    const matched = html.match(/\$ROOM\.room_id.?=(.*?);/);
    if (!matched) return null;
    const room_id = matched[1].trim();

    const roomInfo = await getRoomInfo(Number(room_id));

    return {
      id: matched[1].trim(),
      title: roomInfo.room.room_name,
      owner: roomInfo.room.nickname,
    };
  },

  createRecorder(opts) {
    return createRecorder({ providerId: provider.id, ...opts });
  },

  fromJSON(recorder) {
    return defaultFromJSON(this, recorder);
  },

  setFFMPEGOutputArgs(args) {
    ffmpegOutputOptions.splice(0, ffmpegOutputOptions.length, ...args);
  },
};
