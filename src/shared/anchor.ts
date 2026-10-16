import { normalizeForMatch, toOriginalRange, type TextRange } from './text';
import type { IssueCategory } from './types';

/**
 * 问题锚定（§7.4.3、INV-7）。纯函数，前后端共用：服务端写入与读取问题时使用，
 * 前端编辑器用同一套算法在本地（可能尚未保存的）正文上定位问题。偏移一律为 UTF-16 码元。
 */

export interface AnchorHit {
  start: number;
  end: number;
  /** 原文中的逐字片段与问题文字（INV-7：body.slice(start, end) === target）。 */
  excerpt: string;
  target: string;
}

/** 在 text 中找出 needle 的所有出现位置（允许重叠）。 */
function allIndexes(text: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === '') return out;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** excerpt 在 region 中的位置：先精确匹配，找不到再用 normalizeForMatch 归一化后匹配并映射回原文。 */
function findExcerpt(region: string, excerpt: string): TextRange[] {
  const exact = allIndexes(region, excerpt).map((i) => ({ start: i, end: i + excerpt.length }));
  if (exact.length > 0) return exact;
  const needle = normalizeForMatch(excerpt).text;
  if (needle === '') return [];
  const hay = normalizeForMatch(region);
  return allIndexes(hay.text, needle).map((i) => toOriginalRange(hay, i, i + needle.length));
}

/** target 在原文 excerpt 中的位置：先精确，再归一化。 */
function findTarget(span: string, target: string): TextRange | null {
  const t = span.indexOf(target);
  if (t >= 0) return { start: t, end: t + target.length };
  const needle = normalizeForMatch(target).text;
  if (needle === '') return null;
  const hay = normalizeForMatch(span);
  const i = hay.text.indexOf(needle);
  return i < 0 ? null : toOriginalRange(hay, i, i + needle.length);
}

/**
 * §7.4.3 首次锚定：在单元范围 body[range.start, range.end) 内定位模型给出的 excerpt 与 target。
 * - excerpt 精确匹配 → 归一化匹配 → 都找不到返回 []（调用方计入 unanchored）；
 * - target 必须在 excerpt 内，否则返回 []；
 * - typo、punctuation 类每个出现位置都生成一处，其他类别只取第一处；
 * - 返回的 excerpt / target 取自原文，保证 body.slice(start, end) === target。
 */
export function locate(body: string, range: TextRange, excerpt: string, target: string, category: IssueCategory): AnchorHit[] {
  if (excerpt === '' || target === '') return [];
  const region = body.slice(range.start, range.end);
  const hits = findExcerpt(region, excerpt);
  const out: AnchorHit[] = [];
  const seen = new Set<string>();
  for (const hit of category === 'typo' || category === 'punctuation' ? hits : hits.slice(0, 1)) {
    const span = region.slice(hit.start, hit.end);
    const t = findTarget(span, target);
    if (t === null) continue;
    const start = range.start + hit.start + t.start;
    const end = range.start + hit.start + t.end;
    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ start, end, excerpt: span, target: body.slice(start, end) });
  }
  return out;
}

/** 已锚定问题的最小信息（DTO 与数据库行都能提供）。 */
export interface AnchoredRef {
  excerpt: string;
  target: string;
  start: number;
}

/** INV-7：位置上的文字与 target 逐字一致。 */
export function isAnchored(body: string, issue: { target: string; start: number; end: number }): boolean {
  return issue.end - issue.start === issue.target.length && issue.start >= 0 && body.slice(issue.start, issue.end) === issue.target;
}

/**
 * 重新锚定（INV-7）：正文变化后，在整章中查找 excerpt，取 target 离原 start 最近的位置。
 * excerpt 内 target 出现多次时逐个比较，消除歧义。先精确匹配 excerpt，找不到再归一化匹配
 * （作者在片段里加了空格、改了全半角标点等）；target 本身必须逐字出现，否则视为失效返回 null。
 * 返回的 excerpt 取自当前正文，下次可以精确匹配。
 */
export function reanchor(body: string, issue: AnchoredRef): AnchorHit | null {
  const { excerpt, target } = issue;
  if (excerpt === '' || target === '') return null;
  const spans = findExcerpt(body, excerpt);
  let best: AnchorHit | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const span of spans) {
    const text = body.slice(span.start, span.end);
    for (const t of allIndexes(text, target)) {
      const start = span.start + t;
      const distance = Math.abs(start - issue.start);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { start, end: start + target.length, excerpt: text, target };
      }
    }
  }
  return best;
}

/**
 * 前端编辑器用：问题在本地正文（可能有未保存的改动）中的位置。原位置仍然逐字一致就直接用，否则重新锚定。
 * 服务端在 body_hash 不一致时一律走 reanchor（INV-7）。
 */
export function resolveAnchor(body: string, issue: AnchoredRef & { end: number }): TextRange | null {
  if (isAnchored(body, issue)) return { start: issue.start, end: issue.end };
  return reanchor(body, issue);
}

// ---------------- 修正（F4）：替换与位置映射 ----------------

/** 一处替换：把 [start, end) 换成 text。 */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** 两个范围是否重叠（首尾相接不算）。 */
export const rangesOverlap = (a: TextRange, b: TextRange): boolean => a.start < b.end && b.start < a.end;

/** 应用一组互不重叠的替换（按 start 从大到小依次替换，F4）。 */
export function applyEdits(body: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as TextEdit;
    const cur = sorted[i] as TextEdit;
    if (cur.end > prev.start) throw new RangeError('替换范围重叠');
  }
  let out = body;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/**
 * 把旧正文中的位置映射到应用 edits 之后的新正文。edits 互不重叠。
 * 落在某处替换内部的位置：assoc < 0 映射到替换的开头，否则映射到替换的结尾。
 */
export function mapPosition(pos: number, edits: readonly TextEdit[], assoc: -1 | 1): number {
  let delta = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    if (pos <= e.start) break;
    if (pos >= e.end) {
      delta += e.text.length - (e.end - e.start);
      continue;
    }
    return assoc < 0 ? e.start + delta : e.start + delta + e.text.length;
  }
  return pos + delta;
}

/**
 * 修正之后，同一章里其余问题的新位置（避免一处修正让旁边的问题失效）：
 * target 与任何替换重叠 → null（交给下次读取时重新锚定或标为失效）；否则平移，
 * 并重新截取 excerpt（excerpt 跨过了替换时会包含替换后的文字），保证新的 excerpt 是新正文的子串且包含 target。
 */
export function rebaseAnchor(oldBody: string, newBody: string, edits: readonly TextEdit[], issue: AnchoredRef & { end: number }): AnchorHit | null {
  const target: TextRange = { start: issue.start, end: issue.end };
  if (edits.some((e) => rangesOverlap(e, target))) return null;
  const start = mapPosition(issue.start, edits, 1);
  const end = start + issue.target.length;
  if (newBody.slice(start, end) !== issue.target) return null;
  // excerpt 在旧正文中的位置：包含 target 且离它最近的一处
  let span: TextRange | null = null;
  for (const i of allIndexes(oldBody, issue.excerpt)) {
    if (i <= issue.start && i + issue.excerpt.length >= issue.end) {
      span = { start: i, end: i + issue.excerpt.length };
      break;
    }
  }
  const excerpt =
    span === null
      ? newBody.slice(Math.max(0, start - 8), Math.min(newBody.length, end + 8))
      : newBody.slice(mapPosition(span.start, edits, -1), mapPosition(span.end, edits, 1));
  return { start, end, excerpt, target: issue.target };
}
