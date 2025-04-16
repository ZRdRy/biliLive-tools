import EventEmitter from "node:events";

import fs from "fs-extra";
import { createRecordExtraDataController } from "./record_extra_data_controller.js";
import { replaceExtName, ensureFolderExist, isFfmpegStartSegment, isFfmpegStart } from "./utils.js";

export type GetSavePath = (data: { startTime: number }) => string;

export class Segment extends EventEmitter {
  extraDataController: ReturnType<typeof createRecordExtraDataController> | null = null;
  init = true;
  getSavePath: GetSavePath;
  /** 原始的ffmpeg文件名，用于重命名 */
  rawRecordingVideoPath!: string;
  /** 输出文件名名，不包含拓展名 */
  outputVideoFilePath!: string;
  disableDanma: boolean;
  videoExt: "ts" | "mkv" | "mp4";

  constructor(getSavePath: GetSavePath, disableDanma: boolean, videoExt: "ts" | "mkv" | "mp4") {
    super();
    this.getSavePath = getSavePath;
    this.disableDanma = disableDanma;
    this.videoExt = videoExt;
  }

  async handleSegmentEnd() {
    if (!this.outputVideoFilePath) {
      this.emit("DebugLog", {
        type: "common",
        text: "Should call onSegmentStart first",
      });
      return;
    }

    try {
      await Promise.all([
        fs.rename(this.rawRecordingVideoPath, this.outputFilePath),
        this.extraDataController?.flush(),
      ]);
      this.emit("videoFileCompleted", { filename: this.outputFilePath });
    } catch (err) {
      this.emit("DebugLog", {
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
    const startTime = Date.now();

    this.outputVideoFilePath = this.getSavePath({
      startTime: startTime,
    });

    ensureFolderExist(this.outputVideoFilePath);

    if (!this.disableDanma) {
      this.extraDataController = createRecordExtraDataController(
        `${this.outputVideoFilePath}.json`,
      );
    }

    const regex = /'([^']+)'/;
    const match = stderrLine.match(regex);
    if (match) {
      const filename = match[1];
      this.rawRecordingVideoPath = filename;
      this.emit("videoFileCreated", { filename: this.outputFilePath });
    } else {
      this.emit("DebugLog", { type: "ffmpeg", text: "No match found" });
    }
  }

  get outputFilePath() {
    return `${this.outputVideoFilePath}.${this.videoExt}`;
  }
}

export class StreamManager extends EventEmitter {
  private segment: Segment | null = null;
  private extraDataController: ReturnType<typeof createRecordExtraDataController> | null = null;
  recordSavePath: string;
  recordStartTime?: number;
  hasSegment: boolean;
  private videoFormat?: "auto" | "ts" | "mkv";

  constructor(
    getSavePath: GetSavePath,
    hasSegment: boolean,
    disableDanma: boolean,
    videoFormat?: "auto" | "ts" | "mkv",
  ) {
    super();
    const recordSavePath = getSavePath({ startTime: Date.now() });
    this.recordSavePath = recordSavePath;
    this.videoFormat = videoFormat;
    this.hasSegment = hasSegment;

    if (hasSegment) {
      this.segment = new Segment(getSavePath, disableDanma, this.videoExt);
      this.segment.on("DebugLog", (data) => {
        this.emit("DebugLog", data);
      });
      this.segment.on("videoFileCreated", (data) => {
        this.emit("videoFileCreated", data);
      });
      this.segment.on("videoFileCompleted", (data) => {
        this.emit("videoFileCompleted", data);
      });
    } else {
      const extraDataSavePath = replaceExtName(recordSavePath, ".json");
      if (!disableDanma) {
        this.extraDataController = createRecordExtraDataController(extraDataSavePath);
      }
    }
  }

  async handleVideoStarted(stderrLine: string) {
    if (this.segment) {
      if (isFfmpegStartSegment(stderrLine)) {
        await this.segment.onSegmentStart(stderrLine);
      }
    } else {
      // 不能直接在onStart回调进行判断，在某些情况下会链接无法录制的情况
      if (isFfmpegStart(stderrLine)) {
        if (this.recordStartTime) return;
        this.recordStartTime = Date.now();
        this.emit("videoFileCreated", { filename: this.videoFilePath });
      }
    }
  }

  async handleVideoCompleted() {
    if (this.segment) {
      await this.segment.handleSegmentEnd();
    } else {
      if (this.recordStartTime) {
        await this.getExtraDataController()?.flush();
        this.emit("videoFileCompleted", { filename: this.videoFilePath });
      }
    }
  }

  getExtraDataController() {
    return this.segment?.extraDataController || this.extraDataController;
  }

  get videoExt() {
    if (this.videoFormat === "mkv") {
      return "mkv";
    } else if (this.videoFormat === "auto") {
      if (!this.hasSegment) {
        return "mp4";
      }
    }
    return "ts";
  }

  get videoFilePath() {
    return this.segment
      ? `${this.recordSavePath}-PART%03d.${this.videoExt}`
      : `${this.recordSavePath}.${this.videoExt}`;
  }
}
