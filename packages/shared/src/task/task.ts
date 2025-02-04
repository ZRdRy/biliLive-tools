import EventEmitter from "node:events";
import { TypedEmitter } from "tiny-typed-emitter";
// @ts-ignore
import * as ntsuspend from "ntsuspend";

import { uuid, isWin32, retry, isBetweenTime } from "../utils/index.js";
import log from "../utils/log.js";
import { sendNotify } from "../notify.js";
import { appConfig } from "../config.js";
import kill from "tree-kill";
import { addMediaApi, editMediaApi } from "./bili.js";
import { TaskType } from "../enum.js";

import type ffmpeg from "@renmu/fluent-ffmpeg";
import type { Client, WebVideoUploader } from "@renmu/bili-api";
import type { Progress, NotificationTaskStatus, BiliupConfig } from "@biliLive-tools/types";
import type { Status } from "@biliLive-tools/types/task.d.ts";
import type M3U8Downloader from "@renmu/m3u8-downloader";
import type { AppConfig } from "../config.js";
import type { DanmakuFactory } from "../danmu/danmakuFactory.js";

interface TaskEvents {
  "task-start": ({ taskId }: { taskId: string }) => void;
  "task-end": ({ taskId }: { taskId: string }) => void;
  "task-error": ({ taskId, error }: { taskId: string; error: string }) => void;
  "task-progress": ({ taskId }: { taskId: string }) => void;
  "task-pause": ({ taskId }: { taskId: string }) => void;
  "task-resume": ({ taskId }: { taskId: string }) => void;
  "task-cancel": ({ taskId }: { taskId: string; autoStart: boolean }) => void;
  "task-removed-queue": ({ taskId }: { taskId: string }) => void;
  [key: string]: (...args: any[]) => void;
}

export abstract class AbstractTask {
  taskId: string;
  pid?: string;
  status: Status;
  name: string;
  relTaskId?: string;
  output?: string;
  progress: number;
  custsomProgressMsg: string;
  action: ("pause" | "kill" | "interrupt")[];
  startTime: number = 0;
  endTime?: number;
  error?: string;
  pauseStartTime: number | null = 0;
  totalPausedDuration: number = 0;
  emitter = new TypedEmitter<TaskEvents>();
  limitTime?: [] | [string, string];
  on: TypedEmitter<TaskEvents>["on"];
  emit: TypedEmitter<TaskEvents>["emit"];

  abstract type: string;
  abstract exec(): void;
  abstract kill(): void;
  abstract pause(): void;
  abstract resume(): void;
  constructor() {
    this.taskId = uuid();
    this.status = "pending";
    this.name = this.taskId;
    this.progress = 0;
    this.action = ["pause", "kill"];
    this.custsomProgressMsg = "";
    this.on = this.emitter.on.bind(this.emitter);
    this.emit = this.emitter.emit.bind(this.emitter);
  }
  getDuration(): number {
    if (this.status === "pending") return 0;
    const now = Date.now();
    const currentTime = this.endTime || now;
    return Math.max(currentTime - this.startTime, 0);
  }
}

export class DanmuTask extends AbstractTask {
  danmu: DanmakuFactory;
  input: string;
  options: any;
  type = TaskType.danmu;
  controller: AbortController;
  callback: {
    onStart?: () => void;
    onEnd?: (output: string) => void;
    onError?: (err: string) => void;
    onProgress?: (progress: Progress) => any;
  };
  constructor(
    danmu: DanmakuFactory,
    options: {
      input: string;
      output: string;
      options: any;
      name: string;
    },
    callback?: {
      onStart?: () => void;
      onEnd?: (output: string) => void;
      onError?: (err: string) => void;
      onProgress?: (progress: Progress) => any;
    },
  ) {
    super();
    this.danmu = danmu;
    this.input = options.input;
    this.options = options.options;
    this.output = options.output;
    this.progress = 0;
    if (options.name) {
      this.name = options.name;
    }
    this.action = ["kill"];
    this.callback = callback || {};
    this.controller = new AbortController();
  }
  exec() {
    this.callback.onStart && this.callback.onStart();
    this.status = "running";
    this.progress = 0;
    this.emitter.emit("task-start", { taskId: this.taskId });
    this.startTime = Date.now();
    this.danmu
      .convertXml2Ass(this.input, this.output as string, this.options)
      .then(() => {
        this.status = "completed";
        this.callback.onEnd && this.callback.onEnd(this.output as string);
        this.progress = 100;
        this.emitter.emit("task-end", { taskId: this.taskId });
      })
      .catch((err) => {
        this.status = "error";
        this.callback.onError && this.callback.onError(err);
        this.error = err;
        this.emitter.emit("task-error", { taskId: this.taskId, error: err });
      })
      .finally(() => {
        this.endTime = Date.now();
      });
  }
  pause() {
    return false;
  }
  resume() {
    return false;
  }
  kill() {
    if (this.status === "completed" || this.status === "error" || this.status === "canceled")
      return;
    log.warn(`danmu task ${this.taskId} killed`);
    this.status = "canceled";
    if (this.danmu?.child?.pid) {
      kill(this.danmu.child.pid);
    }
    return true;
  }
}

