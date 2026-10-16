import type { PlotMemoryState } from '../../shared/types';
import { chapterShortLabel, type TocChapter } from '../manuscript/toc';
import type { SqliteDatabase } from '../storage/sqlite';
import { listEntries, type MemoryEntry } from './repo';

/** 与 checks/prompt 的 PromptBlock 结构一致（这里不依赖 checks，避免循环引用）。 */
export interface ContextBlock {
  text: string;
  trimmable: boolean;
  order: number;
}

/** ④ 中剧情记忆的裁剪先后：比章节摘要（order = 章节位置）晚裁，状态快照最后裁。 */
export const MEMORY_STATE_ORDER = 2_000_000_000;
export const MEMORY_EVENTS_ORDER = MEMORY_STATE_ORDER - 1;
/** 「近期剧情」最多取最近几次更新、最多几条事件。 */
export const RECENT_ENTRIES = 3;
export const RECENT_EVENTS_MAX = 15;

export interface MemorySnapshot {
  entry: MemoryEntry;
  /** 快照截至的章节（目录中最靠后的已纳入章节）；全部来源章节都已删除时为 null。 */
  upTo: TocChapter | null;
  /** 截至该快照的最近几次更新（旧的在前）。 */
  recent: MemoryEntry[];
}

/**
 * 为某章挑选剧情记忆快照（ADR-011）：按更新顺序累计已纳入章节在目录中的最大位置，取最后一个仍在本章之前的快照——
 * 快照只包含「已经发生」的剧情，检查较早的章节时不会把后文的发展当成前情。
 * - includeCurrent = false（审稿、一致性检查）：已纳入的章节必须都在本章之前，本章自己写到的内容不算前情；
 * - includeCurrent = true（灵感胶囊、智能扩写）：可以包含本章已经写到的部分。
 */
export function memorySnapshot(db: SqliteDatabase, chapterId: string, toc: readonly TocChapter[], includeCurrent: boolean): MemorySnapshot | null {
  const position = new Map(toc.map((c, i) => [c.id, i]));
  const current = position.get(chapterId) ?? toc.length;
  const entries = listEntries(db);
  let max = -1;
  let best = -1;
  let bestMax = -1;
  for (let i = 0; i < entries.length; i++) {
    for (const id of (entries[i] as MemoryEntry).chapterIds) max = Math.max(max, position.get(id) ?? -1);
    if (includeCurrent ? max > current : max >= current) break;
    best = i;
    bestMax = max;
  }
  if (best < 0) return null;
  return { entry: entries[best] as MemoryEntry, upTo: bestMax >= 0 ? (toc[bestMax] ?? null) : null, recent: entries.slice(Math.max(0, best - RECENT_ENTRIES + 1), best + 1) };
}

/** 状态快照渲染为文本（提示词与界面查阅共用的格式）。 */
export function renderState(state: PlotMemoryState): string {
  const lines: string[] = [];
  if (state.mainline.trim() !== '') lines.push(`主线进展：${state.mainline.trim()}`);
  if (state.characters.length > 0) lines.push('人物现状：', ...state.characters.map((c) => `- ${c.name}：${c.status}`));
  if (state.threads.length > 0) lines.push('未解决的冲突与伏笔：', ...state.threads.map((t) => `- ${t}`));
  if (state.emotion.trim() !== '') lines.push(`情绪走势：${state.emotion.trim()}`);
  return lines.join('\n');
}

export const isEmptyState = (s: PlotMemoryState): boolean => renderState(s) === '';

/**
 * ④ 前情提要中的剧情记忆：一段状态快照（注明截至哪一章）+ 一段近期剧情（最近几次更新的事件）。都可裁剪，但比章节摘要晚裁。
 * 没有可用的快照时返回空数组。
 */
export function memoryBlocks(db: SqliteDatabase, chapterId: string, toc: readonly TocChapter[], includeCurrent: boolean): ContextBlock[] {
  const snap = memorySnapshot(db, chapterId, toc, includeCurrent);
  if (snap === null) return [];
  const blocks: ContextBlock[] = [];
  const state = renderState(snap.entry.state);
  const upTo = snap.upTo === null ? '' : ` · 截至${chapterShortLabel(snap.upTo)}`;
  if (state !== '') blocks.push({ text: `【剧情记忆${upTo}】\n${state}`, trimmable: true, order: MEMORY_STATE_ORDER });
  const events = snap.recent.flatMap((e) => e.events).slice(-RECENT_EVENTS_MAX);
  if (events.length > 0) blocks.push({ text: `【近期剧情】\n${events.map((e) => `- ${e}`).join('\n')}`, trimmable: true, order: MEMORY_EVENTS_ORDER });
  return blocks;
}
