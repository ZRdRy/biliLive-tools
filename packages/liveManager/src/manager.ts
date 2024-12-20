import fs from "fs-extra";
import path from "node:path";
import mitt, { Emitter } from "mitt";
import { omit, range } from "lodash-es";
import { ChannelId } from "./common.js";
import {
  RecorderCreateOpts,
  Recorder,
  SerializedRecorder,
  RecordHandle,
  DebugLog,
} from "./recorder.js";
import { AnyObject, UnknownObject, replaceExtName } from "./utils.js";
import { createRecordExtraDataController } from "./record_extra_data_controller.js";
import { parseArgsStringToArgv } from "string-argv";
import filenamify from "filenamify";

export interface RecorderProvider<E extends AnyObject> {
  // Provider 的唯一 id，最好只由英文 + 数字组成
  // TODO: 可以加个检查 id 合法性的逻辑
  id: string;
  name: string;
  siteURL: string;

  // 用基础的域名、路径等方式快速决定一个 URL 是否能匹配此 provider
  matchURL: (this: RecorderProvider<E>, channelURL: string) => boolean;
  // 从一个与当前 provider 匹配的 URL 中解析与获取对应频道的一些信息
  resolveChannelInfoFromURL: (
    this: RecorderProvider<E>,
    channelURL: string,
  ) => Promise<{
    id: ChannelId;
    title: string;
    owner: string;
  } | null>;
  createRecorder: (
    this: RecorderProvider<E>,
    opts: Omit<RecorderCreateOpts<E>, "providerId">,
  ) => Recorder<E>;

  fromJSON: <T extends SerializedRecorder<E>>(this: RecorderProvider<E>, json: T) => Recorder<E>;

  setFFMPEGOutputArgs: (this: RecorderProvider<E>, args: string[]) => void;
}

const configurableProps = [
  "savePathRule",
  "autoRemoveSystemReservedChars",
  "autoCheckLiveStatusAndRecord",
  "autoCheckInterval",
  "ffmpegOutputArgs",
] as const;
type ConfigurableProp = (typeof configurableProps)[number];
function isConfigurableProp(prop: unknown): prop is ConfigurableProp {
  return configurableProps.includes(prop as any);
}

export interface RecorderManager<
  ME extends UnknownObject,
  P extends RecorderProvider<AnyObject> = RecorderProvider<UnknownObject>,
  PE extends AnyObject = GetProviderExtra<P>,
  E extends AnyObject = ME & PE,
> extends Emitter<{
    error: { source: string; err: unknown };
    RecordStart: { recorder: Recorder<E>; recordHandle: RecordHandle };
    RecordSegment: { recorder: Recorder<E>; recordHandle?: RecordHandle };
    videoFileCreated: { recorder: Recorder<E>; filename: string };
    videoFileCompleted: { recorder: Recorder<E>; filename: string };

    RecordStop: { recorder: Recorder<E>; recordHandle: RecordHandle; reason?: string };
    RecorderUpdated: {
      recorder: Recorder<E>;
      keys: (string | keyof Recorder<E>)[];
    };
    RecorderAdded: Recorder<E>;
    RecorderRemoved: Recorder<E>;
    RecorderDebugLog: DebugLog & { recorder: Recorder<E> };
    Updated: ConfigurableProp[];
  }> {
  providers: P[];
  // TODO: 这个或许可以去掉或者改改，感觉不是很有必要
  getChannelURLMatchedRecorderProviders: (
    this: RecorderManager<ME, P, PE, E>,
    channelURL: string,
  ) => P[];

  recorders: Recorder<E>[];
  addRecorder: (this: RecorderManager<ME, P, PE, E>, opts: RecorderCreateOpts<E>) => Recorder<E>;
  removeRecorder: (this: RecorderManager<ME, P, PE, E>, recorder: Recorder<E>) => void;

  autoCheckLiveStatusAndRecord: boolean;
  autoCheckInterval: number;
  isCheckLoopRunning: boolean;
  startCheckLoop: (this: RecorderManager<ME, P, PE, E>) => void;
  stopCheckLoop: (this: RecorderManager<ME, P, PE, E>) => void;

  savePathRule: string;
  autoRemoveSystemReservedChars: boolean;
  ffmpegOutputArgs: string;
}

export type RecorderManagerCreateOpts<
  ME extends AnyObject = UnknownObject,
  P extends RecorderProvider<AnyObject> = RecorderProvider<UnknownObject>,
  PE extends AnyObject = GetProviderExtra<P>,
  E extends AnyObject = ME & PE,
> = Partial<Pick<RecorderManager<ME, P, PE, E>, ConfigurableProp>> & {
  providers: P[];
};

