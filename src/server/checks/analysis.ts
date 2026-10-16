import type { SqliteDatabase } from '../storage/sqlite';

/** 摘要的长度上限（码点）。协议要求不超过 200 字，这里留余量，只防失控输出。 */
export const SUMMARY_MAX_CHARS = 300;

/**
 * chapter_analysis.result（kind = 'summary'）的 JSON 结构：
 * - summary：最近一次完整的摘要，对应列 body_hash 的正文版本（缓存有效 ⇔ body_hash 等于章节当前哈希）；
 * - partial：长章节分多个片段生成摘要时，尚未凑齐的片段（凑齐后合并为 summary，partial 删除）。
 *   凑齐之前 summary / body_hash 保持上一个完整版本，④ 前情提要仍可使用它。
 */
interface SummaryResult {
  summary: string;
  partial?: { bodyHash: string; count: number; parts: (string | null)[] };
}

interface Row {
  body_hash: string;
  result: string;
}

function parse(raw: string): SummaryResult {
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null) return { summary: '' };
    const o = v as Record<string, unknown>;
    const summary = typeof o.summary === 'string' ? o.summary : '';
    const p = o.partial as Record<string, unknown> | undefined;
    if (
      p !== undefined &&
      typeof p.bodyHash === 'string' &&
      typeof p.count === 'number' &&
      Array.isArray(p.parts) &&
      p.parts.length === p.count &&
      p.parts.every((x) => x === null || typeof x === 'string')
    ) {
      return { summary, partial: { bodyHash: p.bodyHash, count: p.count, parts: p.parts as (string | null)[] } };
    }
    return { summary };
  } catch {
    return { summary: '' };
  }
}

/** 摘要清洗：合并空白为一段话，截断到 SUMMARY_MAX_CHARS 个码点。 */
export function cleanSummary(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const cps = [...flat];
  return cps.length <= SUMMARY_MAX_CHARS ? flat : `${cps.slice(0, SUMMARY_MAX_CHARS).join('')}…`;
}

/** 章节最近一次完整的摘要（不论是否对应当前正文）；没有或为空时返回 null。 */
export function readSummary(db: SqliteDatabase, chapterId: string): { summary: string; bodyHash: string } | null {
  const row = db.prepare("SELECT body_hash, result FROM chapter_analysis WHERE chapter_id = ? AND kind = 'summary'").get(chapterId) as Row | undefined;
  if (row === undefined) return null;
  const summary = parse(row.result).summary;
  return summary === '' ? null : { summary, bodyHash: row.body_hash };
}

/**
 * 写入一个摘要片段（在单元完成的事务内调用）。count = 1 时直接成为该正文版本的完整摘要；
 * 否则记入 partial，同一正文版本的 count 个片段凑齐后按顺序合并。返回该版本的摘要是否已完整。
 */
export function saveSummaryChunk(
  db: SqliteDatabase,
  input: { chapterId: string; bodyHash: string; index: number; count: number; text: string; model: string; now: number },
): boolean {
  const text = cleanSummary(input.text);
  const row = db.prepare("SELECT body_hash, result FROM chapter_analysis WHERE chapter_id = ? AND kind = 'summary'").get(input.chapterId) as
    | Row
    | undefined;
  const prev = row === undefined ? { summary: '' } : parse(row.result);
  let bodyHash = row?.body_hash ?? '';
  let next: SummaryResult;
  if (input.count <= 1) {
    next = { summary: text };
    bodyHash = input.bodyHash;
  } else {
    const same = prev.partial !== undefined && prev.partial.bodyHash === input.bodyHash && prev.partial.count === input.count;
    const parts = same ? [...(prev.partial?.parts ?? [])] : Array.from({ length: input.count }, () => null as string | null);
    parts[Math.min(Math.max(0, input.index), input.count - 1)] = text;
    if (parts.every((p) => p !== null)) {
      next = { summary: cleanSummaryJoin(parts as string[]) };
      bodyHash = input.bodyHash;
    } else {
      next = { summary: prev.summary, partial: { bodyHash: input.bodyHash, count: input.count, parts } };
    }
  }
  db.prepare(
    `INSERT INTO chapter_analysis (chapter_id, kind, body_hash, result, model, created_at) VALUES (?, 'summary', ?, ?, ?, ?)
     ON CONFLICT (chapter_id, kind) DO UPDATE SET body_hash = excluded.body_hash, result = excluded.result, model = excluded.model, created_at = excluded.created_at`,
  ).run(input.chapterId, bodyHash, JSON.stringify(next), input.model, input.now);
  return next.partial === undefined && bodyHash === input.bodyHash;
}

/**
 * 设定抽取的完成标记（kind = 'bible_extract'，F5 第 1 步）：候选另存在 bible_candidate，这里只记录某个正文版本
 * 是否已经全部抽取过。result = { count, done }：同一正文版本的 count 个片段都完成后 body_hash 才更新为该版本，
 * 规划时据此跳过「正文没变、已经抽取过」的章节。有片段失败时不算完成，下次重新抽取（重复的候选会被去重）。
 */
export function markExtractChunk(db: SqliteDatabase, input: { chapterId: string; bodyHash: string; index: number; count: number; model: string; now: number }): boolean {
  const row = db.prepare("SELECT body_hash, result FROM chapter_analysis WHERE chapter_id = ? AND kind = 'bible_extract'").get(input.chapterId) as Row | undefined;
  let done: boolean[] = Array.from({ length: Math.max(1, input.count) }, () => false);
  try {
    const prev = JSON.parse(row?.result ?? '{}') as { bodyHash?: unknown; count?: unknown; done?: unknown };
    if (prev.bodyHash === input.bodyHash && prev.count === input.count && Array.isArray(prev.done) && prev.done.length === input.count) {
      done = prev.done.map((x) => x === true);
    }
  } catch {
    // 损坏时重新收集
  }
  done[Math.min(Math.max(0, input.index), done.length - 1)] = true;
  const complete = done.every(Boolean);
  const bodyHash = complete ? input.bodyHash : (row?.body_hash ?? '');
  db.prepare(
    `INSERT INTO chapter_analysis (chapter_id, kind, body_hash, result, model, created_at) VALUES (?, 'bible_extract', ?, ?, ?, ?)
     ON CONFLICT (chapter_id, kind) DO UPDATE SET body_hash = excluded.body_hash, result = excluded.result, model = excluded.model, created_at = excluded.created_at`,
  ).run(input.chapterId, bodyHash, JSON.stringify({ bodyHash: input.bodyHash, count: input.count, done }), input.model, input.now);
  return complete;
}

/** 多个片段摘要按顺序合并（每段已清洗；合并后不再截断，长章节的摘要允许更长）。 */
function cleanSummaryJoin(parts: readonly string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .join(' ');
}