export class FFmpegTask extends AbstractTask {
  command: ffmpeg.FfmpegCommand;
  type = TaskType.ffmpeg;
  isInterrupted: boolean = false;

  constructor(
    command: ffmpeg.FfmpegCommand,
    options: {
      output: string;
      name: string;
      limitTime?: [] | [string, string];
    },
    callback: {
      onStart?: () => void;
      onEnd?: (output: string) => void;
      onError?: (err: string) => void;
      onProgress?: (progress: Progress) => any;
    },
  ) {
    super();
    this.command = command;
    this.output = options.output;
    this.progress = 0;
    this.action = ["kill", "pause", "interrupt"];
    this.limitTime = options.limitTime;
    if (options.name) {
      this.name = options.name;
    }

    log.info(
      `ffmpeg task ${this.taskId} has been added, command: ${command._getArguments().join(" ")}`,
    );

    command.on("start", (commandLine: string) => {
      this.progress = 0;
      log.info(`task ${this.taskId} start, command: ${commandLine}`);
      this.status = "running";

      callback.onStart && callback.onStart();
      this.emitter.emit("task-start", { taskId: this.taskId });

      this.startTime = Date.now();
    });
    command.on("end", async () => {
      // 如果任务是被中断的，走这个逻辑
      if (this.isInterrupted) {
        const msg = `task ${this.taskId} error: isInterrupted`;
        log.error(msg);
        this.status = "error";

        callback.onError && callback.onError(msg);
        this.error = msg;
        this.emitter.emit("task-error", { taskId: this.taskId, error: msg });
      } else {
        log.info(`task ${this.taskId} end`);
        this.status = "completed";
        this.progress = 100;

        callback.onEnd && callback.onEnd(options.output);
        this.emitter.emit("task-end", { taskId: this.taskId });
      }
      this.endTime = Date.now();
    });
    command.on("error", (err) => {
      log.error(`task ${this.taskId} error: ${err}`);
      this.status = "error";

      callback.onError && callback.onError(String(err));
      this.error = String(err);
      this.emitter.emit("task-error", { taskId: this.taskId, error: String(err) });
      this.endTime = Date.now();
    });
    command.on("progress", (progress) => {
      // @ts-ignore
      progress.percentage = progress.percent;
      // console.log("progress", progress);
      if (callback.onProgress) {
        // @ts-ignore
        progress = callback.onProgress(progress);
      }
      // @ts-ignore
      this.custsomProgressMsg = `比特率: ${progress.currentKbps}kbits/s   速率: ${progress.speed}`;
      // @ts-ignore
      this.progress = progress.percentage || 0;
      this.emitter.emit("task-progress", { taskId: this.taskId });
    });
  }
  exec() {
    if (this.status !== "pending") console.warn("ffmpeg task is not pending when exec");

    this.status = "running";
    this.command.run();
  }
  pause() {
    if (this.status !== "running") return;
    if (isWin32) {
      // @ts-ignore
      ntsuspend.suspend(this.command.ffmpegProc.pid);
    } else {
      this.command.kill("SIGSTOP");
    }
    log.warn(`task ${this.taskId} paused`);
    this.status = "paused";
    this.emitter.emit("task-pause", { taskId: this.taskId });
    return true;
  }
  resume() {
    if (this.status !== "paused") return;
    if (isWin32) {
      // @ts-ignore
      ntsuspend.resume(this.command.ffmpegProc.pid);
    } else {
      this.command.kill("SIGCONT");
    }
    log.warn(`task ${this.taskId} resumed`);
    this.status = "running";
    this.emitter.emit("task-resume", { taskId: this.taskId });
    return true;
  }
  interrupt() {
    if (this.status === "completed" || this.status === "error") return;
    if (isWin32) {
      // @ts-ignore
      ntsuspend.resume(this.command.ffmpegProc.pid);
    }
    // @ts-ignore
    this.command.ffmpegProc.stdin.write("q");
    log.warn(`task ${this.taskId} interrupted`);
    this.isInterrupted = true;
    this.status = "error";
    return true;
  }
  kill() {
    if (this.status === "completed" || this.status === "error" || this.status === "canceled")
      return;
    if (isWin32) {
      // @ts-ignore
      ntsuspend.resume(this.command.ffmpegProc.pid);
    }
    this.command.kill("SIGKILL");
    log.warn(`task ${this.taskId} killed`);
    // 不需要额外触发error事件，因为ffmpeg会触发error事件，ffmpeg没有取消事件
    this.status = "error";
    return true;
  }
}

