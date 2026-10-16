<script setup lang="ts">
import {
  NAlert,
  NButton,
  NCollapse,
  NCollapseItem,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSpace,
  type FormInst,
  type FormItemRule,
  type FormRules,
} from 'naive-ui';
import { computed, reactive, ref, watch } from 'vue';
import {
  JSON_MODES,
  LLM_EXTRA_BODY_RESERVED,
  LLM_FIELD_MAX,
  LLM_PROFILE_DEFAULTS,
  LLM_PROFILE_RANGES,
  LLM_PROMPT_HEADROOM,
} from '../../shared/constants';
import type { CreateLlmProfileRequest, JsonMode, LlmPreset, LlmProfile } from '../../shared/types';
import { JSON_MODE_LABELS } from '../utils/labels';

const props = defineProps<{ show: boolean; profile?: LlmProfile | null; presets: LlmPreset[]; submitting?: boolean }>();
const emit = defineEmits<{ 'update:show': [boolean]; submit: [CreateLlmProfileRequest] }>();

const R = LLM_PROFILE_RANGES;
const form = reactive({
  preset: null as string | null,
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  jsonMode: LLM_PROFILE_DEFAULTS.jsonMode as JsonMode,
  maxConcurrency: null as number | null,
  timeoutSec: null as number | null,
  maxOutputTokens: null as number | null,
  contextTokens: null as number | null,
  temperature: null as number | null,
  extraBody: '',
});
const modelHint = ref('');
const formRef = ref<FormInst | null>(null);
const editing = computed(() => props.profile !== null && props.profile !== undefined);

watch(
  () => props.show,
  (show) => {
    if (!show) return;
    const p = props.profile;
    form.preset = null;
    form.name = p?.name ?? '';
    form.baseUrl = p?.baseUrl ?? '';
    form.apiKey = '';
    form.model = p?.model ?? '';
    form.jsonMode = p?.jsonMode ?? LLM_PROFILE_DEFAULTS.jsonMode;
    form.maxConcurrency = p?.maxConcurrency ?? LLM_PROFILE_DEFAULTS.maxConcurrency;
    form.timeoutSec = Math.round((p?.timeoutMs ?? LLM_PROFILE_DEFAULTS.timeoutMs) / 1000);
    form.maxOutputTokens = p?.maxOutputTokens ?? LLM_PROFILE_DEFAULTS.maxOutputTokens;
    form.contextTokens = p?.contextTokens ?? LLM_PROFILE_DEFAULTS.contextTokens;
    form.temperature = p?.temperature ?? LLM_PROFILE_DEFAULTS.temperature;
    form.extraBody = p === null || p === undefined || Object.keys(p.extraBody).length === 0 ? '' : JSON.stringify(p.extraBody, null, 2);
    modelHint.value = props.presets.find((x) => x.baseUrl === p?.baseUrl)?.modelHint ?? '';
  },
);

const presetOptions = computed(() => props.presets.map((p) => ({ label: p.name, value: p.name })));
const jsonModeOptions = JSON_MODES.map((m) => ({ label: JSON_MODE_LABELS[m], value: m }));

function applyPreset(name: string | null): void {
  form.preset = name;
  const preset = props.presets.find((x) => x.name === name);
  if (preset === undefined) return;
  if (form.name.trim() === '' || props.presets.some((x) => x.name === form.name)) form.name = preset.name;
  form.baseUrl = preset.baseUrl;
  modelHint.value = preset.modelHint;
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
};

/** 与服务端规则一致（INV-17）：换了服务域名又没填新 Key，保存时旧 Key 会被清空。 */
const keyWillClear = computed(() => {
  const p = props.profile;
  if (p === null || p === undefined || p.apiKeyMasked === '' || form.apiKey.trim() !== '') return false;
  const next = originOf(form.baseUrl);
  return next !== null && next !== originOf(p.baseUrl);
});

const insecureHttp = computed(
  () => /^\s*http:\/\//i.test(form.baseUrl) && !/^\s*http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(form.baseUrl),
);