export function createRecorderManager<
  ME extends AnyObject = UnknownObject,
  P extends RecorderProvider<AnyObject> = RecorderProvider<UnknownObject>,
  PE extends AnyObject = GetProviderExtra<P>,
  E extends AnyObject = ME & PE,
>(opts: RecorderManagerCreateOpts<ME, P, PE, E>): RecorderManager<ME, P, PE, E> {
  const recorders: Recorder<E>[] = [];

  let checkLoopTimer: NodeJS.Timeout | undefined;

  const multiThreadCheck = async (manager: RecorderManager<ME, P, PE, E>) => {
    // TODO: 先用写死的数量，后面改成可以设置的
    const maxThreadCount = 3;
    // 这里暂时不打算用 state == recording 来过滤，provider 必须内部自己处理录制过程中的 check，
    // 这样可以防止一些意外调用 checkLiveStatusAndRecord 时出现重复录制。
    const needCheckRecorders = recorders
      .filter((r) => !r.disableAutoCheck)
      .filter((r) => !r.tempStopIntervalCheck);

    const checkOnce = async () => {
      const recorder = needCheckRecorders.shift();
      if (recorder == null) return;

      await recorder.checkLiveStatusAndRecord({
        getSavePath(data) {
          return genSavePathFromRule(manager, recorder, data);
        },
      });
    };

    const threads = range(0, maxThreadCount).map(async () => {
      while (needCheckRecorders.length > 0) {
        try {
          await checkOnce();
        } catch (err) {
          manager.emit("error", { source: "checkOnceInThread", err });
        }
      }
    });

    await Promise.all(threads);
  };

  const manager: RecorderManager<ME, P, PE, E> = {
    // @ts-ignore
    ...mitt(),

    providers: opts.providers,
    getChannelURLMatchedRecorderProviders(channelURL) {
      return this.providers.filter((p) => p.matchURL(channelURL));
    },

    recorders,
    addRecorder(opts) {
      const provider = this.providers.find((p) => p.id === opts.providerId);
      if (provider == null) throw new Error("Cant find provider " + opts.providerId);

      // TODO: 因为泛型函数内部是不持有具体泛型的，这里被迫用了 as，没什么好的思路处理，除非
      // provider.createRecorder 能返回 Recorder<PE> 才能进一步优化。
      const recorder = provider.createRecorder(omit(opts, ["providerId"])) as Recorder<E>;
      this.recorders.push(recorder);

      recorder.on("RecordStart", (recordHandle) =>
        this.emit("RecordStart", { recorder, recordHandle }),
      );
      recorder.on("RecordSegment", (recordHandle) =>
        this.emit("RecordSegment", { recorder, recordHandle }),
      );
      recorder.on("videoFileCreated", ({ filename }) =>
        this.emit("videoFileCreated", { recorder, filename }),
      );
      recorder.on("videoFileCompleted", ({ filename }) =>
        this.emit("videoFileCompleted", { recorder, filename }),
      );
      recorder.on("RecordStop", ({ recordHandle, reason }) =>
        this.emit("RecordStop", { recorder, recordHandle, reason }),
      );
      recorder.on("Updated", (keys) => this.emit("RecorderUpdated", { recorder, keys }));
      recorder.on("DebugLog", (log) => this.emit("RecorderDebugLog", { recorder, ...log }));

      this.emit("RecorderAdded", recorder);

      return recorder;
    },
    removeRecorder(recorder) {
      const idx = this.recorders.findIndex((item) => item === recorder);
      if (idx === -1) return;
      recorder.recordHandle?.stop("remove recorder");
      this.recorders.splice(idx, 1);
      this.emit("RecorderRemoved", recorder);
    },

    autoCheckLiveStatusAndRecord: opts.autoCheckLiveStatusAndRecord ?? true,
    autoCheckInterval: opts.autoCheckInterval ?? 1000,
    isCheckLoopRunning: false,
    startCheckLoop() {
      if (this.isCheckLoopRunning) return;
      this.isCheckLoopRunning = true;
      // TODO: emit updated event

      const checkLoop = async () => {
        try {
          await multiThreadCheck(this);
        } catch (err) {
          this.emit("error", { source: "multiThreadCheck", err });
        } finally {
          if (!this.isCheckLoopRunning) {
            // do nothing
          } else {
            checkLoopTimer = setTimeout(checkLoop, this.autoCheckInterval);
          }
        }
      };

      void checkLoop();
    },
    stopCheckLoop() {
      if (!this.isCheckLoopRunning) return;
      this.isCheckLoopRunning = false;
      // TODO: emit updated event
      clearTimeout(checkLoopTimer);
    },

    savePathRule:
      opts.savePathRule ??
      path.join(
        process.cwd(),
        "{platform}/{owner}/{year}-{month}-{date} {hour}-{min}-{sec} {title}.mp4",
      ),

    autoRemoveSystemReservedChars: opts.autoRemoveSystemReservedChars ?? true,

    ffmpegOutputArgs:
      opts.ffmpegOutputArgs ??
      "-c copy" +
        /**
         * FragmentMP4 可以边录边播（浏览器原生支持），具有一定的抗损坏能力，录制中 KILL 只会丢失
         * 最后一个片段，而 FLV 格式如果录制中 KILL 了需要手动修复下 keyframes。所以默认使用 fmp4 格式。
         */
        " -movflags faststart+frag_keyframe+empty_moov" +
        /**
         * 浏览器加载 FragmentMP4 会需要先把它所有的 moof boxes 都加载完成后才能播放，
         * 默认的分段时长很小，会产生大量的 moof，导致加载很慢，所以这里设置一个分段的最小时长。
         *
         * TODO: 这个浏览器行为或许是可以优化的，比如试试给 fmp4 在录制完成后设置或者录制过程中实时更新 mvhd.duration。
         * https://stackoverflow.com/questions/55887980/how-to-use-media-source-extension-mse-low-latency-mode
         * https://stackoverflow.com/questions/61803136/ffmpeg-fragmented-mp4-takes-long-time-to-start-playing-on-chrome
         *
         * TODO: 如果浏览器行为无法优化，并且想进一步优化加载速度，可以考虑录制时使用 fmp4，录制完成后再转一次普通 mp4。
         */
        " -min_frag_duration 60000000",
  };

  const setProvidersFFMPEGOutputArgs = (ffmpegOutputArgs: string) => {
    const args = parseArgsStringToArgv(ffmpegOutputArgs);
    manager.providers.forEach((p) => p.setFFMPEGOutputArgs(args));
  };
  setProvidersFFMPEGOutputArgs(manager.ffmpegOutputArgs);

  const proxyManager = new Proxy(manager, {
    set(obj, prop, value) {
      Reflect.set(obj, prop, value);

      if (prop === "ffmpegOutputArgs") {
        setProvidersFFMPEGOutputArgs(value);
      }

      if (isConfigurableProp(prop)) {
        obj.emit("Updated", [prop]);
      }

      return true;
    },
  });

  return proxyManager;
}