type WithoutPromise<T> = T extends Promise<infer U> ? U : T;

/**
 * B站视频上传任务
 */
export class BiliPartVideoTask extends AbstractTask {
  command: WebVideoUploader;
  type = TaskType.biliUpload;

  constructor(
    command: WebVideoUploader,
    options: {
      name: string;
      pid: string;
      limitTime: [] | [string, string];
    },
    callback: {
      onStart?: () => void;
      onEnd?: (output: { cid: number; filename: string; title: string }) => void;
      onError?: (err: string) => void;
      onProgress?: (progress: number) => number;
    },
  ) {
    super();
    this.command = command;
    this.progress = 0;
    this.action = ["kill", "pause"];
    this.limitTime = options.limitTime;
    if (options.name) {
      this.name = options.name;
    }
    this.pid = options.pid;

    command.emitter.on(
      "completed",
      async (data: { cid: number; filename: string; title: string }) => {
        log.info(`task ${this.taskId} end`, data);
        this.status = "completed";
        this.progress = 100;
        callback.onEnd && callback.onEnd(data);
        this.emitter.emit("task-end", { taskId: this.taskId });
        this.endTime = Date.now();
      },
    );
    command.emitter.on("error", (err) => {
      log.error(`task ${this.taskId} error: ${err}`);
      this.status = "error";
      this.error = String(err);

      callback.onError && callback.onError(this.error);
      this.emitter.emit("task-error", { taskId: this.taskId, error: this.error });
      this.endTime = Date.now();
    });

    command.emitter.on("progress", (event) => {
      let progress = event.progress * 100;
      this.progress = progress;
      callback.onProgress && callback.onProgress(progress);
      this.emitter.emit("task-progress", { taskId: this.taskId });
    });
  }
  exec() {
    this.status = "running";
    this.startTime = Date.now();
    this.emitter.emit("task-start", { taskId: this.taskId });
    this.command.upload();
  }
  pause() {
    if (this.status !== "running") return;

    this.command.pause();
    log.warn(`task ${this.taskId} paused`);
    this.status = "paused";
    this.emitter.emit("task-pause", { taskId: this.taskId });
    return true;
  }
  resume() {
    if (this.status !== "paused") return;
    this.command.start();
    log.warn(`task ${this.taskId} resumed`);
    this.status = "running";
    this.emitter.emit("task-resume", { taskId: this.taskId });
    return true;
  }
  kill(triggerAutoStart = true) {
    if (this.status === "completed" || this.status === "error" || this.status === "canceled")
      return;
    log.warn(`task ${this.taskId} killed`);
    this.status = "canceled";
    this.command.cancel();
    this.emit("task-cancel", { taskId: this.taskId, autoStart: triggerAutoStart });
    this.endTime = Date.now();
    return true;
  }
}

/**
 * B站视频提交任务
 */
