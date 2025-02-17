<template>
  <n-form ref="formRef" label-width="130px" label-placement="left" label-align="right">
    <n-form-item label="预设">
      <n-cascader
        v-model:value="presetId"
        placeholder="请选择预设"
        expand-trigger="click"
        :options="options"
        check-strategy="child"
        :show-path="false"
        :filterable="true"
      />
    </n-form-item>
    <n-divider />

    <n-form-item>
      <template #label>
        <n-popover trigger="hover">
          <template #trigger>
            <span
              class="flex align-center"
              :style="{
                'justify-content': 'flex-end',
              }"
            >
              视频编码器 <n-icon size="18" class="pointer"> <HelpCircleOutline /> </n-icon
            ></span>
          </template>
          <p style="color: red">请勿选择不支持的硬件加速方案，如果报错请尝试更新驱动</p>
          <p>如果想更换编码器，最好从预设中修改，不同的编码器会有一些不同的默认参数</p>
          <p>lib 使用 CPU 进行编码，无硬件加速，速度较慢，但效果可能是最好的</p>
          <p>QSV 是 Intel 的核显加速</p>
          <p>NVEnc 是 NVIDIA 的显卡加速</p>
          <p>AMF 是 AMD 的硬件加速</p>
          <p>H264泛用性较高，压缩率较低；H265 压缩率高于H264但可能低于AV1</p>
          <p>AV1 新一代的编码宠儿，需要新一代硬件才可硬件加速，如40系显卡</p>
          <p>copy为复制原始流，不做任何更改，<b>如果你需要压制弹幕请不要使用这个参数</b></p>
        </n-popover>
      </template>
      <n-select
        v-model:value="ffmpegOptions.config.encoder"
        :options="videoEncoders"
        :on-update:value="handleVideoEncoderChange"
      />
    </n-form-item>

    <template v-if="ffmpegOptions.config.encoder !== 'copy'">
      <n-form-item v-if="(encoderOptions?.birateControls || []).length !== 0" label="码率控制">
        <n-select
          v-model:value="ffmpegOptions.config.bitrateControl"
          :options="encoderOptions?.birateControls || []"
        />
      </n-form-item>
      <n-form-item
        v-if="
          ffmpegOptions.config.bitrateControl === 'CRF' ||
          ffmpegOptions.config.bitrateControl === 'CQ' ||
          ffmpegOptions.config.bitrateControl === 'ICQ'
        "
      >
        <template #label>
          <span
            class="flex align-center"
            :style="{
              'justify-content': 'flex-end',
            }"
          >
            <span v-if="ffmpegOptions.config.bitrateControl === 'CQ'">cq</span>
            <span v-else-if="ffmpegOptions.config.bitrateControl === 'ICQ'">ICQ</span>
            <span v-else>crf</span>

            <Tip v-if="['libx264', 'libx265'].includes(ffmpegOptions.config.encoder)">
              <p>CRF值为0：无损压缩，最高质量，最大文件大小。</p>
              <p>
                CRF值较低（例如，18-24）：高质量，较大文件大小。适用于需要高质量输出的情况，18为视觉无损。
              </p>
              <p>CRF值较高（例如，28-51）：较低质量，较小文件大小。适用于需要较小文件的情况。</p>
              <p>CRF值越小，压制越慢</p>
            </Tip>
            <Tip
              v-else-if="
                ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc'].includes(ffmpegOptions.config.encoder)
              "
            >
              <p>值为0：自动</p>
              <p>值为1-51：越小质量越高，越大质量越低</p>
            </Tip>
            <Tip
              v-else-if="['h264_qsv', 'hevc_qsv', 'av1_qsv'].includes(ffmpegOptions.config.encoder)"
            >
              <p>类似x264中的crf值，值为1-51：越小质量越高，越大质量越低</p>
            </Tip>
          </span>
        </template>
        <n-input-number
          v-model:value.number="ffmpegOptions.config.crf"
          class="input-number"
          :min="crfMinMax[0]"
          :max="crfMinMax[1]"
        />
      </n-form-item>
      <n-form-item v-else-if="ffmpegOptions.config.bitrateControl === 'VBR'">
        <template #label>
          <span class="inline-flex">
            <span>码率</span>
            <Tip>
              如果你完全不懂参数代表什么，又觉得画质差，请拉高此参数。<br />
              一般杂谈录播视频，码率 5000k 够了。如果是游戏，可以拉到
              10000k及以上，如果弹幕较多，可以尝试拉到更高，具体码率可自行测试。
            </Tip>
          </span>
        </template>
        <n-input-number
          v-model:value.number="ffmpegOptions.config.bitrate"
          class="input-number"
          :step="500"
          placeholder="请输入码率"
        >
          <template #suffix> K </template></n-input-number
        >
      </n-form-item>

      <n-form-item v-if="(encoderOptions?.presets || []).length !== 0">
        <template #label>
          <span class="inline-flex">
            <span>预设</span>
            <Tip> 推荐使用medium或者fast，不推荐任何人使用slowest </Tip>
          </span>
        </template>
        <n-select
          v-model:value="ffmpegOptions.config.preset"
          :options="encoderOptions?.presets || []"
          placeholder="请选择预设"
        />
      </n-form-item>
      <n-form-item
        v-if="
          ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'h264_amf', 'hevc_amf', 'av1_amf'].includes(
            ffmpegOptions.config.encoder,
          )
        "
      >
        <template #label>
          <span class="inline-flex">
            <span>硬件解码</span>
            <Tip>
              使用硬件解码器，开启后<b>可能</b>会减少压制时间，nvidia会使用nvdec，如果压制失败请关闭
            </Tip>
          </span>
        </template>
        <n-checkbox v-model:checked="ffmpegOptions.config.decode"></n-checkbox>
      </n-form-item>
      <n-form-item v-if="['libsvtav1'].includes(ffmpegOptions.config.encoder)">
        <template #label>
          <span class="inline-flex">
            <span>10bit</span>
            <Tip> AV1 10bit 会占用更多的硬件资源，但画质会更好，如果硬件支持，建议开启 </Tip>
          </span>
        </template>
        <n-checkbox v-model:checked="ffmpegOptions.config.bit10"></n-checkbox>
      </n-form-item>

      <n-form-item>
        <template #label>
          <span class="inline-flex">
            <span>分辨率</span>
            <Tip>
              <p>
                实质上不会提升画质，但由于B站4K可拥有更高码率，可以通过缩放分辨率来减少二压对码率的影响，会影响压制时间。
              </p>
              <p>
                B站4k画质要求短边大于1600，如果原视频为1080，可以尝试设置为2880x1620<br />
                也可以设置为-1:1620来进行自适应
              </p>
              <p>4K：3840X2160<br />2K：2560X1440<br />1080：1920X1080</p>
              <p>
                如果需要放大分辨率，可以选择先渲染后缩放，如果是缩小分辨率，可以选择先缩放后渲染，自动策略为先渲染后缩放
              </p>
            </Tip>
          </span>
        </template>

        <n-checkbox
          v-model:checked="ffmpegOptions.config.resetResolution"
          style="margin-right: 20px"
        ></n-checkbox>
        <template v-if="ffmpegOptions.config.resetResolution">
          <n-input-number
            v-model:value.number="ffmpegOptions.config.resolutionWidth"
            class="input-number"
            :min="-1"
            :step="100"
            title="宽"
            placeholder="宽"
            style="width: 100px"
          />&nbsp;X&nbsp;
          <n-input-number
            v-model:value.number="ffmpegOptions.config.resolutionHeight"
            class="input-number"
            :min="-1"
            :step="100"
            title="高"
            placeholder="高"
            style="width: 100px"
          />
          <n-select
            v-model:value="ffmpegOptions.config.swsFlags"
            :options="swsOptions"
            title="缩放算法"
            placeholder="请选择缩放算法，默认为自动"
            clearable
            style="width: 200px; flex: none; margin-left: 10px"
          />
          <n-select
            v-model:value="ffmpegOptions.config.scaleMethod"
            :options="scaleMethodOptions"
            title="缩放顺序"
            placeholder="请选择缩放顺序"
            clearable
            style="width: 200px; flex: none; margin-left: 10px"
          />
        </template>
      </n-form-item>
      <n-form-item>
        <template #label>
          <span class="inline-flex">
            <span>时间戳</span>
            <Tip>
              添加时间戳到视频中，优先从webhook中读取、其次是弹幕元数据（支持录播姬、blrec、本软件下载的录播）、最后是视频元数据（如录播姬注释）。<br />
              即使你开启此选项，如果一条都未被匹配到，也是不会被渲染的<br />
            </Tip>
          </span>
        </template>

        <n-checkbox
          v-model:checked="ffmpegOptions.config.addTimestamp"
          style="margin-right: 20px"
        ></n-checkbox>
        <template v-if="ffmpegOptions.config.addTimestamp">
          <n-form
            inline
            label-placement="left"
            label-align="right"
            :show-feedback="false"
            label-width="40px"
          >
            <n-form-item label="x轴">
              <n-input-number
                v-model:value.number="ffmpegOptions.config.timestampX"
                class="input-number"
                :min="0"
                :step="10"
                title="x轴坐标"
                placeholder="x轴坐标"
                style="width: 120px"
              />
            </n-form-item>

            <n-form-item label="y轴">
              <n-input-number
                v-model:value.number="ffmpegOptions.config.timestampY"
                class="input-number"
                :min="0"
                :step="10"
                title="y轴坐标"
                placeholder="y轴坐标"
                style="width: 120px"
              />
            </n-form-item>
            <n-form-item label="字体大小">
              <n-input-number
                v-model:value.number="ffmpegOptions.config.timestampFontSize"
                class="input-number"
                :min="10"
                :step="1"
                title="字体大小"
                placeholder="字体大小"
                style="width: 120px"
              />
            </n-form-item>
            <n-form-item label="字体颜色">
              <n-color-picker
                v-model:value="ffmpegOptions.config.timestampFontColor"
                style="width: 120px"
                title="字体颜色"
              />
            </n-form-item>
            <n-form-item label="跟随弹幕字体" label-width="100px">
              <n-checkbox v-model:checked="ffmpegOptions.config.timestampFollowDanmu"></n-checkbox>
            </n-form-item>
          </n-form>
        </template>
      </n-form-item>
      <n-form-item v-if="ffmpegOptions.config.addTimestamp">
        <template #label>
          <span class="inline-flex">
            <span>时间戳参数</span>
            <Tip>
              内容格式占位符具体见
              <a target="_blank" href="https://strftime.org/">strftime</a>
              （<code>:</code> 需要额外转义）<br />
              自定义参数具体见
              <a target="_blank" href="https://ffmpeg.org/ffmpeg-filters.html#drawtext-1"
                >ffmpeg滤镜文档</a
              >，示例：<code>box=1:boxcolor=#ff0000</code>
            </Tip>
          </span>
        </template>
        <n-form
          inline
          label-placement="left"
          label-align="right"
          :show-feedback="false"
          label-width="80px"
          style="width: 100%"
        >
          <n-form-item label="内容格式">
            <n-input
              v-model:value="ffmpegOptions.config.timestampFormat"
              placeholder="请输入内容格式"
              :input-props="{ spellcheck: 'false' }"
            />
          </n-form-item>
          <n-form-item label="额外参数">
            <n-input
              v-model:value="ffmpegOptions.config.timestampExtra"
              placeholder="请输入额外参数"
              :input-props="{ spellcheck: 'false' }"
            />
          </n-form-item>
        </n-form>
      </n-form-item>
    </template>

    <n-form-item>
      <template #label>
        <n-popover trigger="hover">
          <template #trigger>
            <span
              class="flex align-center"
              :style="{
                'justify-content': 'flex-end',
              }"
            >
              音频编码器</span
            >
          </template>
        </n-popover>
      </template>
      <n-select v-model:value="ffmpegOptions.config.audioCodec" :options="audioEncoders" />
    </n-form-item>

    <n-form-item v-if="ffmpegOptions.config.encoder !== 'copy'">
      <template #label>
        <span class="inline-flex">
          <span>视频滤镜</span>
          <Tip>
            <code>$origin</code>
            是由其他配置生成的默认参数，如果没有该参数，谁也不知道会发生什么事<br />
            例：hflip;$origin;transpose=1 解释：先水平翻转，然后应用默认参数，最后旋转90度<br />
            如果使用了该自定义设置，那么分辨率参数可能不会如你所愿，请手动设置
          </Tip>
        </span>
      </template>
      <n-input
        v-model:value="ffmpegOptions.config.vf"
        type="textarea"
        placeholder="请输入滤镜参数"
        style="width: 100%"
        :input-props="{ spellcheck: 'false' }"
      />
    </n-form-item>

    <n-form-item>
      <template #label>
        <span class="inline-flex">
          <span>额外输出参数</span>
          <Tip> 参数将被附加到ffmpeg输出参数中，参数错误可能会导致无法运行 </Tip>
        </span>
      </template>
      <n-input
        v-model:value="ffmpegOptions.config.extraOptions"
        type="textarea"
        placeholder="请输入额外参数"
        style="width: 100%"
        :input-props="{ spellcheck: 'false' }"
      />
    </n-form-item>
    <div class="actions">
      <n-button
        v-if="!presetId.startsWith('b_') && presetId !== 'default'"
        ghost
        quaternary
        class="btn"
        type="error"
        @click="deletePreset"
        >删除</n-button
      >
      <n-button v-if="!presetId.startsWith('b_')" type="primary" class="btn" @click="rename"
        >重命名</n-button
      >
      <n-button type="primary" class="btn" @click="saveAs">另存为</n-button>
      <n-button v-if="!presetId.startsWith('b_')" type="primary" class="btn" @click="saveConfig"
        >保存</n-button
      >
    </div>

    <n-modal v-model:show="nameModelVisible">
      <n-card style="width: 600px" :bordered="false" role="dialog" aria-modal="true">
        <n-input
          v-model:value="tempPresetName"
          placeholder="请输入预设名称"
          maxlength="15"
          @keyup.enter="saveConfirm"
        />
        <template #footer>
          <div style="text-align: right">
            <n-button @click="nameModelVisible = false">取消</n-button>
            <n-button type="primary" style="margin-left: 10px" @click="saveConfirm">确认</n-button>
          </div>
        </template>
      </n-card>
    </n-modal>
  </n-form>
