<template>
  <n-modal v-model:show="showModal" transform-origin="center" :auto-focus="false">
    <n-card style="width: 800px" title="更新日志" :bordered="false">
      <div>
        <p>
          <b
            >如果你不知道如何使用本软件，请优先查看<a
              href="https://www.bilibili.com/video/BV1Hs421M755/"
              class="external"
              target="_blank"
              >帮助教程</a
            >，你也可以在关于页面找到链接</b
          >
        </p>
        <p>如果你觉得本软件对你有帮助：</p>
        <p>
          请我喝瓶快乐水：<a href="https://afdian.com/a/renmu123" class="external" target="_blank"
            >https://afdian.com/a/renmu123</a
          >
        </p>
        <p>
          如果你是大会员，也可以用免费的B币给我充电：<a
            href="https://space.bilibili.com/10995238"
            class="external"
            target="_blank"
            >https://space.bilibili.com/10995238</a
          >
        </p>
        <p>
          弹幕转换功能底层来自：<a
            href="https://github.com/hihkm/DanmakuFactory"
            class="external"
            target="_blank"
            >DanmakuFactory</a
          >
        </p>
        <p>
          直播录制绝大部分代码来自：<a
            href="https://github.com/WhiteMinds/LiveAutoRecord"
            class="external"
            target="_blank"
            >LiveAutoRecord</a
          >
        </p>
      </div>
      <div v-html="content"></div>
      <template #footer>
        <div style="text-align: right">
          <n-button type="primary" style="margin-left: 10px" @click="close"
            >我知道了(〃∀〃)</n-button
          >
        </div>
      </template>
    </n-card>
  </n-modal>
</template>

<script setup lang="ts">
import { marked } from "marked";
import changelog from "../../../../../../CHANGELOG.md?raw";
import { commonApi } from "@renderer/apis";

const showModal = defineModel<boolean>("visible", { required: true, default: false });

const renderer = {
  link({ href, text }: { href: string; text: string }) {
    return `<a href="${href}" target="_blank">${text}</a>`;
  },
};

marked.use({ renderer });
const content = marked.parse(changelog);

const confirm = async () => {
  const data = JSON.parse(localStorage.getItem("changelog") || "{}");
  const version = await commonApi.version();
  data[version] = true;
  localStorage.setItem("changelog", JSON.stringify(data));
};

const close = async () => {
  await confirm();
  showModal.value = false;
};

watch(
  () => showModal.value,
  (value) => {
    if (!value) {
      confirm();
    }
  },
);
</script>

<style scoped lang="less"></style>
