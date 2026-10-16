<script setup lang="ts">
import { NButton, NEmpty, NPopconfirm, NRadioButton, NRadioGroup, NSelect, NSpace, NSpin, NTag, NText, NTooltip, useMessage } from 'naive-ui';
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { Issue, IssueStatus } from '../../shared/types';
import { ApiError } from '../api/client';
import { useIssuesStore } from '../stores/issues';
import { useWorkspaceStore } from '../stores/workspace';
import { ISSUE_CATEGORY_LABELS, ISSUE_STATUS_LABELS, SEVERITY_TAG_TYPES } from '../utils/labels';

const props = defineProps<{ workId: string; chapterId: string | null }>();
const emit = defineEmits<{ close: [] }>();
const issues = useIssuesStore();
const ws = useWorkspaceStore();
const router = useRouter();
const message = useMessage();

/** 列表最多渲染的条数（全书范围可能有上千条）。 */
const MAX_RENDER = 300;

const scope = ref<'chapter' | 'work'>('chapter');
const status = ref<IssueStatus | 'all'>('open');
const busy = ref(false);
const listEl = ref<HTMLElement | null>(null);

const statusOptions = [
  ...(Object.keys(ISSUE_STATUS_LABELS) as IssueStatus[]).map((s) => ({ label: ISSUE_STATUS_LABELS[s], value: s })),
  { label: '全部', value: 'all' },
];

const visible = computed(() =>
  issues.items.filter(
    (i) => (scope.value === 'work' || i.chapterId === props.chapterId) && (status.value === 'all' || i.status === status.value),
  ),
);
const fixable = computed(() => visible.value.filter((i) => i.status === 'open' && i.replacement !== null));
/** 「全部修复」的范围：全部待处理问题（有建议的直接采纳，没有建议的由 AI 按意见改写）。 */
const repairable = computed(() => visible.value.filter((i) => i.status === 'open'));
const needsAi = computed(() => repairable.value.length - fixable.value.length);
const ignorable = computed(() => visible.value.filter((i) => i.status === 'open' || i.status === 'stale'));
const fixing = computed(() => issues.fixProgress !== null);
const chapterOpen = computed(() => (props.chapterId === null ? 0 : issues.openInChapter(props.chapterId).length));

function chapterLabel(i: Issue): string {
  const loc = ws.locate(i.chapterId);
  return loc === null ? '' : `${loc.volume.title} · ${loc.chapter.title}`;
}

const errorText = (err: unknown, fallback: string): string => (err instanceof ApiError ? err.message : fallback);

function locate(i: Issue): void {
  if (i.status !== 'open') {
    issues.select(i.id, { locate: false });
    return;
  }
  issues.select(i.id);
  if (i.chapterId !== props.chapterId) void router.push({ name: 'workspace', params: { workId: props.workId, chapterId: i.chapterId } });
}

async function apply(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  busy.value = true;
  try {
    const res = await issues.apply(ids);
    if (res.blocked) message.error('当前章节还有没保存成功的内容，请先处理保存问题再修正');
    else if (res.stale.length > 0) message.warning(`已修正 ${res.applied.length} 处；${res.stale.length} 处原文已改动或与其他修正重叠，未修改`);
    else message.success(`已修正 ${res.applied.length} 处，可在编辑器中撤销，修正前的内容已存为历史版本`);
  } catch (err) {
    message.error(errorText(err, '修正失败'));
  } finally {
    busy.value = false;
  }
}

const quote = (s: string): string => `「${s.length > 16 ? `${s.slice(0, 16)}…` : s}」`;

/** 修复：没有修改建议的先由 AI 生成，再一并修正；结果按成功、失败、失效分别提示。 */
async function repair(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  busy.value = true;
  try {
    const res = await issues.fix(ids);
    const fail = res.failed[0]?.message ?? '';
    if (res.blocked) {
      message.error('当前章节还有没保存成功的内容，请先处理保存问题再修复');
    } else if (res.stopped) {
      message.info(res.rewritten.length > 0 ? `已停止：${res.rewritten.length} 条已生成修改建议，正文未改动，可以逐条「采纳」` : '已停止修复');
    } else if (ids.length === 1) {
      const issue = issues.byId.get(ids[0] ?? '');
      if (res.applied.length === 1 && issue !== undefined) {
        message.success(`已修复：${quote(issue.target)} → ${issue.replacement === '' ? '（删除）' : quote(issue.replacement ?? '')}，可在编辑器中撤销`);
      } else if (res.failed.length > 0) message.error(`AI 修复失败：${fail}`);
      else message.warning('原文已改动或与其他修正重叠，未修改');
    } else if (res.applied.length === 0 && res.failed.length > 0) {
      message.error(`AI 修复失败：${fail}${res.skipped > 0 ? `（其余 ${res.skipped} 条未尝试）` : ''}`);
    } else {
      const ai = res.applied.filter((i) => res.rewritten.includes(i)).length;
      const parts = [`已修复 ${res.applied.length} 处${ai > 0 ? `（其中 AI 改写 ${ai} 处）` : ''}`];
      if (res.failed.length > 0) parts.push(`${res.failed.length} 处 AI 未能修复（${fail}）`);
      if (res.skipped > 0) parts.push(`${res.skipped} 处未尝试`);
      if (res.stale.length > 0) parts.push(`${res.stale.length} 处原文已改动或与其他修正重叠，未修改`);
      const text = `${parts.join('；')}。可在编辑器中撤销，修改前的内容已存为历史版本`;
      if (parts.length > 1) message.warning(text, { duration: 8000 });
      else message.success(text);
    }
  } catch (err) {
    message.error(errorText(err, '修复失败'));
  } finally {
    busy.value = false;
  }
}

