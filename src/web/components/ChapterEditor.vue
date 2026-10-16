<script setup lang="ts">
import { NButton, NDivider, NEmpty, NSpace, NSpin, NSwitch, NTag, NTooltip, useMessage } from 'naive-ui';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { resolveAnchor } from '../../shared/anchor';
import { countWords } from '../../shared/text';
import type { Chapter, Issue, ServerEvent } from '../../shared/types';
import { ApiError } from '../api/client';
import { worksApi } from '../api/works';
import { usePrompt } from '../composables/usePrompt';
import { drafts, type StoredDraft } from '../drafts/db';
import { applyFixToEditor, createWriterEditor, replaceDocMinimal, revealRange, type WriterEditor } from '../editor/codemirror';
import { issueRange, setActiveIssue, setIssueMarks, type IssueMark } from '../editor/issue-marks';
import { SaveController, decideDraftRecovery, type ConflictInfo, type DraftDecision, type SaveStatus } from '../editor/save-controller';
import { useIssuesStore } from '../stores/issues';
import { useSystemStore } from '../stores/system';
import { useWorkspaceStore } from '../stores/workspace';
import CompareModal from './CompareModal.vue';
import RevisionDrawer from './RevisionDrawer.vue';

const props = defineProps<{ workId: string; chapterId: string }>();
const ws = useWorkspaceStore();
const system = useSystemStore();
const message = useMessage();
const { prompt } = usePrompt();

type Mode = 'rich' | 'plain';
const MODE_KEY = 'ne.editorMode';
const INDENT_KEY = 'ne.editorIndent';

const chapter = ref<Chapter | null>(null);
const loadError = ref<string | null>(null);
const status = ref<SaveStatus>('saved');
const statusDetail = ref<string | null>(null);
const words = ref(0);
const mode = ref<Mode>(localStorage.getItem(MODE_KEY) === 'plain' ? 'plain' : 'rich');
const indent = ref(localStorage.getItem(INDENT_KEY) !== 'off');
const conflict = ref<ConflictInfo | null>(null);
const draftAsk = ref<{ draft: StoredDraft; server: Chapter } | null>(null);
const revisionsOpen = ref(false);
const recovery = ref<DraftDecision | null>(null);
const host = ref<HTMLElement | null>(null);
const plain = ref<HTMLTextAreaElement | null>(null);
const editor = shallowRef<WriterEditor | null>(null);
let controller: SaveController | null = null;
let wordTimer: ReturnType<typeof setTimeout> | null = null;
let offEvents: (() => void) | null = null;
let offBridge: (() => void) | null = null;
/** 一键修正进行中：chapter.updated 由 afterFix 负责同步。 */
let fixing = false;
const issues = useIssuesStore();

/** 把当前章节「待处理」的问题按编辑器当前正文重新定位后高亮（正文可能有未保存的改动）。 */
function pushMarks(): void {
  const view = editor.value?.view;
  if (view === undefined) return;
  const doc = view.state.doc.toString();
  const marks: IssueMark[] = [];
  for (const i of issues.openInChapter(props.chapterId)) {
    const r = resolveAnchor(doc, i);
    if (r !== null) marks.push({ id: i.id, from: r.start, to: r.end, severity: i.severity });
  }
  const active = issues.selectedId !== null && marks.some((m) => m.id === issues.selectedId) ? issues.selectedId : null;
  view.dispatch({ effects: [setActiveIssue.of(active), setIssueMarks.of(marks)] });
}

function locateIssue(issue: Issue): void {
  const view = editor.value?.view;
  if (mode.value === 'rich' && view !== undefined) {
    const r = issueRange(view.state, issue.id) ?? (() => {
      const hit = resolveAnchor(view.state.doc.toString(), issue);
      return hit === null ? null : { from: hit.start, to: hit.end };
    })();
    if (r === null) {
      message.warning('原文已改动，找不到这处问题');
      return;
    }
    revealRange(view, r.from, r.to, issue.id);
  } else if (plain.value !== null) {
    const hit = resolveAnchor(plain.value.value, issue);
    if (hit === null) {
      message.warning('原文已改动，找不到这处问题');
      return;
    }
    plain.value.focus();
    plain.value.setSelectionRange(hit.start, hit.end);
  }
}