</template>

<script setup lang="ts">
import { HelpCircleOutline } from "@vicons/ionicons5";
import { useConfirm } from "@renderer/hooks";
import { uuid } from "@renderer/utils";
import { cloneDeep } from "lodash-es";
import { useFfmpegPreset, useAppConfig } from "@renderer/stores";
import { ffmpegPresetApi } from "@renderer/apis";

import type { FfmpegPreset, VideoCodec } from "@biliLive-tools/types";

const notice = useNotification();
const confirmDialog = useConfirm();
const { ffmpegOptions: options } = storeToRefs(useFfmpegPreset());
const { getPresetOptions } = useFfmpegPreset();

const emits = defineEmits<{
  (event: "change", value: FfmpegPreset): void;
}>();

const presetId = defineModel<string>({ required: true });

const nvencPresets = [
  {
    value: "p1",
    label: "fastest",
  },
  {
    value: "p2",
    label: "faster",
  },
  {
    value: "p3",
    label: "fast",
  },
  {
    value: "p4",
    label: "medium",
  },
  {
    value: "p5",
    label: "slow",
  },
  {
    value: "p6",
    label: "slower",
  },
  {
    value: "p7",
    label: "slowest",
  },
];
const qsvPresets = [
  {
    value: "veryfast",
    label: "veryfast",
  },
  {
    value: "faster",
    label: "faster",
  },
  {
    value: "fast",
    label: "fast",
  },
  {
    value: "medium",
    label: "medium",
  },
  {
    value: "slow",
    label: "slow",
  },
  {
    value: "slower",
    label: "slower",
  },
  {
    value: "veryslow",
    label: "veryslow",
  },
];
const videoEncoders = ref([
  {
    value: "copy",
    label: "copy(复制流)",
    birateControls: [
      {
        value: "CRF",
        label: "CRF",
      },
    ],
  },
  {
    value: "libx264",
    label: "H.264(x264)",
    birateControls: [
      {
        value: "CRF",
        label: "CRF",
      },
      {
        value: "VBR",
        label: "平均比特率",
      },
    ],
    presets: [
      {
        value: "ultrafast",
        label: "ultrafast",
      },
      {
        value: "superfast",
        label: "superfast",
      },
      {
        value: "veryfast",
        label: "veryfast",
      },
      {
        value: "faster",
        label: "faster",
      },
      {
        value: "fast",
        label: "fast",
      },
      {
        value: "medium",
        label: "medium",
      },
      {
        value: "slow",
        label: "slow",
      },
      {
        value: "slower",
        label: "slower",
      },
      {
        value: "veryslow",
        label: "veryslow",
      },
      {
        value: "placebo",
        label: "placebo",
      },
    ],
  },
  {
    value: "h264_qsv",
    label: "H.264(Intel QSV)",
    birateControls: [
      {
        value: "ICQ",
        label: "ICQ",
      },
      {
        value: "VBR",
        label: "平均比特率",
      },
    ],
    presets: qsvPresets,
  },
  {
    value: "h264_nvenc",
    label: "H.264(NVIDIA NVEnc)",
    birateControls: [
      {
        value: "CQ",
        label: "CQ",
      },
      {
        value: "VBR",
        label: "平均比特率",
      },
    ],
    presets: nvencPresets,
  },
  {
    value: "h264_amf",
    label: "H.264(AMD AMF)",
    birateControls: [
      {
        value: "VBR",
        label: "平均比特率",
      },
    ],
  },

  {
    value: "libx265",
    label: "H.265(x265)",
    birateControls: [
      {
        value: "CRF",
        label: "CRF",
      },
      {
        value: "VBR",
        label: "平均比特率",
      },
    ],
    presets: [
      {
        value: "ultrafast",
        label: "ultrafast",
      },
      {
        value: "superfast",
        label: "superfast",
      },
      {
        value: "veryfast",
        label: "veryfast",
      },
      {
        value: "faster",
        label: "faster",
      },
      {
        value: "fast",
        label: "fast",
      },
      {
        value: "medium",
        label: "medium",
      },
      {
        value: "slow",
        label: "slow",
      },
      {
        value: "slower",
        label: "slower",
      },
      {
        value: "veryslow",
        label: "veryslow",
      },
      {
        value: "placebo",
        label: "placebo",
      },
    ],
  },
  {
    value: "hevc_qsv",
    label: "H.265(Intel QSV)",
    birateControls: [
      {
        value: "ICQ",
        label: "ICQ",
      },
      {
        value: "VBR",
        label: "平均比特率",
      },
    ],
    presets: qsvPresets,
  },
  {
    value: "hevc_nvenc",
    label: "H.265(NVIDIA NVEnc)",
    birateControls: [
      {
        value: "CQ",
        label: "CQ",
      },
      {
        value: "VBR",
        label: "平均比特率",
      },
    ],
    presets: nvencPresets,
  },
  {
    value: "hevc_amf",
    label: "H.265(AMD AMF)",
    birateControls: [
      {
        value: "VBR",
        label: "平均比特率",
      },
    ],
  },

  {
    value: "libsvtav1",
    label: "AV1 (libsvtav1)",
    birateControls: [
      {
        value: "CRF",
        label: "CRF",
      },
      {
        value: "VBR",
        label: "平均比特率",
      },
    ],
    presets: [
      {
        value: "0",
        label: "0",
      },
      {
        value: "1",
        label: "1",
      },
      {
        value: "2",
        label: "2",
      },
      {
        value: "3",
        label: "3",
      },
      {
        value: "4",
        label: "4",
      },
      {
        value: "5",
        label: "5",
      },
      {
        value: "6",
        label: "6",
      },
      {
        value: "7",
        label: "7",
      },
      {
        value: "8",
        label: "8",
      },
      {
        value: "9",
        label: "9",
      },
      {
        value: "10",
        label: "10",
      },
      {
        value: "11",
        label: "11",
      },
      {
        value: "12",
        label: "12",
      },
      {
        value: "13",
        label: "13",
      },
    ],
  },
  {
    value: "av1_qsv",
    label: "AV1 (Intel QSV)",
    birateControls: [
      {
        value: "ICQ",
        label: "ICQ",
      },
      {
        value: "VBR",
        label: "平均比特率",
      },
    ],
    presets: qsvPresets,
  },
  {
    value: "av1_nvenc",
    label: "AV1 (NVIDIA NVEnc)",
    birateControls: [
      {
        value: "CQ",
        label: "CQ",
      },
      {
        value: "VBR",
        label: "平均比特率",
      },
    ],
    presets: nvencPresets,
  },
  {
    value: "av1_amf",
    label: "AV1 (AMD AMF)",
    birateControls: [
      {
        value: "VBR",
        label: "平均比特率",
      },
    ],
  },
]);

