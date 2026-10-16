<script setup lang="ts">
import { NBadge, NButton, NEmpty, NLayout, NLayoutContent, NLayoutSider, NResult, NSpace, NText, useDialog, useMessage } from 'naive-ui';
import { computed, h, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError } from '../api/client';
import type { JobType } from '../../shared/types';
import BibleDrawer from '../components/BibleDrawer.vue';
import ChapterEditor from '../components/ChapterEditor.vue';
import CheckPanel from '../components/CheckPanel.vue';
import ExpandDrawer from '../components/ExpandDrawer.vue';
import IssuePanel from '../components/IssuePanel.vue';
import MemoryDrawer from '../components/MemoryDrawer.vue';
import OutlineTree from '../components/OutlineTree.vue';
import ReportDrawer from '../components/ReportDrawer.vue';
import TrashDrawer from '../components/TrashDrawer.vue';
import WorkActions from '../components/WorkActions.vue';
import { usePrompt } from '../composables/usePrompt';
import { useBibleStore } from '../stores/bible';
import { useIssuesStore } from '../stores/issues';
import { useJobsStore } from '../stores/jobs';
import { useMemoryStore } from '../stores/memory';
import { useWorkspaceStore } from '../stores/workspace';
import { formatWords } from '../utils/format';

const route = useRoute();
const router = useRouter();
const ws = useWorkspaceStore();
const message = useMessage();
const { prompt } = usePrompt();

const workId = computed(() => String(route.params.workId ?? ''));
const chapterId = computed(() => (typeof route.params.chapterId === 'string' && route.params.chapterId !== '' ? route.params.chapterId : null));
const loadError = ref<string | null>(null);
const trashOpen = ref(false);
const checkOpen = ref(false);
const jobs = useJobsStore();
const issues = useIssuesStore();
const ISSUE_PANEL_KEY = 'ne.issuePanel';
const issuesOpen = ref(localStorage.getItem(ISSUE_PANEL_KEY) === 'open');
watch(issuesOpen, (open) => localStorage.setItem(ISSUE_PANEL_KEY, open ? 'open' : 'closed'));
const outline = ref<InstanceType<typeof OutlineTree> | null>(null);

// 设定库抽屉；从设定库发起抽取时打开检查面板并预选「设定抽取」
const bible = useBibleStore();
const bibleOpen = ref(false);
const checkType = ref<JobType | null>(null);
function openCheck(type: JobType | null = null): void {
  checkType.value = type;
  bibleOpen.value = false;
  checkOpen.value = true;
}

// 审稿报告 / 灵感胶囊抽屉
const reportOpen = ref(false);
const reportJobId = ref<string | null>(null);
function openReport(jobId: string): void {
  reportJobId.value = jobId;
  checkOpen.value = false;
  reportOpen.value = true;
}

// 智能扩写结果、剧情记忆
const expandOpen = ref(false);
const expandJobId = ref<string | null>(null);
function openExpansion(jobId: string): void {
  expandJobId.value = jobId;
  checkOpen.value = false;
  expandOpen.value = true;
}
const memory = useMemoryStore();
const memoryOpen = ref(false);
/** 剧情记忆正在后台更新时，入口按钮上显示一个小圆点。 */
const memoryUpdating = computed(() => jobs.active.some((j) => j.type === 'memory'));
const dialog = useDialog();

/** AI 味检测完成后的「一键优化」：采纳这次检测找到的全部待处理问题（先保存、存修正前版本、可撤销）。 */
function optimizeAll(jobId: string): void {
  const ids = issues.items.filter((i) => i.jobId === jobId && i.status === 'open' && i.replacement !== null).map((i) => i.id);
  if (ids.length === 0) return;
  dialog.warning({
    title: '一键优化',
    content: `按 AI 的改写替换这次检测找到的 ${ids.length} 处 AI 味表达？修改前的内容会存为历史版本，也可以在编辑器中撤销。`,
    positiveText: '全部优化',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const res = await issues.apply(ids);
        if (res.blocked) message.error('当前章节还有没保存成功的内容，请先处理保存问题');
        else message.success(`已优化 ${res.applied.length} 处${res.stale.length > 0 ? `，${res.stale.length} 处原文已改动未修改` : ''}，可在编辑器中撤销`);
      } catch (e) {
        message.error(e instanceof ApiError ? e.message : '优化失败');
      }
    },
  });
}
/** 从报告中点击某条意见：打开问题面板并定位（其他章节的意见会先打开该章）。 */
function locateIssue(issueId: string): void {
  const issue = issues.byId.get(issueId);
  reportOpen.value = false;
  issuesOpen.value = true;
  if (issue === undefined) return;
  issues.select(issueId, { locate: issue.status === 'open' });
  if (issue.chapterId !== chapterId.value) void router.push({ name: 'workspace', params: { workId: workId.value, chapterId: issue.chapterId } });
}

