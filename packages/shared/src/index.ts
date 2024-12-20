export * from "./presets/index.js";

import { createContainer, asValue, asClass } from "awilix";

import { taskQueue, TaskQueue } from "./task/task.js";
import { appConfig, AppConfig } from "./config.js";
import { DanmuPreset, VideoPreset, FFmpegPreset } from "./presets/index.js";
import { setFfmpegPath } from "./task/video.js";
import { initLogger } from "./utils/log.js";
import { BiliCommentQueue, migrateBiliUser } from "./task/bili.js";
import { createRecorderManager } from "./recorder/index.js";

import type { GlobalConfig } from "@biliLive-tools/types";

// import { initDB } from "./db/index.js";
const container = createContainer();

const init = async (config: GlobalConfig) => {
  appConfig.init(config.configPath, {
    ffmpegPath: config.defaultFfmpegPath,
    ffprobePath: config.defaultFfprobePath,
    danmuFactoryPath: config.defaultDanmakuFactoryPath,
  });
  const logLevel = appConfig.get("logLevel");
  initLogger(config.logPath, logLevel);
  // initDB("danmu.db");

  container.register({
    appConfig: asValue(appConfig),
    logger: asValue(console),
    globalConfig: asValue(config),
    taskQueue: asValue(taskQueue),
    commentQueue: asClass(BiliCommentQueue).singleton(),
    danmuPreset: asClass(DanmuPreset).singleton(),
    videoPreset: asClass(VideoPreset).singleton(),
    ffmpegPreset: asClass(FFmpegPreset).singleton(),
  });
  const recorderManager = await createRecorderManager(appConfig);
  container.register({
    recorderManager: asValue(recorderManager),
  });

  await migrate();
  setFfmpegPath();
  const commentQueue = container.resolve<BiliCommentQueue>("commentQueue");
  commentQueue.checkLoop();

  // appConfig.on("update", () => {
  //   const appconfig = container.resolve<AppConfig>("appConfig");
  //   const config = appconfig.getAll();
  // });

  return container;
};

// 迁移数据
const migrate = async () => {
  await migrateBiliUser();
};

export { init, AppConfig, appConfig, TaskQueue, migrate, createRecorderManager, container };