const audioEncoders = ref([
  {
    value: "copy",
    label: "copy(复制流)",
  },
  {
    value: "aac",
    label: "AAC",
  },
  {
    value: "libmp3lame",
    label: "MP3",
  },
  {
    value: "libopus",
    label: "Opus",
  },
  {
    value: "ac3",
    label: "AC3",
  },
  {
    value: "flac",
    label: "FLAC",
  },
]);

const encoderOptions = computed(() => {
  return videoEncoders.value.find((item) => item.value === ffmpegOptions.value?.config?.encoder);
});

const swsOptions = ref([
  {
    value: "bilinear",
    label: "bilinear(双线性插值)",
  },
  {
    value: "bicubic",
    label: "bicubic(三次插值)",
  },
  {
    value: "lanczos",
    label: "lanczos(Lanczos插值)",
  },
  {
    value: "neighbor",
    label: "neighbor(最近邻插值)",
  },
]);

const scaleMethodOptions = ref([
  {
    value: "auto",
    label: "自动",
  },
  {
    value: "before",
    label: "先缩放后渲染",
  },
  {
    value: "after",
    label: "先渲染后缩放",
  },
]);

// @ts-ignore
const ffmpegOptions: Ref<FfmpegPreset> = ref({
  id: "",
  name: "",
  config: {},
});