export class BiliVideoTask extends AbstractTask {
  taskList: BiliPartVideoTask[] = [];
  type = TaskType.bili;
  completedTask: number = 0;
  uid: number;
  callback: {
    onStart?: () => void;
    onEnd?: (output: { aid: number; bvid: string }) => void;
    onError?: (err: string) => void;
    onProgress?: (progress: number) => any;
  };
  constructor(
    options: {
      name: string;
      uid: number;
    },
    callback: {
      onStart?: () => void;
      onEnd?: (output: { aid: number; bvid: string }) => void;
      onError?: (err: string) => void;
      onProgress?: (progress: number) => any;
    },
  ) {
    super();
    this.progress = 0;
    this.action = ["kill"];
    if (options.name) {
      this.name = options.name;
    }
    this.callback = callback;

    this.status = "running";
    this.startTime = Date.now();
    this.uid = options.uid;
    this.emitter.emit("task-start", { taskId: this.taskId });
  }
  addTask(task: BiliPartVideoTask) {
    this.taskList.push(task);

    task.command.on("completed", async () => {
      // console.log("completed", this.completedTask);
      this.completedTask++;

      if (this.completedTask === this.taskList.length) {
        this.emit("completed");
        // this.submit();
      }
    });
    task.on("task-cancel", ({ taskId }) => {
      this.removeTask(taskId);
    });
    task.on("task-error", ({ taskId }) => {
      console.log("task-error", taskId);
      const submitWhenError = false;
      if (submitWhenError) {
        // 在有上传失败的情况下，仍继续提交
      } else {
        this.cancelAllTask();
        this.status = "error";
        this.emit("task-error", { taskId: this.taskId, error: "上传失败" });
      }
      // this.removeTask(taskId);
    });
    task.on("task-removed-queue", ({ taskId }) => {
      this.removeTask(taskId);
    });
  }
  removeTask(taskId: string) {
    const task = this.taskList.find((task) => task.taskId === taskId);
    if (!task) return;
    const index = this.taskList.indexOf(task);
    if (index !== -1) {
      this.taskList.splice(index, 1);
    }
    if (this.taskList.length === 0) {
      this.status = "error";
      this.emit("task-error", { taskId: this.taskId, error: "上传失败" });
    }
    if (this.taskList.length >= this.completedTask) {
      this.emit("completed");
    }
  }

  exec() {
    // this.command.run();
  }
  pause() {
    if (this.status !== "running") return;
    return true;
  }
  resume() {
    if (this.status !== "paused") return;
    return true;
  }
  cancelAllTask() {
    const taskIds = this.taskList.map((task) => task.taskId);
    for (const taskId of taskIds) {
      const task = this.taskList.find((task) => task.taskId === taskId);
      if (task) {
        task.kill(false);
      }
    }
  }
  kill() {
    if (this.status === "completed" || this.status === "error" || this.status === "canceled")
      return;
    this.cancelAllTask();

    log.warn(`task ${this.taskId} canceled`);
    this.status = "canceled";
    this.emit("task-cancel", { taskId: this.taskId, autoStart: true });
    return true;
  }
}

/**
 * B站视频上传提交任务
 */
export class BiliAddVideoTask extends BiliVideoTask {
  mediaOptions: BiliupConfig;

  constructor(
    options: {
      name: string;
      uid: number;
      mediaOptions: BiliupConfig;
    },
    callback: {
      onStart?: () => void;
      onEnd?: (output: { aid: number; bvid: string }) => void;
      onError?: (err: string) => void;
      onProgress?: (progress: number) => any;
    },
  ) {
    super(options, callback);
    this.mediaOptions = options.mediaOptions;

    this.on("completed", () => {
      this.submit();
    });
  }
  async submit() {
    const parts = this.taskList
      .filter((task) => task.status === "completed")
      .map((task) => {
        return task.command.completedPart;
      });
    if (parts.length === 0) return;
    try {
      const data = await retry(() => addMediaApi(this.uid, parts, this.mediaOptions));
      this.status = "completed";
      this.progress = 100;
      this.callback.onEnd && this.callback.onEnd(data);
      this.output = String(data.aid);
      this.emitter.emit("task-end", { taskId: this.taskId });
    } catch (err) {
      log.error("上传失败", err);
      this.status = "error";
      this.error = String(err);
      this.callback.onError && this.callback.onError(this.error);
      this.emitter.emit("task-error", { taskId: this.taskId, error: this.error });
    }
    this.endTime = Date.now();
  }
}

/**
 * B站视频编辑提交任务
 */
