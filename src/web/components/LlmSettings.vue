<script setup lang="ts">
import {
  NButton,
  NCard,
  NEmpty,
  NForm,
  NFormItem,
  NPopconfirm,
  NSelect,
  NSpace,
  NSpin,
  NTag,
  NText,
  useMessage,
} from 'naive-ui';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { LLM_DEFAULT_FALLBACKS, TASK_KINDS } from '../../shared/constants';
import type { CreateLlmProfileRequest, LlmProfile, LlmProfileStatus, TaskKind } from '../../shared/types';
import { ApiError } from '../api/client';
import { useLlmStore } from '../stores/llm';
import { formatAgo } from '../utils/format';
import { JSON_MODE_LABELS, TASK_KIND_LABELS } from '../utils/labels';
import LlmProfileModal from './LlmProfileModal.vue';

const llm = useLlmStore();
const message = useMessage();
const errorText = (err: unknown, fallback: string): string => (err instanceof ApiError ? err.message : fallback);

/** 每秒刷新：测试已等待的秒数、「N 分钟前」。 */
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  llm.load().catch((err: unknown) => message.error(errorText(err, '读取模型配置失败')));
  ticker = setInterval(() => (now.value = Date.now()), 1000);
});
onBeforeUnmount(() => clearInterval(ticker));

const statusOf = (p: LlmProfile): LlmProfileStatus | undefined => llm.statuses[p.id];
const STATE_TAGS = {
  testing: { type: 'info', text: '测试中' },
  ok: { type: 'success', text: '可用' },
  error: { type: 'error', text: '异常' },
  unknown: { type: 'default', text: '未检测' },
} as const;
function stateTag(p: LlmProfile): (typeof STATE_TAGS)[keyof typeof STATE_TAGS] {
  if (llm.testing.has(p.id)) return STATE_TAGS.testing;
  return STATE_TAGS[statusOf(p)?.state ?? 'unknown'];
}
const testingSeconds = (p: LlmProfile): number => Math.max(0, Math.floor((now.value - (llm.testing.get(p.id)?.since ?? now.value)) / 1000));
const duration = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const ago = (at: number | null): string => (at === null ? '' : formatAgo(at, now.value));
const sourceText = (s: LlmProfileStatus): string => (s.source === 'test' ? '测试连接' : 'AI 任务的请求');
/** 进行中的 AI 请求：数量、排队与重试。 */
function activityText(s: LlmProfileStatus | undefined): string {
  if (s === undefined || s.active + s.waiting === 0) return '';
  const parts = [`${s.active} 个请求进行中`];
  if (s.waiting > 0) parts.push(`${s.waiting} 个排队`);
  if (s.retrying > 0) parts.push(`${s.retrying} 个失败后正在重试`);
  return `AI 任务：${parts.join('，')}`;
}

const showForm = ref(false);
const editing = ref<LlmProfile | null>(null);
const submitting = ref(false);

function openCreate(): void {
  editing.value = null;
  showForm.value = true;
}

function openEdit(p: LlmProfile): void {
  editing.value = p;
  showForm.value = true;
}

async function submit(req: CreateLlmProfileRequest): Promise<void> {
  submitting.value = true;
  try {
    if (editing.value === null) {
      const p = await llm.create(req);
      message.success(`已添加「${p.name}」，建议点「测试连接」确认可用`);
    } else {
      await llm.update(editing.value.id, req);
      message.success('已保存');
    }
    showForm.value = false;
  } catch (err) {
    message.error(errorText(err, '保存失败'));
  } finally {
    submitting.value = false;
  }
}

async function remove(p: LlmProfile): Promise<void> {
  try {
    await llm.remove(p.id);
    message.success(`已删除「${p.name}」`);
  } catch (err) {
    message.error(errorText(err, '删除失败'));
  }
}

async function test(p: LlmProfile): Promise<void> {
  try {
    const r = await llm.test(p.id);
    if (r === null) message.info(`已取消「${p.name}」的测试连接`);
    else if (r.ok) message.success(`「${p.name}」连接正常`);
    else message.error(`「${p.name}」连接失败，原因和处理建议见模型下方`);
  } catch (err) {
    message.error(errorText(err, '测试连接失败'));
  }
}

const profileOptions = computed(() => llm.profiles.map((p) => ({ label: `${p.name}（${p.model}）`, value: p.id })));
/** 未设置时的说明：后加的任务类型沿用相近任务的默认模型（LLM_DEFAULT_FALLBACKS）。 */
function fallbackHint(kind: TaskKind): string {
  const from = LLM_DEFAULT_FALLBACKS[kind] ?? [];
  return from.length === 0 ? '未设置' : `未设置时同「${from.map((k) => TASK_KIND_LABELS[k]).join('」或「')}」`;
}

