import Koa from "koa";
import Router from "koa-router";
import cors from "@koa/cors";
import bodyParser from "koa-bodyparser";
import Config from "@biliLive-tools/shared/utils/globalConfig.js";
import { AppConfig } from "@biliLive-tools/shared";

import errorMiddleware from "./middleware/error.js";

import webhookRouter from "./routes/webhook.js";
import configRouter from "./routes/config.js";
import llmRouter from "./routes/llm.js";
import { WebhookHandler } from "./services/webhook.js";

export let config: Config = new Config();
export let handler!: WebhookHandler;
export let appConfig!: AppConfig;

const app = new Koa();
const router = new Router();

router.get("/", async (ctx) => {
  ctx.body = "Hello World11";
});

app.use(errorMiddleware);
app.use(cors());
app.use(bodyParser());
app.use(router.routes());
app.use(webhookRouter.routes());
app.use(configRouter.routes());
app.use(llmRouter.routes());

export function serverStart(
  options: {
    port: number;
    host: string;
  },
  iConfig?: Config,
) {
  if (iConfig) config = iConfig;
  appConfig = new AppConfig(config.get("configPath"));
  handler = new WebhookHandler(appConfig);

  app.listen(options.port, options.host, () => {
    console.log(`Server is running at http://${options.host}:${options.port}`);
  });
  return app;
}

// serverStart();