export class BiliEditVideoTask extends BiliVideoTask {
  aid: number;
  mediaOptions: BiliupConfig;
  constructor(
    options: {
      name: string;
      uid: number;
      mediaOptions: BiliupConfig;
      aid: number;
    },
    callback: {
      onStart?: () => void;
      onEnd?: (output: { aid: number; bvid: string }) => void;
      onError?: (err: string) => void;
      onProgress?: (progress: number) => any;
    },
  ) {
    super(options, callback);
    this.aid = options.aid;
    this.mediaOptions = options.mediaOptions;

    this.on("completed", () => {
      this.submit();
    });
  }
  async submit() {
    const parts = this.taskList
      .filter((task) => task.status === "completed")
      .map((task) => {
        return task.command.completedPart;
      });
    if (parts.length === 0) {
      log.error("没有上传成功的视频");
      return;
    }
    try {
      const data = await retry(() => editMediaApi(this.uid, this.aid, parts, this.mediaOptions));
      this.status = "completed";
      this.progress = 100;
      this.callback.onEnd && this.callback.onEnd(data);
      this.output = String(data.aid);
      this.emitter.emit("task-end", { taskId: this.taskId });
    } catch (err) {
      log.error("编辑失败", err);
      this.status = "error";
      this.error = String(err);
      this.callback.onError && this.callback.onError(this.error);
      this.emitter.emit("task-error", { taskId: this.taskId, error: this.error });
    }
    this.endTime = Date.now();
  }
}

/**
 * B站下载任务
 */
export class BiliDownloadVideoTask extends AbstractTask {
  command: WithoutPromise<ReturnType<Client["video"]["download"]>>;
  type = TaskType.biliDownload;
  emitter = new EventEmitter() as TypedEmitter<TaskEvents>;
  constructor(
    command: WithoutPromise<ReturnType<Client["video"]["download"]>>,
    options: {
      name: string;
    },
    callback: {
      onStart?: () => void;
      onEnd?: (output: string) => void;
      onError?: (err: string) => void;
      onProgress?: (progress: number) => any;
    },
  ) {
    super();
    this.command = command;
    this.progress = 0;
    this.action = ["kill", "pause"];

    if (options.name) {
      this.name = options.name;
    }

    // command.emitter.on("start", (commandLine: string) => {
    //   this.progress = 0;
    //   log.info(`task ${this.taskId} start, command: ${commandLine}`);
    //   this.status = "running";

    //   callback.onStart && callback.onStart();
    //   emitter.emit("task-start", { taskId: this.taskId });
    //   this.startTime = Date.now();
    // });

    command.emitter.on("completed", async (data) => {
      log.info(`task ${this.taskId} end`);
      this.status = "completed";
      this.progress = 100;
      this.output = data;
      callback.onEnd && callback.onEnd(data);
      this.emitter.emit("task-end", { taskId: this.taskId });
      this.endTime = Date.now();
    });
    command.emitter.on("error", (err) => {
      log.error(`task ${this.taskId} error: ${err}`);
      this.status = "error";

      callback.onError && callback.onError(err);
      this.error = err;
      this.emitter.emit("task-error", { taskId: this.taskId, error: err });
      this.endTime = Date.now();
    });
    let progressHistory: { size: number; time: number }[] = [];
    command.emitter.on("progress", (event: any) => {
      if (event.event === "download") {
        const progress = event.progress.progress * 100;
        this.progress = progress;
        const nowSize = event.progress.loaded;
        const nowTime = Date.now();

        progressHistory.push({ size: nowSize, time: nowTime });
        if (progressHistory.length > 4) {
          progressHistory.shift();
        }

        if (progressHistory.length > 1) {
          const first = progressHistory[0];
          const last = progressHistory[progressHistory.length - 1];
          const sizeDistance = last.size - first.size;
          const timeDistance = (last.time - first.time) / 1000;

          if (timeDistance > 0) {
            this.custsomProgressMsg = `速度: ${(sizeDistance / 1024 / 1024 / timeDistance).toFixed(2)}MB/s`;
          }
        }

        callback.onProgress && callback.onProgress(progress);
        this.emitter.emit("task-progress", { taskId: this.taskId });
      }
    });
  }
  exec() {
    if (this.status !== "pending") return;
    this.status = "running";
    this.command.start();
    this.startTime = Date.now();
    this.emitter.emit("task-start", { taskId: this.taskId });
  }
  pause() {
    if (this.status !== "running") return;
    this.command.pause();
    log.warn(`task ${this.taskId} paused`);
    this.status = "paused";
    this.emitter.emit("task-pause", { taskId: this.taskId });
    return true;
  }
  resume() {
    if (this.status !== "paused") return;
    this.command.start();
    log.warn(`task ${this.taskId} resumed`);
    this.status = "running";
    this.emitter.emit("task-resume", { taskId: this.taskId });
    return true;
  }
  kill() {
    if (this.status === "completed" || this.status === "error" || this.status === "canceled")
      return;
    log.warn(`task ${this.taskId} killed`);
    this.endTime = Date.now();
    this.status = "canceled";
    this.command.cancel();
    this.emit("task-cancel", { taskId: this.taskId, autoStart: true });
    return true;
  }
}