/** 修正已写入服务端：拉取新正文，作为一次可撤销的修改写进编辑器（不会再触发一次保存）。 */
async function afterFix(applied: Issue[]): Promise<void> {
  if (controller === null) return;
  const fresh = await worksApi.getChapter(props.workId, props.chapterId);
  const view = editor.value?.view;
  const changes =
    view === undefined
      ? []
      : applied.flatMap((i) => {
          const r = issueRange(view.state, i.id);
          return r !== null && view.state.sliceDoc(r.from, r.to) === i.target ? [{ from: r.from, to: r.to, insert: i.replacement ?? '' }] : [];
        });
  if (!controller.replaceFromServer(fresh.body, fresh.rev)) return;
  if (mode.value === 'rich' && view !== undefined) applyFixToEditor(view, changes, fresh.body);
  if (plain.value !== null) plain.value.value = fresh.body;
  words.value = countWords(fresh.body);
  ws.patchChapter(props.chapterId, { wordCount: fresh.wordCount, updatedAt: fresh.updatedAt });
}

watch(() => issues.items, pushMarks);
watch(
  () => issues.selectedId,
  (id) => {
    const view = editor.value?.view;
    if (view !== undefined && (id === null || issues.byId.get(id)?.chapterId === props.chapterId)) view.dispatch({ effects: setActiveIssue.of(id) });
  },
);

const STATUS_TEXT: Record<SaveStatus, { text: string; type: 'success' | 'default' | 'info' | 'warning' | 'error' }> = {
  saved: { text: '已保存', type: 'success' },
  dirty: { text: '未保存', type: 'default' },
  saving: { text: '保存中…', type: 'info' },
  offline: { text: '未连接，内容已存在浏览器草稿', type: 'warning' },
  conflict: { text: '有冲突，等待处理', type: 'error' },
  unauthorized: { text: '会话已失效，内容已存在浏览器草稿', type: 'error' },
  error: { text: '保存失败', type: 'error' },
};
const statusView = computed(() => STATUS_TEXT[status.value]);

function updateWords(body: string): void {
  if (wordTimer !== null) clearTimeout(wordTimer);
  wordTimer = setTimeout(() => (words.value = countWords(body)), 150);
}

function onEditorChange(body: string): void {
  controller?.change(body);
  updateWords(body);
}

/** 把控制器中的正文同步到当前编辑器（冲突处理、恢复版本、外部更新后调用）。 */
function showBody(body: string): void {
  if (editor.value !== null) replaceDocMinimal(editor.value.view, body);
  if (plain.value !== null && plain.value.value !== body) plain.value.value = body;
  words.value = countWords(body);
  pushMarks();
}

function mountEditor(): void {
  editor.value?.destroy();
  editor.value = null;
  const body = controller?.body ?? '';
  if (mode.value === 'rich' && host.value !== null) {
    editor.value = createWriterEditor(host.value, {
      doc: body,
      indent: indent.value,
      onChange: onEditorChange,
      onBlur: () => void controller?.flush(),
      onIssueClick: (id) => issues.select(id, { locate: false }),
    });
    pushMarks();
  } else if (mode.value === 'plain' && plain.value !== null) {
    plain.value.value = body;
  }
}

function saveKeepalive(body: string, baseRev: number): void {
  void fetch(`/api/works/${encodeURIComponent(props.workId)}/chapters/${encodeURIComponent(props.chapterId)}/body`, {
    method: 'PUT',
    keepalive: true,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, baseRev }),
  }).catch(() => undefined);
}

function createController(server: Chapter): SaveController {
  const { workId, chapterId } = props;
  return new SaveController(
    { body: server.body, rev: server.rev },
    {
      save: (body, baseRev) => worksApi.saveBody(workId, chapterId, { body, baseRev }),
      saveKeepalive,
      putDraft: (d) => drafts.put(workId, chapterId, d).catch(() => undefined),
      removeDraft: () => drafts.remove(workId, chapterId).catch(() => undefined),
      onStatus: (s, detail) => {
        status.value = s;
        statusDetail.value = detail;
      },
      onSaved: (res) => ws.patchChapter(chapterId, { wordCount: res.wordCount, updatedAt: res.updatedAt }),
      onConflict: (info) => (conflict.value = info),
    },
  );
}

async function onServerEvent(e: ServerEvent): Promise<void> {
  if (e.type !== 'chapter.updated' || e.chapterId !== props.chapterId || controller === null || fixing) return;
  if (controller.dirty || e.rev <= controller.baseRev) return;
  try {
    const fresh = await worksApi.getChapter(props.workId, props.chapterId);
    if (controller.replaceFromServer(fresh.body, fresh.rev)) showBody(fresh.body);
  } catch {
    // 下次保存时会通过 409 发现并处理
  }
}

function onPageHide(): void {
  controller?.pageHide();
}
function onVisibility(): void {
  if (document.visibilityState === 'hidden') void controller?.flush();
}

