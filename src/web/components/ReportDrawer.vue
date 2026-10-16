<script setup lang="ts">
import { NAlert, NButton, NDrawer, NDrawerContent, NEmpty, NSpin, NTabPane, NTabs, NTag, NText } from 'naive-ui';
import { computed, ref, watch } from 'vue';
import type { Issue, JobReport } from '../../shared/types';
import { ApiError } from '../api/client';
import { jobsApi } from '../api/jobs';
import { useIssuesStore } from '../stores/issues';
import { useJobsStore } from '../stores/jobs';
import { useWorkspaceStore } from '../stores/workspace';
import { formatTime } from '../utils/format';
import { ISSUE_STATUS_LABELS, SEVERITY_TAG_TYPES } from '../utils/labels';
import MarkdownView from './MarkdownView.vue';

/** 审稿报告：整体报告 + 逐章评语；逐章下列出本任务在该章的审稿意见（与问题面板共用同一份问题数据）。 */
const props = defineProps<{ show: boolean; workId: string; jobId: string | null }>();
const emit = defineEmits<{ 'update:show': [boolean]; locate: [issueId: string] }>();

const ws = useWorkspaceStore();
const jobs = useJobsStore();
const issues = useIssuesStore();

const report = ref<JobReport | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const tab = ref<'overall' | 'chapters'>('overall');

const job = computed(() => jobs.jobs.find((j) => j.id === props.jobId) ?? null);
/** 灵感胶囊与审稿报告共用这个查看界面：只有整体报告，没有逐章意见。 */
const inspiration = computed(() => job.value?.type === 'inspiration');
const inspirationChapter = computed(() => {
  const j = job.value;
  if (j === null || j.scope.kind !== 'chapter') return '';
  const c = ws.locate(j.scope.id);
  return c === null ? '' : `${c.volume.title} · ${c.chapter.title}`;
});

async function load(): Promise<void> {
  const id = props.jobId;
  if (id === null) return;
  loading.value = true;
  error.value = null;
  try {
    const r = await jobsApi.report(props.workId, id);
    if (props.jobId === id) report.value = r;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '读取审稿报告失败';
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.show, props.jobId] as const,
  ([show]) => {
    if (!show) return;
    report.value = null;
    tab.value = 'overall';
    void load();
  },
  { immediate: true },
);
// 任务在打开报告期间完成时重新读取
watch(
  () => job.value?.status,
  (s, prev) => {
    if (props.show && s === 'done' && prev !== undefined && prev !== 'done') void load();
  },
);

const jobIssues = computed(() => issues.items.filter((i) => i.jobId === props.jobId && i.category === 'review'));

interface ChapterEntry {
  chapterId: string;
  label: string;
  markdown: string | null;
  issues: Issue[];
}

/** 按目录顺序列出有评语或有意见的章节（已删除的章节不显示）。 */
const chapters = computed<ChapterEntry[]>(() => {
  const comments = new Map((report.value?.chapters ?? []).map((c) => [c.chapterId, c.markdown]));
  const byChapter = new Map<string, Issue[]>();
  for (const i of jobIssues.value) {
    const list = byChapter.get(i.chapterId);
    if (list === undefined) byChapter.set(i.chapterId, [i]);
    else list.push(i);
  }
  const out: ChapterEntry[] = [];
  for (const v of ws.volumes) {
    for (const c of v.chapters) {
      const markdown = comments.get(c.id) ?? null;
      const list = byChapter.get(c.id) ?? [];
      if (markdown === null && list.length === 0) continue;
      out.push({ chapterId: c.id, label: `${v.title} · ${c.title}`, markdown, issues: list });
    }
  }
  return out;
});

const openCount = computed(() => jobIssues.value.filter((i) => i.status === 'open').length);
</script>