/**
 * 斗鱼录播下载任务
 */
export class DouyuDownloadVideoTask extends AbstractTask {
  command: M3U8Downloader;
  type = TaskType.douyuDownload;
  emitter = new EventEmitter() as TypedEmitter<TaskEvents>;
  constructor(
    command: M3U8Downloader,
    options: {
      name: string;
    },
    callback: {
      onStart?: () => void;
      onEnd?: (output: string) => void;
      onError?: (err: string) => void;
      onProgress?: (progress: number) => any;
    },
  ) {
    super();
    this.command = command;
    this.progress = 0;
    this.action = ["kill", "pause"];

    if (options.name) {
      this.name = options.name;
    }

    // command.emitter.on("start", (commandLine: string) => {
    //   this.progress = 0;
    //   log.info(`task ${this.taskId} start, command: ${commandLine}`);
    //   this.status = "running";

    //   callback.onStart && callback.onStart();
    //   emitter.emit("task-start", { taskId: this.taskId });
    //   this.startTime = Date.now();
    // });

    command.on("completed", async () => {
      const output = this.command.output;
      log.info(`task ${this.taskId} end`);
      this.status = "completed";
      this.progress = 100;
      this.output = output;
      callback.onEnd && callback.onEnd(output);
      this.emitter.emit("task-end", { taskId: this.taskId });
      this.endTime = Date.now();
    });
    command.on("error", (err) => {
      log.error(`task ${this.taskId} error: ${err}`);
      this.status = "error";

      callback.onError && callback.onError(err);
      this.error = err;
      this.emitter.emit("task-error", { taskId: this.taskId, error: err });
      this.endTime = Date.now();
    });
    command.on("progress", (progress: { downloaded: number; total: number }) => {
      const percent = Math.floor((progress.downloaded / progress.total) * 100);
      callback.onProgress && callback.onProgress(percent);
      this.progress = percent;
      this.emitter.emit("task-progress", { taskId: this.taskId });
    });
  }
  exec() {
    if (this.status !== "pending") return;
    this.status = "running";
    this.command.download();
    this.startTime = Date.now();
    this.emitter.emit("task-start", { taskId: this.taskId });
  }
  pause() {
    if (this.status !== "running") return;
    this.command.pause();
    log.warn(`task ${this.taskId} paused`);
    this.status = "paused";
    this.emitter.emit("task-pause", { taskId: this.taskId });
    return true;
  }
  resume() {
    if (this.status !== "paused") return;
    this.command.resume();
    log.warn(`task ${this.taskId} resumed`);
    this.status = "running";
    this.emitter.emit("task-resume", { taskId: this.taskId });
    return true;
  }
  kill() {
    if (this.status === "completed" || this.status === "error" || this.status === "canceled")
      return;
    log.warn(`task ${this.taskId} killed`);
    this.status = "canceled";
    this.command.cancel();
    this.emit("task-cancel", { taskId: this.taskId, autoStart: true });
    return true;
  }
}

const isBetweenTimeRange = (range: [] | [string, string]) => {
  if (!range) return true;
  if (range.length !== 2) return true;

  try {
    const status = isBetweenTime(new Date(), range);
    return status;
  } catch (error) {
    return true;
  }
};
export class TaskQueue {
  appConfig: AppConfig;
  queue: AbstractTask[];
  emitter = new TypedEmitter<TaskEvents>();
  on: TypedEmitter<TaskEvents>["on"];
  off: TypedEmitter<TaskEvents>["off"];

