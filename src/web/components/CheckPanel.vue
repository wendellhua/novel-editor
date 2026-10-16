<script setup lang="ts">
import {
  NAlert,
  NButton,
  NCheckbox,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NForm,
  NFormItem,
  NPopconfirm,
  NProgress,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpace,
  NTag,
  NText,
  useMessage,
} from 'naive-ui';
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { AUTO_JOB_TYPES, CHAPTER_SCOPE_JOB_TYPES, CREATIVE_LIMITS, ENABLED_JOB_TYPES, JOB_TYPES } from '../../shared/constants';
import type { CreateJobRequest, Job, JobEstimate, JobType, Scope } from '../../shared/types';
import { ApiError } from '../api/client';
import { useJobsStore } from '../stores/jobs';
import { useLlmStore } from '../stores/llm';
import { useSkillsStore } from '../stores/skills';
import { useWorkspaceStore } from '../stores/workspace';
import { formatTime, formatTokens, formatWords } from '../utils/format';
import { JOB_STATUS_LABELS, TASK_KIND_LABELS } from '../utils/labels';

/** initialType：打开面板时预选的检查类型（如从设定库发起「AI 抽取设定」）。 */
const props = defineProps<{ show: boolean; workId: string; chapterId: string | null; initialType?: JobType | null }>();
const emit = defineEmits<{ 'update:show': [boolean]; report: [jobId: string]; expansion: [jobId: string] }>();

const jobs = useJobsStore();
const ws = useWorkspaceStore();
const llm = useLlmStore();
const skills = useSkillsStore();
const message = useMessage();
const router = useRouter();
const errorText = (err: unknown, fallback: string): string => (err instanceof ApiError ? err.message : fallback);

// ---------------- 表单 ----------------
const scopeKind = ref<Scope['kind']>('work');
const type = ref<JobType>('typo');
const skillId = ref<string | null>(null);
const profileId = ref<string | null>(null);
const onlyChanged = ref(false);
const loaded = ref(false);

const current = computed(() => (props.chapterId === null ? null : ws.locate(props.chapterId)));
const scope = computed<Scope | null>(() => {
  if (scopeKind.value === 'work') return { kind: 'work', id: props.workId };
  const c = current.value;
  if (c === null) return null;
  return scopeKind.value === 'volume' ? { kind: 'volume', id: c.volume.id } : { kind: 'chapter', id: c.chapter.id };
});

// 剧情记忆由系统自动更新，不在这里发起
const typeOptions = JOB_TYPES.filter((t) => !AUTO_JOB_TYPES.includes(t)).map((t) => ({
  label: ENABLED_JOB_TYPES.includes(t) ? TASK_KIND_LABELS[t] : `${TASK_KIND_LABELS[t]}（即将提供）`,
  value: t,
  disabled: !ENABLED_JOB_TYPES.includes(t),
}));
/** 灵感胶囊、智能扩写只针对当前章节。 */
const chapterOnly = computed(() => CHAPTER_SCOPE_JOB_TYPES.includes(type.value));
watch(chapterOnly, (only) => {
  if (only) scopeKind.value = 'chapter';
});
const TYPE_HINTS: Partial<Record<JobType, string>> = {
  ai_flavor: '找出模板化、空泛的「AI 味」表达，每处都给出改写，可在问题面板一键优化',
  inspiration: '根据作品设定、剧情记忆与当前剧情，构思五条剧情发展路线（不改动正文）',
  expand: '只根据前文续写当前章节，生成后由你确认再插入章末；一次只写当前这一章',
};
const targetChars = ref<number>(CREATIVE_LIMITS.expandDefaultChars);
const targetOptions = [1000, 2000, 3000]
  .filter((n) => n >= CREATIVE_LIMITS.expandMinChars && n <= CREATIVE_LIMITS.expandMaxChars)
  .map((n) => ({ label: `约 ${n} 字`, value: n }));