async function ignore(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  busy.value = true;
  try {
    await issues.ignore(ids);
  } catch (err) {
    message.error(errorText(err, '操作失败'));
  } finally {
    busy.value = false;
  }
}

// 在编辑器里点击高亮文字时，把对应的条目滚动到可见位置
watch(
  () => issues.selectedId,
  async (id) => {
    if (id === null) return;
    const issue = issues.byId.get(id);
    if (issue !== undefined && issue.chapterId !== props.chapterId && scope.value === 'chapter') scope.value = 'work';
    await nextTick();
    listEl.value?.querySelector(`[data-issue-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  },
);
</script>

<template>
  <aside class="issue-panel" data-testid="issue-panel">
    <header class="head">
      <span class="title">问题</span>
      <NText depth="3" class="count">本章待处理 {{ chapterOpen }} · 全书 {{ issues.openCount }}</NText>
      <NButton quaternary size="tiny" class="close" data-testid="issue-panel-close" @click="emit('close')">✕</NButton>
    </header>
    <div class="filters">
      <NRadioGroup v-model:value="scope" size="small" data-testid="issue-scope">
        <NRadioButton value="chapter" :disabled="chapterId === null">本章</NRadioButton>
        <NRadioButton value="work">全书</NRadioButton>
      </NRadioGroup>
      <NSelect v-model:value="status" :options="statusOptions" size="small" class="status" data-testid="issue-status" />
    </div>
    <div v-if="issues.fixProgress" class="batch fix-progress" data-testid="issue-fix-progress">
      <NSpin size="small" />
      <span>AI 修复中 {{ issues.fixProgress.done }}/{{ issues.fixProgress.total }}</span>
      <NButton size="tiny" secondary data-testid="issue-fix-stop" @click="issues.stopFix()">停止</NButton>
    </div>
    <NSpace v-else-if="fixable.length > 0 || ignorable.length > 0" :size="6" class="batch">
      <NPopconfirm v-if="fixable.length > 0" positive-text="全部修正" negative-text="取消" @positive-click="apply(fixable.map((i) => i.id))">
        <template #trigger>
          <NButton size="small" type="primary" :loading="busy" data-testid="issue-apply-all">采纳全部（{{ fixable.length }}）</NButton>
        </template>
        把{{ scope === 'work' ? '全书' : '本章' }} {{ fixable.length }} 处问题按建议修改？修改前的内容会存为历史版本，也可以在编辑器中撤销。
      </NPopconfirm>
      <NPopconfirm v-if="needsAi > 0" positive-text="全部修复" negative-text="取消" @positive-click="repair(repairable.map((i) => i.id))">
        <template #trigger>
          <NButton size="small" type="primary" secondary :disabled="busy" data-testid="issue-fix-all">全部修复（{{ repairable.length }}）</NButton>
        </template>
        <div class="confirm">
          把{{ scope === 'work' ? '全书' : '本章' }} {{ repairable.length }} 处问题全部修复？<template v-if="fixable.length > 0">{{ fixable.length }} 处按已有建议修改，</template>{{ needsAi }}
          处由 AI 按意见改写（逐条调用模型，需要一些时间）。修改前的内容会存为历史版本，也可以在编辑器中撤销。
        </div>
      </NPopconfirm>
      <NButton v-if="ignorable.length > 0" size="small" quaternary :disabled="busy" data-testid="issue-ignore-all" @click="ignore(ignorable.map((i) => i.id))">
        全部忽略
      </NButton>
    </NSpace>

    <div ref="listEl" class="list">
      <NSpin v-if="issues.loading && issues.items.length === 0" size="small" class="spin" />
      <NEmpty
        v-else-if="visible.length === 0"
        size="small"
        :description="status === 'open' ? (scope === 'chapter' ? '本章没有待处理的问题' : '全书没有待处理的问题') : '没有符合条件的问题'"
        class="empty"
      >
        <template v-if="issues.items.length === 0" #extra>
          <NText depth="3" class="hint">在编辑器顶栏的「AI 检查」中运行检查后，问题会显示在这里并在正文中高亮</NText>
        </template>
      </NEmpty>
      <div
        v-for="i in visible.slice(0, MAX_RENDER)"
        :key="i.id"
        class="item"
        :class="{ active: i.id === issues.selectedId, done: i.status !== 'open' }"
        :data-issue-id="i.id"
        :data-status="i.status"
        data-testid="issue-item"
        @click="locate(i)"
      >
        <div class="row">
          <NTag size="tiny" :type="SEVERITY_TAG_TYPES[i.severity]" :bordered="false">{{ ISSUE_CATEGORY_LABELS[i.category] }}</NTag>
          <span class="change">
            <del class="target">{{ i.target }}</del>
            <template v-if="i.replacement !== null">
              <span class="arrow">→</span>
              <ins class="replacement">{{ i.replacement === '' ? '（删除）' : i.replacement }}</ins>
            </template>
          </span>
          <NTag v-if="i.status !== 'open'" size="tiny" :bordered="false" class="status-tag">{{ ISSUE_STATUS_LABELS[i.status] }}</NTag>
        </div>
        <div class="message">{{ i.message }}</div>
        <div v-if="i.evidence" class="evidence">{{ i.evidence }}</div>
        <div v-if="scope === 'work'" class="where">{{ chapterLabel(i) }}</div>
        <NSpace v-if="i.status === 'open'" size="small" class="actions" @click.stop>
          <NButton v-if="i.replacement !== null" size="tiny" type="primary" secondary :disabled="busy" data-testid="issue-apply" @click="apply([i.id])">采纳</NButton>
          <NTooltip v-else :delay="500">
            <template #trigger>
              <NButton
                size="tiny"
                type="primary"
                secondary
                :disabled="busy && !issues.suggesting.has(i.id)"
                :loading="issues.suggesting.has(i.id)"
                data-testid="issue-fix"
                @click="!fixing && repair([i.id])"
              >
                修复
              </NButton>
            </template>
            由 AI 按意见改写这处文字并修正，可在编辑器中撤销
          </NTooltip>
          <NButton size="tiny" quaternary :disabled="busy" data-testid="issue-ignore" @click="ignore([i.id])">忽略</NButton>
        </NSpace>
      </div>
      <NText v-if="visible.length > MAX_RENDER" depth="3" class="hint more">只显示前 {{ MAX_RENDER }} 条，共 {{ visible.length }} 条</NText>
    </div>
  </aside>
</template>

<style scoped>
.issue-panel {
  width: 340px;
  flex: none;
  display: flex;
  flex-direction: column;
  border-left: 1px solid rgba(127, 127, 127, 0.15);
  min-height: 0;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 12px 12px 6px 16px;
}
.title {
  font-size: 15px;
  font-weight: 600;
}
.count {
  font-size: 12px;
}
.close {
  margin-left: auto;
}
.filters {
  display: flex;
  gap: 8px;
  padding: 4px 16px 8px;
}
.status {
  width: 104px;
}
.batch {
  padding: 0 16px 8px;
}
/* 三个批量按钮在 340px 的面板里排成一行（数量到两位数时也放得下） */
.batch :deep(.n-button) {
  padding: 0 8px;
  font-size: 13px;
}
.batch :deep([data-testid='issue-ignore-all']) {
  padding: 0 6px;
}
.fix-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.confirm {
  max-width: 280px;
}
.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 24px;
}
.spin,
.empty {
  margin-top: 40px;
  display: flex;
  justify-content: center;
}
.hint {
  font-size: 12px;
}
.more {
  display: block;
  text-align: center;
  margin-top: 8px;
}
.item {
  padding: 8px 8px 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  border-left: 3px solid transparent;
}
.item:hover {
  background: rgba(127, 127, 127, 0.08);
}
.item.active {
  background: rgba(240, 160, 32, 0.14);
  border-left-color: #f0a020;
}
.item.done {
  opacity: 0.6;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.change {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.target {
  color: #d03050;
}
.arrow {
  margin: 0 4px;
  opacity: 0.6;
}
.replacement {
  color: #18a058;
  text-decoration: none;
  font-weight: 600;
}
.status-tag {
  margin-left: auto;
}
.message,
.evidence,
.where {
  font-size: 12px;
  line-height: 1.6;
  margin-top: 3px;
  opacity: 0.8;
}
.where {
  opacity: 0.55;
}
.actions {
  margin-top: 6px;
}
</style>