  constructor(appConfig: AppConfig) {
    this.queue = [];
    this.appConfig = appConfig;
    this.on = this.emitter.on.bind(this.emitter);
    this.off = this.emitter.off.bind(this.emitter);
    this.on("task-end", () => {
      this.addTaskForLimit();
    });
    this.on("task-error", () => {
      this.addTaskForLimit();
    });
    this.on("task-pause", () => {
      this.addTaskForLimit();
    });
    this.on("task-cancel", ({ autoStart }) => {
      if (autoStart) this.addTaskForLimit();
    });

    setInterval(() => {
      this.addTaskForLimit();
    }, 1000 * 60);
  }
  runTask(task: AbstractTask) {
    const typeMap = {
      [TaskType.ffmpeg]: "ffmpegMaxNum",
      [TaskType.douyuDownload]: "douyuDownloadMaxNum",
      [TaskType.biliUpload]: "biliUploadMaxNum",
      [TaskType.biliDownload]: "biliDownloadMaxNum",
    };
    const config = this.appConfig.getAll();
    const maxNum = config?.task?.[typeMap[task.type]] ?? 0;
    if (maxNum >= 0) {
      this.filter({ type: task.type, status: "running" }).length < maxNum &&
        isBetweenTimeRange(task.limitTime) &&
        task.exec();
    } else {
      isBetweenTimeRange(task.limitTime) && task.exec();
    }
  }
  addTask(task: AbstractTask, autoRun = true) {
    task.emitter.on("task-end", ({ taskId }) => {
      this.emitter.emit("task-end", { taskId });
    });
    task.emitter.on("task-error", ({ taskId, error }) => {
      this.emitter.emit("task-error", { taskId, error });
    });
    task.emitter.on("task-progress", ({ taskId }) => {
      this.emitter.emit("task-progress", { taskId });
    });
    task.emitter.on("task-start", ({ taskId }) => {
      this.emitter.emit("task-start", { taskId });
    });
    task.emitter.on("task-pause", ({ taskId }) => {
      this.emitter.emit("task-pause", { taskId });
    });
    task.emitter.on("task-resume", ({ taskId }) => {
      this.emitter.emit("task-resume", { taskId });
    });
    task.emitter.on("task-cancel", ({ taskId, autoStart }) => {
      this.emitter.emit("task-cancel", { taskId, autoStart });
    });

    this.queue.push(task);

    if (autoRun) {
      task.exec();
    } else {
      this.runTask(task);
    }
  }
  queryTask(taskId: string) {
    const task = this.queue.find((task) => task.taskId === taskId);
    return task;
  }
  stringify(item: AbstractTask[]) {
    return item.map((task) => {
      return {
        pid: task.pid,
        taskId: task.taskId,
        status: task.status,
        name: task.name,
        type: task.type,
        relTaskId: task.relTaskId,
        output: task.output,
        progress: task.progress,
        action: task.action,
        startTime: task.startTime,
        endTime: task.endTime,
        custsomProgressMsg: task.custsomProgressMsg,
        error: task.error ? String(task.error) : "",
        duration: task.getDuration(),
      };
    });
  }
  filter(options: { type?: string; status?: Status }) {
    return this.queue.filter((task) => {
      if (options.type && task.type !== options.type) return false;
      if (options.status && task.status !== options.status) return false;
      return true;
    });
  }
  list() {
    return this.queue;
  }
  start(taskId: string) {
    const task = this.queryTask(taskId);
    if (!task) return;
    if (task.status !== "pending") return;
    task.exec();
  }
  remove(taskId: string) {
    const task = this.queryTask(taskId);
    if (!task) return;
    const index = this.queue.indexOf(task);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }
    task.emit("task-removed-queue", { taskId: task.taskId });
  }
  pasue(taskId: string) {
    const task = this.queryTask(taskId);
    if (!task) return;
    task.pause();
    task.pauseStartTime = Date.now();
  }
  resume(taskId: string) {
    const task = this.queryTask(taskId);
    if (!task) return;
    task.resume();
    // if (task.pauseStartTime !== null) {
    //   task.totalPausedDuration += Date.now() - task.pauseStartTime;
    //   task.pauseStartTime = null;
    // }
  }
  cancel(taskId: string) {
    const task = this.queryTask(taskId);
    if (!task) return;
    task.kill();
  }
  interrupt(taskId: string) {
    const task = this.queryTask(taskId);
    if (!task) return;
    if (task.action.includes("interrupt")) {
      // @ts-ignore
      return task.interrupt();
    }
    return;
  }

  private taskLimit(maxNum: number, type: string) {
    const pendingFFmpegTask = this.filter({ type: type, status: "pending" }).filter((task) => {
      return isBetweenTimeRange(task.limitTime);
    });
    if (maxNum !== -1) {
      const runningTaskCount = this.filter({
        type: type,
        status: "running",
      }).length;

      if (runningTaskCount < maxNum) {
        pendingFFmpegTask.slice(0, maxNum - runningTaskCount).forEach((task) => {
          task.exec();
        });
      }
    } else {
      // TODO: 补充单元测试
      pendingFFmpegTask.forEach((task) => {
        task.exec();
      });
    }
  }
  private addTaskForLimit = () => {
    const config = this.appConfig.getAll();

    // ffmpeg任务
    this.taskLimit(config?.task?.ffmpegMaxNum ?? -1, TaskType.ffmpeg);
    // 斗鱼录播下载任务
    this.taskLimit(config?.task?.douyuDownloadMaxNum ?? -1, TaskType.douyuDownload);
    // B站上传任务
    this.taskLimit(config?.task?.biliUploadMaxNum ?? -1, TaskType.biliUpload);
    // B站下载任务
    this.taskLimit(config?.task?.biliDownloadMaxNum ?? -1, TaskType.biliDownload);
  };
}

