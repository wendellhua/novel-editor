import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import type { ApplyIssuesResponse, Id, Issue } from '../../shared/types';
import { ApiError } from '../api/client';
import { issuesApi } from '../api/issues';
import { useSystemStore } from './system';

/** 当前打开的章节编辑器向问题面板提供的能力（同一时刻最多一个）。 */
export interface EditorBridge {
  chapterId: string;
  /** 保存未保存的改动。无法保存（冲突、离线、会话失效）时返回 false，此时不应修正。 */
  flush(): Promise<boolean>;
  /** 修正期间暂停处理 chapter.updated，由 afterFix 负责同步。 */
  setFixing(on: boolean): void;
  /** 修正写入服务端之后，把新正文作为一次可撤销的修改同步到编辑器。 */
  afterFix(applied: Issue[]): Promise<void>;
  /** 在编辑器中选中并滚动到该问题。 */
  locate(issue: Issue): void;
}

export interface FixOutcome extends ApplyIssuesResponse {
  /** 编辑器无法保存而放弃修正。 */
  blocked: boolean;
}

export interface AutoFixOutcome extends FixOutcome {
  /** 由 AI 生成了修改建议的问题。 */
  rewritten: Id[];
  /** AI 没能给出修改建议的问题及原因。 */
  failed: { id: Id; message: string }[];
  /** 因连续失败而没有尝试的问题数。 */
  skipped: number;
  /** 作者中途停止：已生成的建议保留在问题上，正文不改。 */
  stopped: boolean;
}

/** AI 修复时同时进行的请求数（服务端还受模型配置的并发上限约束）。 */
const FIX_CONCURRENCY = 3;
/** 一条都没成功、却连续失败这么多条时停止（多半是模型配置问题，后面的也会失败）。 */
const FIX_GIVE_UP_AFTER = 3;

/**
 * 当前作品的检查问题。读取全部状态的问题，界面按范围与状态筛选；任务有进展时（job.updated）节流刷新。
 * 编辑器高亮只取当前章节「待处理」的问题，并在本地正文上重新定位（shared/anchor resolveAnchor）。
 */