// 本次会话中有检查任务完成时提示结果，发现问题就打开问题面板；审稿完成时提供「查看报告」
const offJobDone = jobs.onJobDone((job) => {
  // 剧情记忆在后台自动更新，不打扰作者；灵感胶囊与智能扩写完成后直接给出结果
  if (job.type === 'memory') {
    void memory.refresh().catch(() => undefined);
    return;
  }
  if (job.type === 'inspiration') {
    message.success(
      () => h('span', ['灵感胶囊已生成：5 条剧情发展路线', h(NButton, { text: true, type: 'primary', 'data-testid': 'inspiration-open-toast', onClick: () => openReport(job.id) }, () => '　查看 ›')]),
      { duration: 10_000, closable: true },
    );
    return;
  }
  if (job.type === 'expand') {
    message.success('扩写完成，请确认后插入章末');
    openExpansion(job.id);
    return;
  }
  void issues
    .refresh()
    .catch(() => undefined)
    .then(() => {
      const n = issues.items.filter((i) => i.jobId === job.id && i.status === 'open').length;
      if (job.type === 'bible_extract') {
        void bible.refresh().then(() => {
          const text = bible.pendingCount > 0 ? `设定抽取完成：${bible.pendingCount} 条候选待审核` : '设定抽取完成：没有新的设定';
          message.success(
            () => h('span', [text, h(NButton, { text: true, type: 'primary', 'data-testid': 'bible-open-toast', onClick: () => (bibleOpen.value = true) }, () => '　去审核 ›')]),
            { duration: 10_000, closable: true },
          );
        });
        return;
      }
      if (job.type === 'review') {
        const text = n > 0 ? `审稿完成：${n} 条修改意见` : '审稿完成';
        message.success(
          () => h('span', [text, h(NButton, { text: true, type: 'primary', class: 'report-link', 'data-testid': 'report-open-toast', onClick: () => openReport(job.id) }, () => '　查看报告 ›')]),
          { duration: 10_000, closable: true },
        );
      } else if (job.type === 'ai_flavor' && n > 0) {
        message.success(
          () =>
            h('span', [
              `AI 味检测完成：发现 ${n} 处`,
              h(NButton, { text: true, type: 'primary', 'data-testid': 'ai-flavor-optimize-toast', onClick: () => optimizeAll(job.id) }, () => '　一键优化 ›'),
            ]),
          { duration: 15_000, closable: true },
        );
      } else if (job.type === 'ai_flavor') {
        message.success('AI 味检测完成：没有发现明显的 AI 味');
      } else {
        message.success(n > 0 ? `检查完成：发现 ${n} 处问题` : '检查完成：没有发现问题');
      }
      if (n > 0) issuesOpen.value = true;
    });
});

async function load(): Promise<void> {
  loadError.value = null;
  try {
    await ws.open(workId.value);
    void jobs.open(workId.value).catch(() => undefined);
    void issues.openWork(workId.value).catch(() => undefined);
    void bible.openWork(workId.value).catch(() => undefined);
    void memory.openWork(workId.value).catch(() => undefined);
    if (chapterId.value === null || ws.locate(chapterId.value) === null) {
      const first = ws.volumes.find((v) => v.chapters.length > 0)?.chapters[0];
      if (first !== undefined) void router.replace({ name: 'workspace', params: { workId: workId.value, chapterId: first.id } });
    }
  } catch (e) {
    loadError.value = e instanceof ApiError && e.status === 404 ? '作品不存在或已被删除' : e instanceof ApiError ? e.message : '打开作品失败';
  }
}

watch(workId, () => void load(), { immediate: true });
watch(
  () => ws.tree,
  () => {
    if (chapterId.value !== null && ws.tree !== null && ws.locate(chapterId.value) === null) {
      void router.replace({ name: 'workspace', params: { workId: workId.value } });
    }
  },
);
onBeforeUnmount(() => {
  offJobDone();
  ws.close();
  jobs.close();
  issues.close();
  bible.close();
  memory.close();
});

function select(id: string): void {
  if (id !== chapterId.value) void router.push({ name: 'workspace', params: { workId: workId.value, chapterId: id } });
}

async function newVolume(): Promise<void> {
  const title = await prompt({ title: '新建分卷', initial: `第${ws.volumes.length + 1}卷` });
  if (title === null) return;
  try {
    await ws.createVolume(title);
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '新建分卷失败');
  }
}

async function newChapter(): Promise<void> {
  const current = chapterId.value === null ? null : ws.locate(chapterId.value);
  const volume = current?.volume ?? ws.volumes.at(-1);
  if (volume === undefined) {
    message.warning('请先新建一个分卷');
    return;
  }
  await outline.value?.newChapter(volume.id, current?.chapter.id ?? volume.chapters.at(-1)?.id ?? null);
}
</script>