export const sendTaskNotify = (event: NotificationTaskStatus, taskId: string) => {
  const task = taskQueue.queryTask(taskId);
  if (!task) return;
  const taskType = task.type;
  let title = "";
  let desp = "";
  switch (event) {
    case "success":
      title = `成功：${task.name}`;
      desp = `${task.name}结束\n\n开始时间：${new Date(task.startTime!).toLocaleString()}\n\n输出：${task.output}`;
      break;
    case "failure":
      title = `错误：${task.name}`;
      desp = `${task.name}出错\n\n开始时间：${new Date(task.startTime!).toLocaleString()}\n\n错误信息：${task.error}`;
      break;
  }
  const config = appConfig.getAll();
  const taskConfig = config?.notification?.task;
  switch (taskType) {
    case TaskType.ffmpeg:
      if (taskConfig.ffmpeg.includes(event)) {
        sendNotify(title, desp);
      }
      break;
    case TaskType.danmu:
      if (taskConfig.danmu.includes(event)) {
        sendNotify(title, desp);
      }
      break;
    case TaskType.bili:
      if (taskConfig.upload.includes(event)) {
        sendNotify(title, desp);
      }
      break;
    case TaskType.biliDownload:
      if (taskConfig.download.includes(event)) {
        sendNotify(title, desp);
      }
      break;
    case TaskType.douyuDownload:
      if (taskConfig.download.includes(event)) {
        sendNotify(title, desp);
      }
      break;
  }
};

export const taskQueue = new TaskQueue(appConfig);

taskQueue.on("task-end", ({ taskId }) => {
  sendTaskNotify("success", taskId);
});
taskQueue.on("task-error", ({ taskId }) => {
  sendTaskNotify("failure", taskId);
});

export const handlePauseTask = (taskId: string) => {
  const task = taskQueue.pasue(taskId);
  return task;
};
export const handleResumeTask = (taskId: string) => {
  const task = taskQueue.resume(taskId);
  return task;
};
export const handleKillTask = (taskId: string) => {
  const task = taskQueue.cancel(taskId);
  return task;
};
export const hanldeInterruptTask = (taskId: string) => {
  return taskQueue.interrupt(taskId);
};

export const handleListTask = () => {
  return taskQueue.stringify(taskQueue.list());
};
export const handleQueryTask = (taskId: string) => {
  const task = taskQueue.queryTask(taskId);
  if (task) {
    return taskQueue.stringify([task])[0];
  } else {
    return null;
  }
};
export const handleStartTask = (taskId: string) => {
  return taskQueue.start(taskId);
};
export const handleRemoveTask = (taskId: string) => {
  return taskQueue.remove(taskId);
};