function formatDate(date: Date, format: string): string {
  const map: { [key: string]: string } = {
    yyyy: date.getFullYear().toString(),
    MM: (date.getMonth() + 1).toString().padStart(2, "0"),
    dd: date.getDate().toString().padStart(2, "0"),
    HH: date.getHours().toString().padStart(2, "0"),
    mm: date.getMinutes().toString().padStart(2, "0"),
    ss: date.getSeconds().toString().padStart(2, "0"),
  };

  return format.replace(/yyyy|MM|dd|HH|mm|ss/g, (matched) => map[matched]);
}

export function genSavePathFromRule<
  ME extends AnyObject,
  P extends RecorderProvider<AnyObject>,
  PE extends AnyObject,
  E extends AnyObject,
>(
  manager: RecorderManager<ME, P, PE, E>,
  recorder: Recorder<E>,
  extData: {
    owner: string;
    title: string;
    startTime?: number;
  },
): string {
  // TODO: 这里随便写的，后面再优化
  const provider = manager.providers.find((p) => p.id === recorder.toJSON().providerId);

  const now = extData?.startTime ? new Date(extData.startTime) : new Date();
  const params = {
    platform: provider?.name ?? "unknown",
    channelId: recorder.channelId,
    remarks: recorder.remarks ?? "",
    year: formatDate(now, "yyyy"),
    month: formatDate(now, "MM"),
    date: formatDate(now, "dd"),
    hour: formatDate(now, "HH"),
    min: formatDate(now, "mm"),
    sec: formatDate(now, "ss"),
    ...extData,
  };
  if (manager.autoRemoveSystemReservedChars) {
    for (const key in params) {
      params[key] = removeSystemReservedChars(String(params[key]));
    }
  }

  return formatTemplate(manager.savePathRule, params);
}

const formatTemplate = function template(string: string, ...args: any[]) {
  const nargs = /\{([0-9a-zA-Z_]+)\}/g;

  let params;

  if (args.length === 1 && typeof args[0] === "object") {
    params = args[0];
  } else {
    params = args;
  }

  if (!params || !params.hasOwnProperty) {
    params = {};
  }

  return string.replace(nargs, function replaceArg(match, i, index) {
    let result;

    if (string[index - 1] === "{" && string[index + match.length] === "}") {
      return i;
    } else {
      result = Object.hasOwn(params, i) ? params[i] : null;
      if (result === null || result === undefined) {
        return "";
      }

      return result;
    }
  });
};

function removeSystemReservedChars(filename: string) {
  return filenamify(filename, { replacement: "_" });
}

export type GetProviderExtra<P> = P extends RecorderProvider<infer E> ? E : never;