export const useIssuesStore = defineStore('issues', () => {
  const workId = ref<string | null>(null);
  const items = shallowRef<Issue[]>([]);
  const loading = ref(false);
  const selectedId = ref<string | null>(null);
  /** 切换章节后等待编辑器就绪再定位的问题。 */
  const pendingLocate = ref<string | null>(null);
  const bridge = shallowRef<EditorBridge | null>(null);
  let unsubscribe: (() => void) | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  const open = computed(() => items.value.filter((i) => i.status === 'open'));
  const openCount = computed(() => open.value.length);
  const byId = computed(() => new Map(items.value.map((i) => [i.id, i])));
  const openInChapter = (chapterId: string): Issue[] => open.value.filter((i) => i.chapterId === chapterId);

  let applied = 0;

  /**
   * 重新读取。并发调用时，较早发出、较晚返回的结果不会覆盖较新的结果；
   * 每次调用返回时，items 一定不旧于这次请求读到的数据（调用方可以紧接着读取 items）。
   */
  async function refresh(): Promise<void> {
    const id = workId.value;
    if (id === null) return;
    const mine = ++seq;
    loading.value = true;
    try {
      const list = await issuesApi.list(id);
      if (mine > applied && workId.value === id) {
        applied = mine;
        items.value = list;
      }
    } finally {
      if (mine === seq) loading.value = false;
    }
  }

  function scheduleRefresh(delayMs = 600): void {
    if (refreshTimer !== null) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh().catch(() => undefined);
    }, delayMs);
  }

  async function openWork(id: string): Promise<void> {
    if (workId.value !== id) {
      items.value = [];
      selectedId.value = null;
      pendingLocate.value = null;
    }
    workId.value = id;
    unsubscribe?.();
    unsubscribe = useSystemStore().onServerEvent((e) => {
      if (e.type === 'job.updated' && e.workId === workId.value) scheduleRefresh(e.job.status === 'running' ? 600 : 0);
    });
    await refresh();
  }

  function close(): void {
    fixController?.abort();
    unsubscribe?.();
    unsubscribe = null;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = null;
    workId.value = null;
    items.value = [];
    applied = seq;
    selectedId.value = null;
    pendingLocate.value = null;
  }

  function requireWork(): string {
    if (workId.value === null) throw new Error('尚未打开作品');
    return workId.value;
  }

  /** 选中问题；同一章节已打开时立即在编辑器中定位，否则等编辑器打开该章后定位。 */
  function select(issueId: string, opts: { locate?: boolean } = {}): void {
    selectedId.value = issueId;
    if (opts.locate === false) return;
    const issue = byId.value.get(issueId);
    if (issue === undefined) return;
    if (bridge.value?.chapterId === issue.chapterId) bridge.value.locate(issue);
    else pendingLocate.value = issueId;
  }

  /** 编辑器挂载后调用：注册能力，并处理切换章节前等待的定位。返回注销函数。 */
  function registerEditor(b: EditorBridge): () => void {
    bridge.value = b;
    const pending = pendingLocate.value === null ? undefined : byId.value.get(pendingLocate.value);
    if (pending !== undefined && pending.chapterId === b.chapterId) {
      pendingLocate.value = null;
      b.locate(pending);
    }
    return () => {
      if (bridge.value === b) bridge.value = null;
    };
  }

  /** 一键修正（F4）：先保存当前章节，再提交；服务端写入后把新正文同步到编辑器（可撤销）。 */
  async function apply(issueIds: string[]): Promise<FixOutcome> {
    const id = requireWork();
    const editor = bridge.value;
    const touchesEditor = editor !== null && issueIds.some((i) => byId.value.get(i)?.chapterId === editor.chapterId);
    if (touchesEditor && !(await editor.flush())) return { applied: [], stale: [], chapters: [], blocked: true };
    editor?.setFixing(true);
    try {
      const res = await issuesApi.apply(id, issueIds);
      if (editor !== null && res.chapters.some((c) => c.id === editor.chapterId)) {
        const applied = res.applied.map((i) => byId.value.get(i)).filter((i): i is Issue => i !== undefined && i.chapterId === editor.chapterId);
        await editor.afterFix(applied);
      }
      return { ...res, blocked: false };
    } finally {
      editor?.setFixing(false);
      await refresh();
    }
  }

  async function ignore(issueIds: string[]): Promise<void> {
    await issuesApi.ignore(requireWork(), issueIds);
    await refresh();
  }

  /**
   * 由服务端直接写某章正文（如插入智能扩写）：该章正在编辑时先保存，写入期间暂停处理 chapter.updated，
   * 写入后把新正文作为一次可撤销的修改同步到编辑器。无法保存时不写入（blocked）。
   */
  async function serverEdit<T>(chapterId: string, write: () => Promise<T>): Promise<{ blocked: true } | { blocked: false; result: T }> {
    const editor = bridge.value?.chapterId === chapterId ? bridge.value : null;
    if (editor !== null && !(await editor.flush())) return { blocked: true };
    editor?.setFixing(true);
    try {
      const result = await write();
      if (editor !== null) await editor.afterFix([]);
      return { blocked: false, result };
    } finally {
      editor?.setFixing(false);
    }
  }

  /** AI 修复进度（只统计需要 AI 改写的问题）；没有进行中的修复时为 null。 */
  const fixProgress = ref<{ done: number; total: number } | null>(null);
  /** 正在由 AI 生成修改建议的问题。 */
  const suggesting = shallowRef<ReadonlySet<Id>>(new Set());
  let fixController: AbortController | null = null;

  const markSuggesting = (id: Id, on: boolean): void => {
    const next = new Set(suggesting.value);
    if (on) next.add(id);
    else next.delete(id);
    suggesting.value = next;
  };
  const patch = (issue: Issue): void => {
    items.value = items.value.map((i) => (i.id === issue.id ? issue : i));
  };

  /**
   * 修复（F4 补充）：没有修改建议的问题先由 AI 按意见生成建议（并发 FIX_CONCURRENCY 条，逐条显示进度），
   * 然后与已有建议的问题一起一键修正（apply：先保存、before_fix 版本、编辑器内可撤销）。
   * AI 修复前先保存当前章节，让模型看到的是最新正文；作者停止时不改正文，已生成的建议保留，可以逐条采纳。
   */
  async function fix(issueIds: string[]): Promise<AutoFixOutcome> {
    const id = requireWork();
    const none: AutoFixOutcome = { applied: [], stale: [], chapters: [], blocked: false, rewritten: [], failed: [], skipped: 0, stopped: false };
    if (fixController !== null) return none;
    const ids = [...new Set(issueIds)].filter((i) => byId.value.get(i)?.status === 'open');
    const need = ids.filter((i) => byId.value.get(i)?.replacement === null);
    const editor = bridge.value;
    if (need.length > 0 && editor !== null && need.some((i) => byId.value.get(i)?.chapterId === editor.chapterId) && !(await editor.flush())) {
      return { ...none, blocked: true };
    }

    const controller = new AbortController();
    fixController = controller;
    const rewritten: Id[] = [];
    const failed: AutoFixOutcome['failed'] = [];
    let consecutive = 0;
    let gaveUp = false;
    const queue = [...need];
    fixProgress.value = need.length > 0 ? { done: 0, total: need.length } : null;
    const worker = async (): Promise<void> => {
      for (let issueId = queue.shift(); issueId !== undefined && !controller.signal.aborted; issueId = queue.shift()) {
        markSuggesting(issueId, true);
        try {
          const updated = await issuesApi.suggest(id, issueId, controller.signal);
          if (workId.value === id) patch(updated);
          rewritten.push(issueId);
          consecutive = 0;
        } catch (err) {
          if (controller.signal.aborted) return;
          failed.push({ id: issueId, message: err instanceof ApiError ? err.message : 'AI 修复失败' });
          consecutive++;
          if (rewritten.length === 0 && consecutive >= FIX_GIVE_UP_AFTER) {
            gaveUp = true;
            controller.abort();
          }
        } finally {
          markSuggesting(issueId, false);
          if (fixProgress.value !== null) fixProgress.value = { ...fixProgress.value, done: fixProgress.value.done + 1 };
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(FIX_CONCURRENCY, need.length) }, worker));
    } finally {
      fixController = null;
      fixProgress.value = null;
    }
    const skipped = queue.length;
    if ((controller.signal.aborted && !gaveUp) || workId.value !== id) {
      await refresh().catch(() => undefined);
      return { ...none, rewritten, failed, skipped, stopped: true };
    }
    const ready = ids.filter((i) => {
      const issue = byId.value.get(i);
      return issue !== undefined && issue.status === 'open' && issue.replacement !== null;
    });
    if (ready.length === 0) {
      await refresh().catch(() => undefined);
      return { ...none, rewritten, failed, skipped };
    }
    return { ...(await apply(ready)), rewritten, failed, skipped, stopped: false };
  }

  /** 停止进行中的 AI 修复（中止请求，服务端随之中止模型调用）。 */
  function stopFix(): void {
    fixController?.abort();
  }

  return {
    workId,
    items,
    loading,
    selectedId,
    pendingLocate,
    bridge,
    open,
    openCount,
    byId,
    openInChapter,
    fixProgress,
    suggesting,
    refresh,
    openWork,
    close,
    select,
    registerEditor,
    apply,
    ignore,
    fix,
    stopFix,
    serverEdit,
  };
});