const apiKeyPlaceholder = computed(() => {
  const masked = props.profile?.apiKeyMasked ?? '';
  if (masked !== '') return `已保存（${masked}），留空表示不修改`;
  return '本机服务（Ollama 等）可留空';
});

function parseExtraBody(text: string): Record<string, unknown> | Error {
  if (text.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return new Error('不是合法的 JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return new Error('必须是 JSON 对象，例如 {"enable_thinking": false}');
  const reserved: readonly string[] = LLM_EXTRA_BODY_RESERVED;
  const bad = Object.keys(value).filter((k) => reserved.includes(k));
  if (bad.length > 0) return new Error(`不能包含 ${bad.join('、')}`);
  if (text.length > LLM_FIELD_MAX.extraBodyJson) return new Error('内容过长');
  return value as Record<string, unknown>;
}

const requiredNumber = (label: string): FormItemRule => ({ type: 'number', required: true, message: `请填写${label}`, trigger: ['blur', 'change'] });

const rules: FormRules = {
  name: [{ required: true, whitespace: true, message: '请填写名称', trigger: ['input', 'blur'] }],
  baseUrl: [
    {
      required: true,
      trigger: ['input', 'blur'],
      validator: (_rule, value: string) => /^\s*https?:\/\/\S+/i.test(value) || new Error('请填写以 http:// 或 https:// 开头的地址'),
    },
  ],
  model: [{ required: true, whitespace: true, message: '请填写模型名', trigger: ['input', 'blur'] }],
  maxConcurrency: [requiredNumber('并发数')],
  timeoutSec: [requiredNumber('超时时间')],
  maxOutputTokens: [requiredNumber('最大输出')],
  contextTokens: [
    requiredNumber('上下文长度'),
    {
      trigger: ['blur', 'change'],
      validator: () =>
        form.contextTokens === null ||
        form.maxOutputTokens === null ||
        form.contextTokens >= form.maxOutputTokens + LLM_PROMPT_HEADROOM ||
        new Error(`至少要比最大输出多 ${LLM_PROMPT_HEADROOM}`),
    },
  ],
  temperature: [requiredNumber('温度')],
  extraBody: [
    {
      trigger: ['input', 'blur'],
      validator: (_rule, value: string) => {
        const r = parseExtraBody(value);
        return r instanceof Error ? r : true;
      },
    },
  ],
};

async function submit(): Promise<void> {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  const extraBody = parseExtraBody(form.extraBody);
  if (extraBody instanceof Error) return;
  emit('submit', {
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    apiKey: form.apiKey.trim(),
    model: form.model.trim(),
    jsonMode: form.jsonMode,
    maxConcurrency: form.maxConcurrency ?? LLM_PROFILE_DEFAULTS.maxConcurrency,
    timeoutMs: (form.timeoutSec ?? LLM_PROFILE_DEFAULTS.timeoutMs / 1000) * 1000,
    maxOutputTokens: form.maxOutputTokens ?? LLM_PROFILE_DEFAULTS.maxOutputTokens,
    contextTokens: form.contextTokens ?? LLM_PROFILE_DEFAULTS.contextTokens,
    temperature: form.temperature ?? LLM_PROFILE_DEFAULTS.temperature,
    extraBody,
  });
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="editing ? '编辑模型' : '添加模型'"
    style="width: 620px"
    :mask-closable="false"
    data-testid="llm-form"
    @update:show="emit('update:show', $event)"
  >
    <NForm ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="96" @submit.prevent="submit">
      <NFormItem v-if="!editing" label="服务预设">
        <NSelect
          :value="form.preset"
          :options="presetOptions"
          clearable
          placeholder="选择一个服务自动填写地址（可选）"
          data-testid="llm-preset"
          @update:value="applyPreset"
        />
      </NFormItem>
      <NFormItem label="名称" path="name">
        <NInput v-model:value="form.name" :maxlength="LLM_FIELD_MAX.name" placeholder="例如：DeepSeek" data-testid="llm-name" />
      </NFormItem>
      <NFormItem label="服务地址" path="baseUrl">
        <NInput
          v-model:value="form.baseUrl"
          :maxlength="LLM_FIELD_MAX.baseUrl"
          placeholder="OpenAI 兼容接口地址，选择预设可自动填写"
          data-testid="llm-baseurl"
        />
      </NFormItem>
      <NFormItem label="API Key" path="apiKey">
        <NInput
          v-model:value="form.apiKey"
          type="password"
          show-password-on="click"
          :maxlength="LLM_FIELD_MAX.apiKey"
          :placeholder="apiKeyPlaceholder"
          :input-props="{ autocomplete: 'off' }"
          data-testid="llm-apikey"
        />
      </NFormItem>
      <NFormItem label="模型名" path="model">
        <NInput
          v-model:value="form.model"
          :maxlength="LLM_FIELD_MAX.model"
          :placeholder="modelHint ? `例如：${modelHint}` : '服务方提供的模型名称'"
          data-testid="llm-model"
        />
      </NFormItem>
      <div v-if="keyWillClear || insecureHttp" class="alerts">
        <NAlert v-if="keyWillClear" type="warning" :show-icon="true" data-testid="llm-key-clear-warning">
          服务地址的域名已变更。为防止 API Key 被发给新的服务方，保存后旧 Key 会被清空，请重新填写。
        </NAlert>
        <NAlert v-if="insecureHttp" type="warning" :show-icon="true">
          该地址使用 http 明文传输，API Key 和正文可能被同一网络中的他人截获。
        </NAlert>
      </div>
      <NCollapse>
        <NCollapseItem title="高级设置" name="advanced">
          <NFormItem label="输出方式" path="jsonMode">
            <NSelect v-model:value="form.jsonMode" :options="jsonModeOptions" />
            <template #feedback>「测试连接」会自动探测并更新为该服务支持的最稳方式</template>
          </NFormItem>
          <NFormItem label="并发数" path="maxConcurrency">
            <NInputNumber v-model:value="form.maxConcurrency" :min="R.maxConcurrency[0]" :max="R.maxConcurrency[1]" :precision="0" />
          </NFormItem>
          <NFormItem label="超时（秒）" path="timeoutSec">
            <NInputNumber v-model:value="form.timeoutSec" :min="R.timeoutMs[0] / 1000" :max="R.timeoutMs[1] / 1000" :precision="0" />
          </NFormItem>
          <NFormItem label="最大输出" path="maxOutputTokens">
            <NInputNumber
              v-model:value="form.maxOutputTokens"
              :min="R.maxOutputTokens[0]"
              :max="R.maxOutputTokens[1]"
              :precision="0"
              :step="1024"
            />
            <template #feedback>单次回复的 token 上限</template>
          </NFormItem>
          <NFormItem label="上下文长度" path="contextTokens">
            <NInputNumber
              v-model:value="form.contextTokens"
              :min="R.contextTokens[0]"
              :max="R.contextTokens[1]"
              :precision="0"
              :step="8000"
            />
          </NFormItem>
          <NFormItem label="温度" path="temperature">
            <NInputNumber v-model:value="form.temperature" :min="R.temperature[0]" :max="R.temperature[1]" :precision="2" :step="0.1" />
          </NFormItem>
          <NFormItem label="附加参数" path="extraBody">
            <NInput
              v-model:value="form.extraBody"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 8 }"
              placeholder='原样加入请求体的 JSON，例如 {"enable_thinking": false}；值为 null 表示去掉该字段'
              class="mono"
            />
          </NFormItem>
        </NCollapseItem>
      </NCollapse>
    </NForm>
    <template #footer>
      <NSpace justify="end">
        <NButton @click="emit('update:show', false)">取消</NButton>
        <NButton type="primary" :loading="submitting" data-testid="llm-submit" @click="submit">{{ editing ? '保存' : '添加' }}</NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.alerts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}
.mono :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 13px;
}
</style>