const START_LABELS: Partial<Record<JobType, string>> = { inspiration: '生成灵感', expand: '开始扩写' };
const skillOptions = computed(() =>
  skills.skills
    .filter((s) => s.enabled && s.appliesTo.includes(type.value))
    .map((s) => ({ label: s.source === 'builtin' ? `${s.name}（内置）` : s.name, value: s.id })),
);
const profileOptions = computed(() => llm.profiles.map((p) => ({ label: `${p.name}（${p.model}）`, value: p.id })));
const noModel = computed(() => loaded.value && llm.profiles.length === 0);
/** 所选模型最近一次请求失败（连接、鉴权、额度、超时……）时，开始前提醒。 */
const selectedModelError = computed(() => {
  const s = profileId.value === null ? undefined : llm.statuses[profileId.value];
  return s?.state === 'error' ? s : null;
});
/** 进行中的任务所用模型正处于异常状态：说明任务为什么停在原处（多半在等超时或重试）。 */
function modelProblem(j: Job): string | null {
  if (j.status !== 'running' && j.status !== 'queued') return null;
  const s = llm.statuses[j.profileId];
  if (s?.state !== 'error') return null;
  const name = llm.profiles.find((p) => p.id === j.profileId)?.name ?? '';
  return `模型「${name}」连接异常：${s.error ?? ''}${s.retrying > 0 ? '，正在重试' : ''}`;
}
const openModels = (): void => void router.push({ name: 'settings', query: { tab: 'models' } });

/** 换检查类型时，技能回到内置技能，模型回到该类任务的默认模型。 */
function resetChoices(): void {
  skillId.value = skills.skills.find((s) => s.source === 'builtin' && s.appliesTo.includes(type.value))?.id ?? skillOptions.value[0]?.value ?? null;
  const preferred = llm.defaults?.[type.value] ?? null;
  profileId.value = llm.profiles.some((p) => p.id === preferred) ? preferred : (llm.profiles[0]?.id ?? null);
}
watch(type, resetChoices);

watch(
  () => props.show,
  async (show) => {
    if (!show) return;
    if (props.chapterId === null && scopeKind.value !== 'work') scopeKind.value = 'work';
    if (props.initialType !== undefined && props.initialType !== null && ENABLED_JOB_TYPES.includes(props.initialType)) {
      type.value = props.initialType;
      scopeKind.value = CHAPTER_SCOPE_JOB_TYPES.includes(props.initialType) ? 'chapter' : 'work';
    }
    if (chapterOnly.value) scopeKind.value = 'chapter';
    try {
      await Promise.all([llm.refresh(), skills.load()]);
      loaded.value = true;
      if (skillId.value === null || !skillOptions.value.some((o) => o.value === skillId.value)) resetChoices();
      if (profileId.value === null || !llm.profiles.some((p) => p.id === profileId.value)) resetChoices();
    } catch (err) {
      message.error(errorText(err, '读取模型或技能失败'));
    }
  },
  { immediate: true },
);

const request = computed<CreateJobRequest | null>(() => {
  if (scope.value === null || skillId.value === null || profileId.value === null) return null;
  if (chapterOnly.value && scope.value.kind !== 'chapter') return null;
  return {
    type: type.value,
    skillId: skillId.value,
    scope: scope.value,
    profileId: profileId.value,
    onlyChanged: chapterOnly.value ? false : onlyChanged.value,
    ...(type.value === 'expand' ? { options: { targetChars: targetChars.value } } : {}),
  };
});

// ---------------- 预估 ----------------
const estimate = ref<JobEstimate | null>(null);
const estimateError = ref<string | null>(null);
const estimating = ref(false);
let estimateSeq = 0;
let estimateTimer: ReturnType<typeof setTimeout> | undefined;

/** 防抖后重新预估；只采用最后一次请求的结果。 */
function scheduleEstimate(): void {
  clearTimeout(estimateTimer);
  if (!props.show || request.value === null) {
    estimate.value = null;
    return;
  }
  const req = request.value;
  const seq = ++estimateSeq;
  estimating.value = true;
  estimateTimer = setTimeout(() => {
    jobs
      .estimate(req)
      .then((e) => {
        if (seq !== estimateSeq) return;
        estimate.value = e;
        estimateError.value = null;
      })
      .catch((err: unknown) => {
        if (seq !== estimateSeq) return;
        estimate.value = null;
        estimateError.value = errorText(err, '预估失败');
      })
      .finally(() => {
        if (seq === estimateSeq) estimating.value = false;
      });
  }, 250);
}
watch([request, () => props.show], scheduleEstimate, { deep: true });
// 任务完成后「只查改动过的章节」的结果会变化
watch(() => jobs.jobs.map((j) => `${j.id}:${j.status}`).join(','), scheduleEstimate);

const creating = ref(false);
const canStart = computed(() => request.value !== null && estimate.value !== null && estimate.value.units > 0 && !estimating.value);

async function start(): Promise<void> {
  if (request.value === null) return;
  creating.value = true;
  try {
    await jobs.create(request.value);
    message.success(type.value === 'expand' ? '已开始扩写，完成后会打开结果供你确认' : type.value === 'inspiration' ? '正在构思剧情路线，完成后提示查看' : '已开始检查，可以继续写作');
  } catch (err) {
    message.error(errorText(err, '创建任务失败'));
  } finally {
    creating.value = false;
  }
}