class SegmentManager {
  segmentData: { startTime: number; rawname: string };
  extraDataController: ReturnType<typeof createRecordExtraDataController> | null = null;
  init = true;
  getSavePath: (opts: any) => string;
  owner: string;
  title: string;
  recorder: Recorder;

  constructor(
    recorder: Recorder,
    getSavePath: (opts: any) => string,
    owner: string,
    title: string,
    recordSavePath: string,
  ) {
    this.getSavePath = getSavePath;
    this.owner = owner;
    this.title = title;
    this.recorder = recorder;

    this.segmentData = { startTime: Date.now(), rawname: recordSavePath };
  }

  async handleSegmentEnd() {
    this.getExtraDataController()?.setMeta({ recordStopTimestamp: Date.now() });
    console.log("handle segmentData", this.segmentData);

    const trueFilepath = this.getSavePath({
      owner: this.owner,
      title: this.title,
      startTime: this.segmentData.startTime,
    });

    try {
      await Promise.all([
        fs.rename(this.segmentData.rawname, `${trueFilepath}.ts`),
        this.extraDataController?.flush(),
      ]);
      this.recorder.emit("videoFileCompleted", { filename: `${trueFilepath}.ts` });
    } catch (err) {
      this.recorder.emit("DebugLog", {
        type: "common",
        text: "videoFileCompleted error " + String(err),
      });
    }
  }

  async onSegmentStart(stderrLine: string) {
    if (!this.init) {
      await this.handleSegmentEnd();
    }
    this.init = false;
    this.segmentData.startTime = Date.now();

    const trueFilepath = this.getSavePath({
      owner: this.owner,
      title: this.title,
      startTime: this.segmentData.startTime,
    });
    this.extraDataController = createRecordExtraDataController(`${trueFilepath}.json`);
    this.extraDataController.setMeta({ title: this.title });
    console.log("segment segmentData", this.segmentData);

    const regex = /'([^']+)'/;
    const match = stderrLine.match(regex);
    if (match) {
      const filename = match[1];
      this.segmentData.rawname = filename;
      this.recorder.emit("videoFileCreated", { filename: `${trueFilepath}.ts` });
    } else {
      this.recorder.emit("DebugLog", { type: "ffmpeg", text: "No match found" });
      console.log("No match found");
    }
  }

  getSegmentData() {
    return this.segmentData;
  }

  getExtraDataController() {
    return this.extraDataController;
  }
}

export class StreamManager {
  private segmentManager: SegmentManager | null = null;
  private extraDataController: ReturnType<typeof createRecordExtraDataController> | null = null;
  extraDataSavePath: string;
  videoFilePath: string;
  recorder: Recorder;
  getSavePath: (opts: any) => string;
  owner: string;
  title: string;
  recordSavePath: string;

  constructor(
    recorder: Recorder,
    getSavePath: (opts: any) => string,
    owner: string,
    title: string,
    recordSavePath: string,
    hasSegment: boolean,
  ) {
    this.extraDataSavePath = replaceExtName(recordSavePath, ".json");
    this.videoFilePath = this.getVideoFilepath();
    this.recorder = recorder;
    this.getSavePath = getSavePath;
    this.owner = owner;
    this.title = title;
    this.recordSavePath = recordSavePath;

    if (hasSegment) {
      this.segmentManager = new SegmentManager(recorder, getSavePath, owner, title, recordSavePath);
    } else {
      this.extraDataController = createRecordExtraDataController(this.extraDataSavePath);
      this.extraDataController.setMeta({ title });
    }
  }

  async handleVideoStarted(stderrLine?: string) {
    // if (!stderrLine && this.segmentManager) {
    //   this.segmentManager.segmentData.startTime = Date.now();
    // }

    if (this.segmentManager) {
      if (stderrLine) {
        await this.segmentManager.onSegmentStart(stderrLine);
      }
    } else {
      this.recorder.emit("videoFileCreated", { filename: this.videoFilePath });
    }
  }

  async handleVideoCompleted() {
    console.log("handleVideoCompleted", this.getExtraDataController()?.data);

    if (this.segmentManager) {
      await this.segmentManager.handleSegmentEnd();
    } else {
      this.getExtraDataController()?.setMeta({ recordStopTimestamp: Date.now() });
      await this.getExtraDataController()?.flush();
      this.recorder.emit("videoFileCompleted", { filename: this.videoFilePath });
    }
  }

  getExtraDataController() {
    return this.segmentManager?.getExtraDataController() || this.extraDataController;
  }

  getSegmentData() {
    return this.segmentManager?.getSegmentData();
  }

  getVideoFilepath() {
    return this.segmentManager ? `${this.recordSavePath}-PART%03d.ts` : `${this.recordSavePath}.ts`;
  }
}