onMounted(async () => {
  let server: Chapter;
  try {
    server = await worksApi.getChapter(props.workId, props.chapterId);
  } catch (e) {
    loadError.value = e instanceof ApiError ? e.message : '读取章节失败';
    return;
  }
  const draft = await drafts.get(props.workId, props.chapterId).catch(() => null);
  chapter.value = server;
  controller = createController(server);
  words.value = countWords(server.body);
  await nextTick();
  mountEditor();

  recovery.value = decideDraftRecovery(server, draft);
  switch (recovery.value) {
    case 'discard':
      void drafts.remove(props.workId, props.chapterId).catch(() => undefined);
      break;
    case 'restore':
      applyDraft(draft!.body);
      message.info('已从浏览器草稿恢复上次未保存的内容', { duration: 6000 });
      break;
    case 'ask':
      draftAsk.value = { draft: draft!, server };
      break;
    case 'none':
      break;
  }

  offEvents = system.onServerEvent((e) => void onServerEvent(e));
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibility);
  offBridge = issues.registerEditor({
    chapterId: props.chapterId,
    flush: async () => {
      if (controller === null) return false;
      await controller.flush();
      return !controller.dirty && controller.status === 'saved';
    },
    setFixing: (on) => (fixing = on),
    afterFix,
    locate: locateIssue,
  });
});

onBeforeUnmount(() => {
  offEvents?.();
  offBridge?.();
  window.removeEventListener('pagehide', onPageHide);
  document.removeEventListener('visibilitychange', onVisibility);
  if (wordTimer !== null) clearTimeout(wordTimer);
  void controller?.dispose();
  editor.value?.destroy();
});

function applyDraft(body: string): void {
  showBody(body);
  controller?.change(body);
  void controller?.flush();
}

function chooseDraft(side: 'left' | 'right'): void {
  const ask = draftAsk.value;
  draftAsk.value = null;
  if (ask === null) return;
  if (side === 'left') applyDraft(ask.draft.body);
  else void drafts.remove(props.workId, props.chapterId).catch(() => undefined);
}

function chooseConflict(side: 'left' | 'right'): void {
  const c = conflict.value;
  conflict.value = null;
  if (c === null || controller === null) return;
  showBody(controller.resolveConflict(side === 'left' ? 'mine' : 'theirs', c.server));
}

function onPlainInput(e: Event): void {
  onEditorChange((e.target as HTMLTextAreaElement).value);
}

async function switchMode(plainMode: boolean): Promise<void> {
  await controller?.flush();
  mode.value = plainMode ? 'plain' : 'rich';
  localStorage.setItem(MODE_KEY, mode.value);
  await nextTick();
  mountEditor();
}

function toggleIndent(on: boolean): void {
  indent.value = on;
  localStorage.setItem(INDENT_KEY, on ? 'on' : 'off');
  editor.value?.setIndent(on);
}

async function rename(): Promise<void> {
  if (chapter.value === null) return;
  const title = await prompt({ title: '重命名章节', initial: chapter.value.title });
  if (title === null) return;
  try {
    await ws.renameChapter(props.chapterId, title);
    chapter.value = { ...chapter.value, title };
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '重命名失败');
  }
}

async function snapshot(): Promise<void> {
  try {
    await controller?.flush();
    await worksApi.createRevision(props.workId, props.chapterId);
    message.success('已存为版本');
    await revisionDrawer.value?.reload();
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '存版本失败');
  }
}

async function restoreRevision(revisionId: number): Promise<void> {
  if (controller === null) return;
  await controller.flush();
  if (controller.status === 'conflict' || controller.status === 'unauthorized') {
    message.error('请先处理当前的保存问题');
    return;
  }
  try {
    await worksApi.restoreRevision(props.workId, props.chapterId, revisionId, controller.baseRev);
    const fresh = await worksApi.getChapter(props.workId, props.chapterId);
    if (controller.replaceFromServer(fresh.body, fresh.rev)) showBody(fresh.body);
    chapter.value = fresh;
    ws.patchChapter(props.chapterId, { title: fresh.title, wordCount: fresh.wordCount, updatedAt: fresh.updatedAt });
    revisionsOpen.value = false;
    message.success('已恢复该版本');
  } catch (e) {
    message.error(e instanceof ApiError ? e.message : '恢复失败');
  }
}

const revisionDrawer = ref<InstanceType<typeof RevisionDrawer> | null>(null);
</script>