<template>
  <NDrawer :show="show" :width="680" placement="right" @update:show="emit('update:show', $event)">
    <NDrawerContent closable :native-scrollbar="false" data-testid="report-drawer">
      <template #header>
        <span data-testid="report-title">{{ inspiration ? '灵感胶囊' : '审稿报告' }}</span>
        <NText v-if="job && inspiration" depth="3" class="sub">{{ formatTime(job.createdAt) }}<template v-if="inspirationChapter"> · 接在「{{ inspirationChapter }}」之后</template></NText>
        <NText v-else-if="job" depth="3" class="sub">{{ formatTime(job.createdAt) }} · {{ chapters.length }} 章 · 待处理意见 {{ openCount }} 条</NText>
      </template>
      <NAlert v-if="job && job.status !== 'done'" type="info" class="gap" :show-icon="false">
        {{ inspiration ? '还在构思中，完成后自动显示。' : '任务尚未完成，报告只包含已审读的部分。' }}
      </NAlert>
      <NAlert v-if="error" type="error" class="gap" :show-icon="false">{{ error }}</NAlert>
      <NSpin v-if="loading && report === null" class="spin" />
      <template v-else-if="report && inspiration">
        <NAlert type="info" class="gap" :show-icon="false">
          以下路线只是构思参考，不会改动正文。选中一条后可以自己写，也可以在「AI 检查 → 智能扩写」中让 AI 先续写当前章节。
        </NAlert>
        <MarkdownView v-if="report.overall" :source="report.overall" data-testid="report-overall" />
        <NEmpty v-else description="还没有结果" class="empty" />
      </template>
      <NTabs v-else-if="report" v-model:value="tab" type="line" animated>
        <NTabPane name="overall" tab="整体报告" display-directive="show">
          <MarkdownView v-if="report.overall" :source="report.overall" data-testid="report-overall" />
          <NEmpty v-else description="还没有整体报告：任务未完成，或没有可汇总的意见" class="empty" />
        </NTabPane>
        <NTabPane name="chapters" :tab="`逐章意见（${chapters.length}）`" display-directive="show">
          <NEmpty v-if="chapters.length === 0" description="没有逐章意见" class="empty" />
          <section v-for="c in chapters" :key="c.chapterId" class="chapter" data-testid="report-chapter" :data-chapter-id="c.chapterId">
            <h4 class="chapter-title">{{ c.label }}</h4>
            <MarkdownView v-if="c.markdown" :source="c.markdown" />
            <div v-if="c.issues.length > 0" class="issues">
              <div
                v-for="i in c.issues"
                :key="i.id"
                class="issue"
                :class="{ done: i.status !== 'open' }"
                data-testid="report-issue"
                :data-issue-id="i.id"
                @click="emit('locate', i.id)"
              >
                <NTag size="tiny" :type="SEVERITY_TAG_TYPES[i.severity]" :bordered="false">{{ i.severity === 'warning' ? '建议修改' : '可优化' }}</NTag>
                <span class="target">「{{ i.target }}」</span>
                <span class="message">{{ i.message }}</span>
                <NTag v-if="i.status !== 'open'" size="tiny" :bordered="false">{{ ISSUE_STATUS_LABELS[i.status] }}</NTag>
              </div>
            </div>
          </section>
        </NTabPane>
      </NTabs>
      <template #footer>
        <NButton size="small" quaternary :loading="loading" data-testid="report-reload" @click="load">刷新</NButton>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.sub {
  margin-left: 10px;
  font-size: 12px;
  font-weight: normal;
}
.gap {
  margin-bottom: 12px;
}
.spin,
.empty {
  margin-top: 48px;
  display: flex;
  justify-content: center;
}
.chapter {
  padding: 12px 0 16px;
  border-bottom: 1px solid rgba(127, 127, 127, 0.15);
}
.chapter-title {
  margin: 0 0 8px;
  font-size: 15px;
}
.issues {
  margin-top: 8px;
}
.issue {
  display: flex;
  gap: 6px;
  align-items: baseline;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1.6;
}
.issue:hover {
  background: rgba(127, 127, 127, 0.08);
}
.issue.done {
  opacity: 0.55;
}
.target {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #d03050;
}
.message {
  flex: 1;
  min-width: 0;
}
</style>
