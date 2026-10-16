import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { normalizeForMatch } from '../../shared/text';
import type { BibleCandidate, BibleEntry, CandidateDecision, NewEntryPayload } from '../../shared/types';
import { bibleApi, type EntryInput } from '../api/bible';
import { useSystemStore } from './system';

/** 与服务端 INV-9 相同的比较键（normalizeForMatch 后转小写）。 */
export const nameKey = (s: string): string => normalizeForMatch(s.trim()).text.toLowerCase();

/** 待审核候选的一组：同一个已有条目的候选，或同名的新条目候选（ADR-009「按条目分组」）。 */
export interface CandidateGroup {
  key: string;
  /** 已有条目；新条目组为 null。 */
  entry: BibleEntry | null;
  /** 组名：已有条目的名称或新条目的名称。 */
  name: string;
  /** 新条目组的名称与某个已有条目冲突（接受会被拒绝，应合并）。 */
  conflictEntry: BibleEntry | null;
  items: BibleCandidate[];
}

/**
 * 当前作品的设定库：条目列表与待审核候选。候选变化（candidates.changed）或抽取任务有进展（job.updated）时刷新。
 * 事实按需读取（选中条目时由界面加载）。
 */
export const useBibleStore = defineStore('bible', () => {
  const workId = ref<string | null>(null);
  const entries = shallowRef<BibleEntry[]>([]);
  const candidates = shallowRef<BibleCandidate[]>([]);
  const pendingCount = ref(0);
  const loading = ref(false);
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const entryById = computed(() => new Map(entries.value.map((e) => [e.id, e])));
  const entryByKey = computed(() => {
    const m = new Map<string, BibleEntry>();
    for (const e of entries.value) for (const n of [e.name, ...e.aliases]) if (!m.has(nameKey(n))) m.set(nameKey(n), e);
    return m;
  });

  /** 分组并按出现次数（候选数）从多到少排序。 */
  const groups = computed<CandidateGroup[]>(() => {
    const map = new Map<string, CandidateGroup>();
    for (const c of candidates.value) {
      const entry = c.targetEntryId === null ? null : (entryById.value.get(c.targetEntryId) ?? null);
      const name = entry?.name ?? (c.payload as NewEntryPayload).name ?? '';
      const key = entry !== null ? `entry:${entry.id}` : `new:${nameKey(name)}`;
      let g = map.get(key);
      if (g === undefined) {
        g = { key, entry, name, conflictEntry: entry === null ? (entryByKey.value.get(nameKey(name)) ?? null) : null, items: [] };
        map.set(key, g);
      }
      g.items.push(c);
    }
    return [...map.values()].sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  });

  function requireWork(): string {
    if (workId.value === null) throw new Error('尚未打开作品');
    return workId.value;
  }

  async function refresh(): Promise<void> {
    const id = workId.value;
    if (id === null) return;
    loading.value = true;
    try {
      const [e, c] = await Promise.all([bibleApi.entries(id), bibleApi.candidates(id, 'pending')]);
      if (workId.value !== id) return;
      entries.value = e;
      candidates.value = c;
      pendingCount.value = c.length;
    } finally {
      loading.value = false;
    }
  }

  function scheduleRefresh(delayMs: number): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void refresh().catch(() => undefined);
    }, delayMs);
  }

  async function openWork(id: string): Promise<void> {
    if (workId.value !== id) {
      entries.value = [];
      candidates.value = [];
      pendingCount.value = 0;
    }
    workId.value = id;
    unsubscribe?.();
    unsubscribe = useSystemStore().onServerEvent((e) => {
      if (!('workId' in e) || e.workId !== workId.value) return;
      if (e.type === 'candidates.changed') {
        pendingCount.value = e.pending;
        scheduleRefresh(0);
      } else if (e.type === 'job.updated' && e.job.type === 'bible_extract') {
        scheduleRefresh(e.job.status === 'running' ? 800 : 0);
      }
    });
    await refresh();
  }

  function close(): void {
    unsubscribe?.();
    unsubscribe = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    workId.value = null;
    entries.value = [];
    candidates.value = [];
    pendingCount.value = 0;
  }

  async function createEntry(input: EntryInput): Promise<BibleEntry> {
    const e = await bibleApi.createEntry(requireWork(), input);
    await refresh();
    return e;
  }

  async function updateEntry(id: string, patch: Partial<EntryInput>): Promise<BibleEntry> {
    const e = await bibleApi.updateEntry(requireWork(), id, patch);
    await refresh();
    return e;
  }

  async function deleteEntry(id: string): Promise<void> {
    await bibleApi.deleteEntry(requireWork(), id);
    await refresh();
  }

  async function decide(decisions: CandidateDecision[]): Promise<{ accepted: number; rejected: number }> {
    try {
      return await bibleApi.decide(requireWork(), decisions);
    } finally {
      await refresh();
    }
  }

  return { workId, entries, candidates, pendingCount, loading, entryById, groups, refresh, openWork, close, createEntry, updateEntry, deleteEntry, decide };
});