<template>
  <div class="chapter-editor" data-testid="chapter-editor" :data-recovery="recovery ?? ''">
    <!-- 顶栏始终显示：作品级操作（actions 插槽）在章节加载中、加载失败时也可用 -->
    <header class="bar">
      <div v-if="chapter" class="title" data-testid="chapter-title" @dblclick="rename">{{ chapter.title }}</div>
      <div v-else class="title">{{ ws.locate(chapterId)?.chapter.title ?? '' }}</div>
      <NSpace align="center" justify="end" size="small" class="tools">
        <slot name="actions" />
        <template v-if="chapter">
          <NDivider v-if="$slots.actions" vertical />
          <NTooltip :disabled="!statusDetail">
            <template #trigger>
              <NTag size="small" round :bordered="false" :type="statusView.type" data-testid="save-status" :data-status="status">{{ statusView.text }}</NTag>
            </template>
            {{ statusDetail }}
          </NTooltip>
          <span class="words" data-testid="word-count">{{ words }} 字</span>
          <NButton size="small" quaternary @click="rename">重命名</NButton>
          <NButton size="small" quaternary data-testid="open-revisions" @click="revisionsOpen = true">历史版本</NButton>
          <NTooltip>
            <template #trigger>
              <span class="switch"><NSwitch size="small" :value="indent" :disabled="mode === 'plain'" @update:value="toggleIndent" /> 缩进</span>
            </template>
            段首空两格（只影响显示，不改动正文）
          </NTooltip>
          <NTooltip>
            <template #trigger>
              <span class="switch"><NSwitch size="small" :value="mode === 'plain'" data-testid="plain-mode" @update:value="switchMode" /> 纯文本</span>
            </template>
            输入法异常时可切换到纯文本模式（不支持问题高亮）
          </NTooltip>
        </template>
      </NSpace>
    </header>
    <NEmpty v-if="loadError" :description="loadError" class="center" />
    <div v-else-if="!chapter" class="center"><NSpin /></div>
    <template v-else>
      <div v-show="mode === 'rich'" ref="host" class="host" />
      <textarea v-if="mode === 'plain'" ref="plain" class="plain" spellcheck="false" data-testid="plain-editor" @input="onPlainInput" @blur="controller?.flush()" />
    </template>

    <RevisionDrawer
      ref="revisionDrawer"
      v-model:show="revisionsOpen"
      :work-id="workId"
      :chapter-id="chapterId"
      @restore="restoreRevision"
      @snapshot="snapshot"
    />
    <CompareModal
      :show="conflict !== null"
      title="保存冲突"
      description="这一章在其他标签页或窗口中也被修改并保存了。请选择要保留的版本，另一份不会自动合并。"
      left-label="我在这里写的"
      :left="conflict?.mine ?? ''"
      left-action="保留我的"
      right-label="已保存的版本"
      :right="conflict?.server.body ?? ''"
      right-action="使用已保存的版本"
      @choose="chooseConflict"
    />
    <CompareModal
      :show="draftAsk !== null"
      title="发现未保存的草稿"
      description="浏览器里有一份上次没来得及保存的草稿，但这一章之后又在别处被修改过。请选择要保留的版本。"
      left-label="浏览器草稿"
      :left="draftAsk?.draft.body ?? ''"
      left-action="恢复草稿"
      right-label="已保存的版本"
      :right="draftAsk?.server.body ?? ''"
      right-action="丢弃草稿"
      @choose="chooseDraft"
    />
  </div>
</template>

<style scoped>
.chapter-editor {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.center {
  padding-top: 20vh;
  display: flex;
  justify-content: center;
}
.bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 12px;
  min-height: 49px;
  padding: 10px 20px;
  border-bottom: 1px solid rgba(127, 127, 127, 0.15);
}
.title {
  /* 基准宽度为 0：长标题省略显示，不会把右侧按钮挤到下一行 */
  flex: 1 1 0;
  min-width: 0;
  font-size: 17px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 窗口较窄时整组换到下一行，仍然靠右 */
.tools {
  margin-left: auto;
}
.words {
  font-size: 13px;
  opacity: 0.65;
  min-width: 56px;
  text-align: right;
  white-space: nowrap;
}
.switch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  font-size: 13px;
  opacity: 0.85;
}
.host {
  flex: 1;
  min-height: 0;
}
.plain {
  flex: 1;
  min-height: 0;
  border: none;
  outline: none;
  resize: none;
  padding: 24px max(32px, calc((100% - 46em) / 2)) 40vh;
  font-size: 18px;
  line-height: 1.9;
  font-family: inherit;
  background: transparent;
  color: inherit;
}
</style>