async function setDefault(kind: TaskKind, id: string | null): Promise<void> {
  try {
    await llm.setDefault(kind, id);
  } catch (err) {
    message.error(errorText(err, '保存默认模型失败'));
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
</script>

<template>
  <div class="llm-settings">
    <NCard title="模型" :segmented="{ content: true }">
      <template #header-extra>
        <NButton type="primary" size="small" data-testid="llm-add" @click="openCreate">添加模型</NButton>
      </template>
      <NSpin :show="llm.loading">
        <NEmpty
          v-if="llm.profiles.length === 0"
          description="尚未配置模型。AI 检查需要至少一个 OpenAI 兼容的大模型服务（DeepSeek、通义千问、Kimi、本机 Ollama 等）。"
          class="empty"
        >
          <template #extra>
            <NButton size="small" @click="openCreate">添加第一个模型</NButton>
          </template>
        </NEmpty>
        <div v-else class="rows">
          <div v-for="p in llm.profiles" :key="p.id" class="row" data-testid="llm-row">
            <div class="main">
              <div class="title">
                <span class="name">{{ p.name }}</span>
                <NTag size="small" :bordered="false">{{ p.model }}</NTag>
                <NTag size="small" :bordered="false" type="info" data-testid="llm-jsonmode">{{ JSON_MODE_LABELS[p.jsonMode] }}</NTag>
                <NTag size="small" round :type="stateTag(p).type" data-testid="llm-state">{{ stateTag(p).text }}</NTag>
              </div>
              <div class="meta">
                <span :title="p.baseUrl">{{ hostOf(p.baseUrl) }}</span>
                <span>·</span>
                <span>{{ p.apiKeyMasked || '未设置 Key' }}</span>
                <span>·</span>
                <span>并发 {{ p.maxConcurrency }}</span>
              </div>
              <!-- 模型运行状态：测试连接与 AI 任务请求的最近结果（§7.3「运行状态」） -->
              <div class="probe" data-testid="llm-probe">
                <NText v-if="llm.testing.has(p.id)" type="info">正在测试连接… 已等待 {{ testingSeconds(p) }} 秒</NText>
                <template v-else-if="statusOf(p)?.state === 'ok'">
                  <NText type="success">
                    <template v-if="statusOf(p)!.source === 'test'">连接正常 · {{ JSON_MODE_LABELS[p.jsonMode] }} · {{ statusOf(p)!.latencyMs }} ms</template>
                    <template v-else>连接正常 · 最近一次 AI 请求成功（耗时 {{ duration(statusOf(p)!.latencyMs ?? 0) }}）</template>
                  </NText>
                  <NText depth="3"> · {{ ago(statusOf(p)!.at) }}</NText>
                </template>
                <template v-else-if="statusOf(p)?.state === 'error'">
                  <NText type="error" data-testid="llm-error">连接异常：{{ statusOf(p)!.error }}</NText>
                  <div v-if="statusOf(p)!.hint" class="hint-line" data-testid="llm-hint">处理建议：{{ statusOf(p)!.hint }}</div>
                  <NText depth="3" class="when">{{ ago(statusOf(p)!.at) }} · 来自{{ sourceText(statusOf(p)!) }}</NText>
                </template>
                <NText v-else depth="3">尚未检测：本次启动后还没有请求过这个模型，可以点「测试连接」确认是否可用</NText>
              </div>
              <div v-if="activityText(statusOf(p))" class="probe" data-testid="llm-activity">
                <NText depth="3">{{ activityText(statusOf(p)) }}</NText>
              </div>
            </div>
            <NSpace :size="8" class="actions" :wrap="false">
              <NButton v-if="llm.testing.has(p.id)" size="small" data-testid="llm-test-cancel" @click="llm.cancelTest(p.id)">取消测试</NButton>
              <NButton v-else size="small" data-testid="llm-test" @click="test(p)">测试连接</NButton>
              <NButton size="small" quaternary data-testid="llm-edit" @click="openEdit(p)">编辑</NButton>
              <NPopconfirm positive-text="删除" negative-text="取消" @positive-click="remove(p)">
                <template #trigger>
                  <NButton size="small" quaternary type="error">删除</NButton>
                </template>
                删除「{{ p.name }}」？使用它作为默认模型的任务需要重新选择。
              </NPopconfirm>
            </NSpace>
          </div>
        </div>
      </NSpin>
    </NCard>

    <NCard title="默认模型" :segmented="{ content: true }">
      <NText depth="3" class="hint">各类 AI 任务默认使用的模型。</NText>
      <NForm label-placement="left" label-width="112" :show-feedback="false" class="defaults">
        <NFormItem v-for="kind in TASK_KINDS" :key="kind" :label="TASK_KIND_LABELS[kind]">
          <NSelect
            :value="llm.defaults?.[kind] ?? null"
            :options="profileOptions"
            :disabled="llm.profiles.length === 0"
            clearable
            :placeholder="fallbackHint(kind)"
            :data-testid="`llm-default-${kind}`"
            @update:value="(v: string | null) => setDefault(kind, v)"
          />
        </NFormItem>
      </NForm>
    </NCard>

    <LlmProfileModal v-model:show="showForm" :profile="editing" :presets="llm.presets" :submitting="submitting" @submit="submit" />
  </div>
</template>

<style scoped>
.llm-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.empty {
  padding: 24px 0;
}
.rows {
  display: flex;
  flex-direction: column;
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.15));
}
.row:last-child {
  border-bottom: none;
}
.main {
  flex: 1;
  min-width: 0;
}
.title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.name {
  font-weight: 600;
}
.meta {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  font-size: 13px;
  opacity: 0.65;
  flex-wrap: wrap;
}
.probe {
  margin-top: 6px;
  font-size: 13px;
  word-break: break-all;
}
.hint-line {
  margin-top: 2px;
  font-size: 13px;
  line-height: 1.6;
}
.when {
  display: block;
  margin-top: 2px;
  font-size: 12px;
}
.actions {
  flex: none;
}
.hint {
  display: block;
  margin-bottom: 12px;
  font-size: 13px;
}
.defaults {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px 24px;
}
</style>
