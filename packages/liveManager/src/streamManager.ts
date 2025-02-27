import fs from "fs-extra";
import { createRecordExtraDataController } from "./record_extra_data_controller.js";
import { replaceExtName, ensureFolderExist } from "./utils.js";

import type { Recorder, GetSavePath } from "./recorder.js";

export class Segment {
  extraDataController: ReturnType<typeof createRecordExtraDataController> | null = null;
  init = true;
  getSavePath: GetSavePath;
  owner: string;
  title: string;
  recorder: Recorder;
  /** 原始的ffmpeg文件名，用于重命名 */
  rawRecordingVideoPath!: string;
  /** 输出文件名名，不包含拓展名 */
  outputVideoFilePath!: string;

  constructor(recorder: Recorder, getSavePath: GetSavePath, owner: string, title: string) {
    this.getSavePath = getSavePath;
    this.owner = owner;
    this.title = title;
    this.recorder = recorder;
  }

  async handleSegmentEnd() {
    if (!this.outputVideoFilePath) {
      this.recorder.emit("DebugLog", {
        type: "common",
        text: "Should call onSegmentStart first",
      });
      return;
    }
    this.extraDataController?.setMeta({ recordStopTimestamp: Date.now() });

    try {
      await Promise.all([
        fs.rename(this.rawRecordingVideoPath, `${this.outputVideoFilePath}.ts`),
        this.extraDataController?.flush(),
      ]);
      this.recorder.emit("videoFileCompleted", { filename: `${this.outputVideoFilePath}.ts` });
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
    const startTime = Date.now();

    this.outputVideoFilePath = this.getSavePath({
      owner: this.owner,
      title: this.title,
      startTime: startTime,
    });

    ensureFolderExist(this.outputVideoFilePath);

    this.extraDataController = createRecordExtraDataController(`${this.outputVideoFilePath}.json`);
    this.extraDataController.setMeta({ title: this.title, user_name: this.owner });

    const regex = /'([^']+)'/;
    const match = stderrLine.match(regex);
    if (match) {
      const filename = match[1];
      this.rawRecordingVideoPath = filename;
      this.recorder.emit("videoFileCreated", { filename: `${this.outputVideoFilePath}.ts` });
    } else {
      this.recorder.emit("DebugLog", { type: "ffmpeg", text: "No match found" });
    }
  }
}

export class StreamManager {
  private segmentManager: Segment | null = null;
  private extraDataController: ReturnType<typeof createRecordExtraDataController> | null = null;
  recorder: Recorder;
  owner: string;
  title: string;
  recordSavePath: string;

  constructor(
    recorder: Recorder,
    getSavePath: GetSavePath,
    owner: string,
    title: string,
    recordSavePath: string,
    hasSegment: boolean,
  ) {
    this.recordSavePath = recordSavePath;
    this.recorder = recorder;
    this.owner = owner;
    this.title = title;

    if (hasSegment) {
      this.segmentManager = new Segment(recorder, getSavePath, owner, title);
    } else {
      const extraDataSavePath = replaceExtName(recordSavePath, ".json");
      this.extraDataController = createRecordExtraDataController(extraDataSavePath);
      this.extraDataController.setMeta({ title, user_name: owner });
      // TODO: 增加platform参数，直播开始时间
    }
  }

  async handleVideoStarted(stderrLine?: string) {
    if (this.segmentManager) {
      if (stderrLine) {
        await this.segmentManager.onSegmentStart(stderrLine);
      }
    } else {
      this.recorder.emit("videoFileCreated", { filename: this.videoFilePath });
    }
  }

  async handleVideoCompleted() {
    if (this.segmentManager) {
      await this.segmentManager.handleSegmentEnd();
    } else {
      this.getExtraDataController()?.setMeta({ recordStopTimestamp: Date.now() });
      await this.getExtraDataController()?.flush();
      this.recorder.emit("videoFileCompleted", { filename: this.videoFilePath });
    }
  }

  getExtraDataController() {
    return this.segmentManager?.extraDataController || this.extraDataController;
  }

  get videoFilePath() {
    return this.segmentManager ? `${this.recordSavePath}-PART%03d.ts` : `${this.recordSavePath}.ts`;
  }
}