<template>
  <NResult v-if="loadError" status="404" :title="loadError" class="load-error">
    <template #footer>
      <NButton @click="router.push({ name: 'library' })">返回作品库</NButton>
    </template>
  </NResult>
  <NLayout v-else has-sider class="workspace">
    <NLayoutSider bordered :width="300" content-style="display:flex;flex-direction:column;height:100%" class="sider">
      <div class="sider-head">
        <NButton quaternary size="small" @click="router.push({ name: 'library' })">‹ 作品库</NButton>
        <div class="work-title" data-testid="work-heading">{{ ws.tree?.work.title ?? '…' }}</div>
        <NText depth="3" class="work-stats">{{ formatWords(ws.totalWords) }}</NText>
      </div>
      <NSpace class="sider-tools" size="small">
        <NButton size="small" data-testid="new-volume" @click="newVolume">新建分卷</NButton>
        <NButton size="small" data-testid="new-chapter" @click="newChapter">新建章节</NButton>
        <NBadge :value="bible.pendingCount" :show="bible.pendingCount > 0" :max="999" type="info">
          <NButton size="small" quaternary data-testid="bible-open" @click="bibleOpen = true">设定库</NButton>
        </NBadge>
        <NBadge :show="memoryUpdating" dot processing type="success">
          <NButton size="small" quaternary data-testid="memory-open" @click="memoryOpen = true">剧情记忆</NButton>
        </NBadge>
        <NBadge :value="issues.openCount" :show="issues.openCount > 0" :max="999" type="warning">
          <NButton size="small" :type="issuesOpen ? 'primary' : 'default'" quaternary data-testid="issues-toggle" @click="issuesOpen = !issuesOpen">问题</NButton>
        </NBadge>
      </NSpace>
      <div class="sider-tree">
        <NEmpty v-if="ws.tree && ws.volumes.length === 0" description="还没有分卷" size="small" />
        <OutlineTree v-else ref="outline" :selected-chapter-id="chapterId" @select="select" />
      </div>
    </NLayoutSider>
    <NLayoutContent class="main" content-style="height:100%;display:flex">
      <div class="editor-area">
        <ChapterEditor v-if="chapterId && ws.tree" :key="chapterId" :work-id="workId" :chapter-id="chapterId">
          <template #actions>
            <WorkActions :work-id="workId" @check="openCheck()" @trash="trashOpen = true" />
          </template>
        </ChapterEditor>
        <template v-else-if="ws.tree">
          <!-- 没有打开章节时（如刚删除了当前章节）作品级操作仍然可用，回收站可以恢复 -->
          <header class="bar">
            <WorkActions :work-id="workId" @check="openCheck()" @trash="trashOpen = true" />
          </header>
          <NEmpty description="在左侧选择或新建一个章节" class="placeholder" />
        </template>
      </div>
      <IssuePanel v-if="issuesOpen && ws.tree" :work-id="workId" :chapter-id="chapterId" @close="issuesOpen = false" />
    </NLayoutContent>
    <TrashDrawer v-model:show="trashOpen" />
    <CheckPanel v-model:show="checkOpen" :work-id="workId" :chapter-id="chapterId" :initial-type="checkType" @report="openReport" @expansion="openExpansion" />
    <BibleDrawer v-model:show="bibleOpen" :work-id="workId" @extract="openCheck('bible_extract')" />
    <ReportDrawer v-model:show="reportOpen" :work-id="workId" :job-id="reportJobId" @locate="locateIssue" />
    <ExpandDrawer v-model:show="expandOpen" :work-id="workId" :job-id="expandJobId" />
    <MemoryDrawer v-model:show="memoryOpen" :work-id="workId" />
  </NLayout>
</template>

<style scoped>
.workspace {
  height: 100%;
}
.sider-head {
  padding: 12px 12px 4px;
}
.work-title {
  font-size: 17px;
  font-weight: 600;
  margin: 6px 4px 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.work-stats {
  margin-left: 4px;
  font-size: 12px;
}
.sider-tools {
  padding: 8px 12px;
}
.sider-tree {
  flex: 1;
  min-height: 0;
  padding: 0 4px 8px;
}
.main {
  height: 100%;
}
.editor-area {
  flex: 1;
  min-width: 0;
  height: 100%;
}
/* 与章节编辑器顶栏同高，操作按钮位置不变 */
.bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-height: 49px;
  padding: 10px 20px;
  border-bottom: 1px solid rgba(127, 127, 127, 0.15);
}
.placeholder {
  padding-top: 20vh;
}
.load-error {
  padding-top: 15vh;
}
</style>