// ---------------- 任务列表 ----------------
function scopeLabel(s: Scope): string {
  if (s.kind === 'work') return '整部作品';
  if (s.kind === 'volume') return ws.volumes.find((v) => v.id === s.id)?.title ?? '（已删除的分卷）';
  return ws.locate(s.id)?.chapter.title ?? '（已删除的章节）';
}
const progress = (j: Job): number => (j.totalUnits === 0 ? 0 : Math.round(((j.doneUnits + j.failedUnits) / j.totalUnits) * 100));
const busy = ref(new Set<string>());

async function control(j: Job, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  busy.value.add(j.id);
  try {
    await jobs.control(j.id, action);
  } catch (err) {
    message.error(errorText(err, '操作失败'));
  } finally {
    busy.value.delete(j.id);
  }
}

async function remove(j: Job): Promise<void> {
  try {
    await jobs.remove(j.id);
  } catch (err) {
    message.error(errorText(err, '删除失败'));
  }
}
</script>

<template>
  <NDrawer :show="show" :width="460" placement="right" @update:show="emit('update:show', $event)">
    <NDrawerContent title="AI 检查" closable :native-scrollbar="false" data-testid="check-panel">
      <NAlert v-if="noModel" type="warning" title="尚未配置模型" class="gap" data-testid="check-no-model">
        AI 检查需要先添加一个大模型服务。
        <NButton size="tiny" text type="primary" @click="openModels">去设置 ›</NButton>
      </NAlert>

      <NForm label-placement="left" label-width="64" size="small" :show-feedback="false" class="form">
        <NFormItem label="类型">
          <NSelect v-model:value="type" :options="typeOptions" data-testid="check-type" />
        </NFormItem>
        <NFormItem v-if="TYPE_HINTS[type]" label=" ">
          <NText depth="3" class="hint" data-testid="check-type-hint">{{ TYPE_HINTS[type] }}</NText>
        </NFormItem>
        <NFormItem label="范围">
          <NRadioGroup v-model:value="scopeKind" size="small" data-testid="check-scope">
            <NRadioButton value="work" :disabled="chapterOnly">整部作品</NRadioButton>
            <NRadioButton value="volume" :disabled="current === null || chapterOnly">当前分卷</NRadioButton>
            <NRadioButton value="chapter" :disabled="current === null">当前章节</NRadioButton>
          </NRadioGroup>
        </NFormItem>
        <NFormItem v-if="scopeKind !== 'work' && current" label=" ">
          <NText depth="3" class="hint">{{ scopeKind === 'volume' ? current.volume.title : `${current.volume.title} · ${current.chapter.title}` }}</NText>
        </NFormItem>
        <NFormItem v-else-if="chapterOnly && current === null" label=" ">
          <NText type="warning" class="hint">请先在左侧打开一个章节</NText>
        </NFormItem>
        <NFormItem v-if="type === 'expand'" label="篇幅">
          <NSelect v-model:value="targetChars" :options="targetOptions" data-testid="check-target-chars" />
        </NFormItem>
        <NFormItem label="技能">
          <NSelect v-model:value="skillId" :options="skillOptions" placeholder="没有可用于这类检查的技能" data-testid="check-skill" />
        </NFormItem>
        <NFormItem label="模型">
          <NSelect v-model:value="profileId" :options="profileOptions" placeholder="请先在设置中添加模型" data-testid="check-model" />
        </NFormItem>
        <NFormItem v-if="selectedModelError" label=" ">
          <NText type="warning" class="hint" data-testid="check-model-error">
            这个模型最近一次请求失败：{{ selectedModelError.error }}。{{ selectedModelError.hint }}
            <NButton size="tiny" text type="primary" @click="openModels">去检查 ›</NButton>
          </NText>
        </NFormItem>
        <NFormItem v-if="!chapterOnly" label=" ">
          <NCheckbox v-model:checked="onlyChanged" data-testid="check-only-changed">只查自上次检查后改动过的章节</NCheckbox>
        </NFormItem>
      </NForm>

      <div class="estimate" data-testid="check-estimate">
        <NText v-if="estimateError" type="error">{{ estimateError }}</NText>
        <template v-else-if="estimate">
          <div>
            {{ estimate.chapters }} 章 · {{ formatWords(estimate.chars) }} · {{ estimate.units }} 个片段 · 预计输入约
            {{ formatTokens(estimate.estimatedInputTokens) }} token
          </div>
          <NText v-if="estimate.skippedChapters > 0" depth="3" class="hint">{{ estimate.skippedChapters }} 章自上次检查后没有改动，已跳过</NText>
        </template>
        <NText v-else depth="3">{{ estimating ? '正在预估…' : '选择范围与模型后显示预估用量' }}</NText>
      </div>
      <NButton type="primary" block :disabled="!canStart" :loading="creating" data-testid="check-start" @click="start">{{ START_LABELS[type] ?? '开始检查' }}</NButton>

      <h4 class="list-title">任务</h4>
      <NEmpty v-if="jobs.jobs.length === 0" size="small" description="还没有检查任务" />
      <div v-for="j in jobs.jobs" :key="j.id" class="job" data-testid="job-row" :data-status="j.status">
        <div class="job-head">
          <span class="job-name">{{ TASK_KIND_LABELS[j.type] }} · {{ scopeLabel(j.scope) }}</span>
          <NTag size="small" :type="JOB_STATUS_LABELS[j.status].type" :bordered="false" data-testid="job-status">{{ JOB_STATUS_LABELS[j.status].text }}</NTag>
        </div>
        <NProgress
          type="line"
          :percentage="progress(j)"
          :status="j.status === 'failed' ? 'error' : j.status === 'done' ? 'success' : 'default'"
          :processing="j.status === 'running'"
          :show-indicator="false"
          :height="6"
        />
        <div class="job-meta">
          <NText depth="3">
            {{ j.doneUnits + j.failedUnits }}/{{ j.totalUnits }} 片段<template v-if="j.failedUnits > 0">（失败 {{ j.failedUnits }}）</template> · 用量
            {{ formatTokens(j.promptTokens + j.completionTokens) }} token · {{ formatTime(j.createdAt) }}
          </NText>
        </div>
        <NText v-if="j.error" type="error" class="job-error" data-testid="job-error">{{ j.error }}</NText>
        <NText v-else-if="modelProblem(j)" type="warning" class="job-error" data-testid="job-model-warning">
          {{ modelProblem(j) }}
          <NButton size="tiny" text type="primary" @click="openModels">检查模型 ›</NButton>
        </NText>
        <NSpace :size="4" class="job-actions">
          <NButton v-if="j.type === 'review' && j.doneUnits > 0" size="tiny" type="primary" secondary data-testid="job-report" @click="emit('report', j.id)">
            查看报告
          </NButton>
          <NButton v-if="j.type === 'inspiration' && j.status === 'done'" size="tiny" type="primary" secondary data-testid="job-report" @click="emit('report', j.id)">
            查看灵感
          </NButton>
          <NButton v-if="j.type === 'expand' && j.status === 'done'" size="tiny" type="primary" secondary data-testid="job-expansion" @click="emit('expansion', j.id)">
            查看扩写
          </NButton>
          <NButton v-if="j.status === 'running' || j.status === 'queued'" size="tiny" :loading="busy.has(j.id)" data-testid="job-pause" @click="control(j, 'pause')">
            暂停
          </NButton>
          <NButton v-if="j.status === 'paused' || j.status === 'failed'" size="tiny" type="primary" :loading="busy.has(j.id)" data-testid="job-resume" @click="control(j, 'resume')">
            {{ j.status === 'failed' ? '重试' : '继续' }}
          </NButton>
          <NButton v-if="!['done', 'cancelled'].includes(j.status)" size="tiny" quaternary :disabled="busy.has(j.id)" data-testid="job-cancel" @click="control(j, 'cancel')">
            取消
          </NButton>
          <NPopconfirm v-else positive-text="删除" negative-text="取消" @positive-click="remove(j)">
            <template #trigger>
              <NButton size="tiny" quaternary type="error" data-testid="job-delete">删除</NButton>
            </template>
            删除这个任务及它找到的问题？
          </NPopconfirm>
        </NSpace>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.gap {
  margin-bottom: 12px;
}
.form :deep(.n-form-item) {
  margin-bottom: 10px;
}
.hint {
  font-size: 12px;
}
.estimate {
  margin: 6px 0 12px;
  padding: 10px 12px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.07);
  font-size: 13px;
  line-height: 1.7;
}
.list-title {
  margin: 22px 0 8px;
}
.job {
  padding: 10px 0;
  border-bottom: 1px solid rgba(128, 128, 128, 0.15);
}
.job-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.job-name {
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.job-meta {
  font-size: 12px;
  margin-top: 4px;
}
.job-error {
  display: block;
  font-size: 12px;
  margin-top: 4px;
  word-break: break-all;
}
.job-actions {
  margin-top: 6px;
}
</style>