watch(
  () => ffmpegOptions.value,
  (value) => {
    emits("change", value);
  },
);

const handlePresetChange = async () => {
  ffmpegOptions.value = await ffmpegPresetApi.get(presetId.value);
};

watch(presetId, handlePresetChange);

const rename = async () => {
  tempPresetName.value = ffmpegOptions.value.name;
  isRename.value = true;
  nameModelVisible.value = true;
};

const saveAs = async () => {
  isRename.value = false;
  tempPresetName.value = "";
  nameModelVisible.value = true;
};

const { appConfig } = storeToRefs(useAppConfig());

const deletePreset = async () => {
  let ids = Object.entries(appConfig.value.webhook.rooms || {}).map(([, value]) => {
    return value?.ffmpegPreset;
  });
  ids.push(appConfig.value.webhook?.ffmpegPreset);
  ids = ids.filter((id) => id !== undefined && id !== "");

  const msg = ids.includes(presetId.value)
    ? "该预设正在被使用中，删除后使用该预设的功能将失效，是否确认删除？"
    : "是否确认删除该预设？";

  const [status] = await confirmDialog.warning({
    content: msg,
  });
  if (!status) return;
  await ffmpegPresetApi.remove(presetId.value);
  presetId.value = "default";
  getPresetOptions();
};

