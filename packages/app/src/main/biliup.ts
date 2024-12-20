import { biliApi } from "@biliLive-tools/shared/task/bili.js";

import type { IpcMainInvokeEvent } from "electron";
import type { BiliupConfig, BiliupConfigAppend } from "@biliLive-tools/types";

export const handlers = {
  "bili:uploadVideo": async (
    _event: IpcMainInvokeEvent,
    uid: number,
    pathArray: string[],
    options: BiliupConfig,
  ) => {
    const task = await biliApi.addMedia(pathArray, options, uid);
    return {
      taskId: task.taskId,
    };
  },
  "bili:appendVideo": async (
    _event: IpcMainInvokeEvent,
    uid: number,
    pathArray: string[],
    options: BiliupConfigAppend,
  ) => {
    const task = await biliApi.editMedia(options.vid as number, pathArray, options, uid);
    return {
      taskId: task.taskId,
    };
  },
};
