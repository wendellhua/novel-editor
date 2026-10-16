import { splitParagraphChunks } from '../../shared/text';
import { chapterLabel, chapterShortLabel, type TocChapter } from '../manuscript/toc';
import type { SqliteDatabase } from '../storage/sqlite';
import { coverageMap, type Coverage } from './repo';

/** 记录在进度里的「已纳入部分末尾的原文」长度：改稿后据此找回接续位置。 */
export const ANCHOR_CHARS = 32;
/** 一个批次剩余的空间不足这么多字时不再往里放新的章节片段（避免切出零碎的片段）。 */
export const MIN_BATCH_PIECE_CHARS = 400;

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** 已纳入部分的末尾锚点：covered 之前最多 ANCHOR_CHARS 个码元（不从代理对中间截断）。 */
export function anchorAt(body: string, covered: number): string {
  let from = Math.max(0, covered - ANCHOR_CHARS);
  if (from > 0 && isLowSurrogate(body.charCodeAt(from))) from++;
  return body.slice(from, covered);
}

/**
 * 某章的接续位置（ADR-011 增量更新）：从这里往后是还没有纳入剧情记忆的正文。
 * - 锚点仍在原位置：就是 covered（最常见：只在章末接着写）；
 * - 已纳入部分被改过、长度变了：在原位置附近找锚点，取离原位置最近的一处；
 * - 锚点已经找不到（大段改写）：按原来的字数估计——已纳入部分的改写不会重新记录（需要时可以「重建」）。
 */
export function resumePoint(body: string, rec: Coverage | undefined): number {
  if (rec === undefined || rec.covered <= 0) return 0;
  const { covered, anchor } = rec;
  let at: number;
  if (anchor === '') {
    at = Math.min(covered, body.length);
  } else if (covered <= body.length && body.slice(covered - anchor.length, covered) === anchor) {
    at = covered;
  } else {
    const want = covered - anchor.length;
    const hits = [body.lastIndexOf(anchor, Math.max(0, want)), body.indexOf(anchor, Math.max(0, want))].filter((i) => i >= 0);
    at = hits.length === 0 ? Math.min(covered, body.length) : (hits.sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0] as number) + anchor.length;
  }
  if (at > 0 && at < body.length && isLowSurrogate(body.charCodeAt(at))) at++;
  return Math.min(at, body.length);
}

/** 一章中尚未纳入剧情记忆的部分。 */
export interface PendingSegment {
  chapter: TocChapter;
  /** 目录中的位置。 */
  index: number;
  start: number;
  end: number;
  body: string;
}

export interface Measure {
  segments: PendingSegment[];
  coveredChars: number;
  pendingChars: number;
}

/** 按目录顺序列出全部尚未纳入的正文（只有空白的部分不算）。读取全部正文，只在保存后的防抖检查与查阅时调用。 */
export function measurePending(db: SqliteDatabase, toc: readonly TocChapter[]): Measure {
  const coverage = coverageMap(db);
  const bodyOf = db.prepare('SELECT body FROM chapter WHERE id = ?');
  const segments: PendingSegment[] = [];
  let coveredChars = 0;
  let pendingChars = 0;
  toc.forEach((chapter, index) => {
    const body = (bodyOf.get(chapter.id) as { body: string } | undefined)?.body ?? '';
    const start = resumePoint(body, coverage.get(chapter.id));
    coveredChars += start;
    if (body.slice(start).trim() === '') return;
    segments.push({ chapter, index, start, end: body.length, body });
    pendingChars += body.length - start;
  });
  return { segments, coveredChars, pendingChars };
}

/** 一个批次：按目录顺序取若干章节片段，合计不超过 maxChars（长片段在段落边界处截断，余下的留给下一个批次）。 */
export interface Batch {
  pieces: { chapter: TocChapter; index: number; start: number; end: number; body: string; text: string }[];
  chars: number;
}

export function takeBatch(segments: readonly PendingSegment[], maxChars: number): Batch {
  const pieces: Batch['pieces'] = [];
  let chars = 0;
  for (const s of segments) {
    const room = maxChars - chars;
    if (room <= 0 || (pieces.length > 0 && room < MIN_BATCH_PIECE_CHARS)) break;
    const slice = s.body.slice(s.start, s.end);
    const first = splitParagraphChunks(slice, room)[0];
    const end = s.start + (first?.end ?? slice.length);
    pieces.push({ chapter: s.chapter, index: s.index, start: s.start, end, body: s.body, text: s.body.slice(s.start, end) });
    chars += end - s.start;
    if (end < s.end) break;
  }
  return { pieces, chars };
}

/** 批次正文（⑥）：每个片段一个小标题，接着上次之后写的注明「接上次记录」。 */
export function batchText(batch: Batch): string {
  return batch.pieces.map((p) => `### ${chapterLabel(p.chapter)}${p.start > 0 ? '（接上次记录）' : ''}\n${p.text.trim()}`).join('\n\n');
}

/** 「第1卷第3章」或「第1卷第3章～第1卷第5章」。 */
export function batchLabel(batch: Batch): string {
  const first = batch.pieces[0];
  const last = batch.pieces.at(-1);
  if (first === undefined || last === undefined) return '';
  return first.chapter.id === last.chapter.id ? chapterShortLabel(first.chapter) : `${chapterShortLabel(first.chapter)}～${chapterShortLabel(last.chapter)}`;
}
