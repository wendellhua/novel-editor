import { LIMITS, SENTENCE_END_CHARS } from '../../shared/constants';
import { normalizeNewlines } from '../../shared/text';
import type { ApplyExpansionResponse, Expansion } from '../../shared/types';
import { DomainError, invalid, missing } from '../errors';
import type { Manuscript } from '../manuscript';
import type { WorkDbPool } from '../storage/db-pool';
import type { SqliteDatabase } from '../storage/sqlite';
import { echoAtStart } from './fix';

interface ExpansionRow {
  job_id: string;
  chapter_id: string;
  body_hash: string;
  text: string;
  status: 'ready' | 'applied';
  created_at: number;
  applied_at: number | null;
}

/** 与前文结尾至少重复这么多字才当作「模型把最后一句又写了一遍」。 */
const ECHO_MIN_CHARS = 6;
const CHAPTER_HEADING = '第[0-9０-９零〇一二两三四五六七八九十百千]+[章节回]';

/** 句末截断：s 超过 cap 时截到 cap 之前最后一个句末标点之后（没有句末标点时硬截断）。 */
function cutAtSentence(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const head = s.slice(0, cap);
  let at = -1;
  for (const ch of SENTENCE_END_CHARS) at = Math.max(at, head.lastIndexOf(ch));
  return at > cap / 2 ? head.slice(0, at + 1) : head;
}

/**
 * 整理模型给出的续写（智能扩写）：
 * - 统一换行，去掉代码块标记、每行行首行尾的空白（编辑器的段首缩进只是显示效果，正文里没有）；
 * - 前文不用空行分段时把多余的空行合并；
 * - 去掉开头的章节标题；遇到下一章的标题就截断——一次只完成当前这一章；去掉结尾的「未完待续」；
 * - 去掉与前文结尾重复的开头（模型常把最后一句再写一遍）；
 * - 篇幅不超过目标字数的两倍，在句末截断。
 */
export function cleanExpansion(raw: string, body: string, targetChars: number): string {
  let s = normalizeNewlines(raw)
    .replace(/^\s*```[A-Za-z]*\n?/u, '')
    .replace(/\n?```\s*$/u, '');
  s = s
    .split('\n')
    .map((l) => l.replace(/^[ \t\u3000]+/u, '').replace(/[ \t\u3000]+$/u, ''))
    .join('\n');
  s = body.includes('\n\n') ? s.replace(/\n{3,}/gu, '\n\n') : s.replace(/\n{2,}/gu, '\n');
  s = s.trim();
  s = s.replace(new RegExp(`^${CHAPTER_HEADING}[^\\n]{0,30}\\n+`, 'u'), '');
  const next = new RegExp(`\\n${CHAPTER_HEADING}[^\\n]{0,30}(?:\\n|$)`, 'u').exec(s);
  if (next !== null) s = s.slice(0, next.index);
  s = s.replace(/[（(]?\s*未完待续\s*[)）]?$/u, '').trim();
  const echo = echoAtStart(s, body.slice(-300), ECHO_MIN_CHARS);
  if (echo > 0) s = s.slice(echo).replace(/^\n+/u, '');
  return cutAtSentence(s.trim(), targetChars * 2).trim();
}

/**
 * 插入章末时实际追加的文字：章节为空或以换行结尾时原样追加；最后一句已经写完（句末标点结尾）时另起一段；
 * 否则（最后一句没写完）直接接上。
 */
export function joinExpansion(body: string, text: string): string {
  const t = text.replace(/^\n+/u, '');
  if (body === '' || body.endsWith('\n')) return t;
  const last = [...body.trimEnd()].at(-1) ?? '';
  return SENTENCE_END_CHARS.includes(last) ? `\n${t}` : t;
}

/** 写入扩写结果（单元提交的事务内）；同一任务重新执行时覆盖。 */
export function saveExpansion(db: SqliteDatabase, e: { jobId: string; chapterId: string; bodyHash: string; text: string; now: number }): void {
  db.prepare(
    `INSERT INTO expansion (job_id, chapter_id, body_hash, text, status, created_at, applied_at) VALUES (?, ?, ?, ?, 'ready', ?, NULL)
     ON CONFLICT (job_id) DO UPDATE SET chapter_id = excluded.chapter_id, body_hash = excluded.body_hash, text = excluded.text,
       status = 'ready', created_at = excluded.created_at, applied_at = NULL`,
  ).run(e.jobId, e.chapterId, e.bodyHash, e.text, e.now);
}

function findRow(db: SqliteDatabase, jobId: string): ExpansionRow | null {
  return (db.prepare('SELECT * FROM expansion WHERE job_id = ?').get(jobId) as ExpansionRow | undefined) ?? null;
}

const currentHash = (db: SqliteDatabase, chapterId: string): string | null =>
  (db.prepare('SELECT body_hash FROM chapter WHERE id = ? AND deleted_at IS NULL').get(chapterId) as { body_hash: string } | undefined)?.body_hash ?? null;

function toExpansion(db: SqliteDatabase, r: ExpansionRow): Expansion {
  return {
    jobId: r.job_id,
    chapterId: r.chapter_id,
    text: r.text,
    status: r.status,
    stale: r.status === 'ready' && currentHash(db, r.chapter_id) !== r.body_hash,
    createdAt: r.created_at,
    appliedAt: r.applied_at,
  };
}

/** GET W/jobs/:jid/expansion。 */
export function readExpansion(db: SqliteDatabase, jobId: string): Expansion {
  const r = findRow(db, jobId);
  if (r === null) throw missing('这个任务还没有扩写结果');
  return toExpansion(db, r);
}

/**
 * 插入章末（F7 第 4 步）：经 Manuscript.fixChapterBody 写入——先存 before_expand 版本、rev 加 1、推送 chapter.updated，
 * 同一事务里把结果标为已插入（不能重复插入）。扩写之后本章有改动时，没有 force 不插入（400，附 stale: true）。
 */
export function applyExpansion(pool: WorkDbPool, manuscript: Manuscript, workId: string, jobId: string, force: boolean): ApplyExpansionResponse {
  const db = pool.get(workId);
  const r = findRow(db, jobId);
  if (r === null) throw missing('这个任务还没有扩写结果');
  if (r.status === 'applied') throw invalid('这段扩写已经插入过了');
  if (r.text.trim() === '') throw invalid('这次扩写没有内容');
  const hash = currentHash(db, r.chapter_id);
  if (hash === null) throw missing('扩写所在的章节已删除');
  if (hash !== r.body_hash && !force) throw new DomainError('VALIDATION', '本章在扩写之后有改动，续写可能衔接不上', { stale: true });
  const out = manuscript.fixChapterBody(
    workId,
    r.chapter_id,
    (tdb, row, now) => {
      const inserted = joinExpansion(row.body, r.text);
      if (row.body.length + inserted.length > LIMITS.chapterBodyMaxChars) throw invalid(`插入后本章超过 ${LIMITS.chapterBodyMaxChars} 字的上限`);
      return {
        body: row.body + inserted,
        result: inserted,
        afterWrite: () => tdb.prepare("UPDATE expansion SET status = 'applied', applied_at = ? WHERE job_id = ?").run(now, jobId),
      };
    },
    'before_expand',
  );
  return { chapterId: r.chapter_id, rev: out.rev, inserted: out.result };
}