const nameModelVisible = ref(false);
const tempPresetName = ref("");
const isRename = ref(false);

const saveConfig = async () => {
  await ffmpegPresetApi.save(toRaw(ffmpegOptions.value));
  notice.success({
    title: "保存成功",
    duration: 1000,
  });
};
const saveConfirm = async () => {
  if (!tempPresetName.value) {
    notice.warning({
      title: "预设名称不得为空",
      duration: 2000,
    });
    return;
  }
  const preset = cloneDeep(ffmpegOptions.value);
  if (!isRename.value) preset.id = uuid();
  preset.name = tempPresetName.value;

  await ffmpegPresetApi.save(preset);
  nameModelVisible.value = false;
  notice.success({
    title: "保存成功",
    duration: 1000,
  });
  getPresetOptions();
};

const handleVideoEncoderChange = (value: VideoCodec) => {
  ffmpegOptions.value.config.encoder = value;
  if (
    (encoderOptions.value?.birateControls || [])
      .map((item) => item.value)
      .includes(ffmpegOptions.value?.config?.bitrateControl || "")
  ) {
    // do nothing
  } else {
    ffmpegOptions.value.config.bitrateControl = encoderOptions.value?.birateControls[0].value as
      | "CRF"
      | "VBR"
      | "ABR"
      | "CBR";
  }
};

const crfMinMax = computed(() => {
  if (ffmpegOptions.value.config.encoder === "libsvtav1") {
    return [0, 63];
  } else if (ffmpegOptions.value.config.encoder === "libx264") {
    return [0, 51];
  } else {
    return [0, 51];
  }
});

onMounted(async () => {
  await getPresetOptions();
  handlePresetChange();
});
</script>

<style scoped lang="less">
.actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
</style>
