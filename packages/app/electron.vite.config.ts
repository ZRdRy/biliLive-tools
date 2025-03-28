import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { NaiveUiResolver } from "unplugin-vue-components/resolvers";

import { version } from "./package.json";

process.env.VITE_VERSION = version;

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@biliLive-tools/shared", "@biliLive-tools/http"],
      }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    server: {
      port: 28080,
    },
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@types": resolve("src/types"),
      },
    },
    plugins: [
      vue({
        script: {
          defineModel: true,
        },
      }),
      AutoImport({
        imports: [
          "vue",
          {
            "naive-ui": ["useDialog", "useMessage", "useNotification", "useLoadingBar"],
          },
          "pinia",
          {
            "@renderer/hooks/useNotice": ["useNotice"],
          },
        ],
      }),
      Components({
        resolvers: [NaiveUiResolver()],
      }),
    ],
  },
});
