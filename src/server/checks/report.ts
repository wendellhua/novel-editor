import type { JobReport } from '../../shared/types';
import type { SqliteDatabase } from '../storage/sqlite';

/**
 * 审稿报告（job_report）：chapter_id = '' 为整体报告（reduce 阶段），其余为逐章评语（main 阶段的 comment）。
 * 一章分多个片段审读时，评语按片段分节：每节以独占一行的「**片段 i/n**」开头，按 i 排序——
 * 片段可能并发、乱序完成，每次写入时重新排序。章节在检查期间被修改、重新切分后 n 可能变化，
 * 此时只保留与本次 n 相同的分节（旧版本正文的评语被新版本替换）。
 */
const SECTION_RE = /^\*\*片段 (\d+)\/(\d+)\*\*$/;

/** 模型评语里恰好出现分节标记行时去掉加粗，避免被误认为分节。 */
const sanitize = (comment: string): string => comment.replace(/^\*\*片段 (\d+)\/(\d+)\*\*$/gmu, '片段 $1/$2').trim();

function parseSections(markdown: string): Map<number, { count: number; text: string }> {
  const out = new Map<number, { count: number; text: string }>();
  let current: { index: number; count: number; lines: string[] } | null = null;
  const flush = (): void => {
    if (current !== null) out.set(current.index, { count: current.count, text: current.lines.join('\n').trim() });
  };
  for (const line of markdown.split('\n')) {
    const m = SECTION_RE.exec(line);
    if (m !== null) {
      flush();
      current = { index: Number(m[1]), count: Number(m[2]), lines: [] };
    } else if (current !== null) {
      current.lines.push(line);
    }
  }
  flush();
  return out;
}

function readMarkdown(db: SqliteDatabase, jobId: string, chapterId: string): string | null {
  const row = db.prepare('SELECT markdown FROM job_report WHERE job_id = ? AND chapter_id = ?').get(jobId, chapterId) as { markdown: string } | undefined;
  return row?.markdown ?? null;
}

function writeMarkdown(db: SqliteDatabase, jobId: string, chapterId: string, markdown: string): void {
  db.prepare('INSERT INTO job_report (job_id, chapter_id, markdown) VALUES (?, ?, ?) ON CONFLICT (job_id, chapter_id) DO UPDATE SET markdown = excluded.markdown').run(
    jobId,
    chapterId,
    markdown,
  );
}

/** 写入某章一个片段的评语（index 从 0 起，count 为该章本次的片段数）。空评语不写。 */
export function saveChapterComment(db: SqliteDatabase, jobId: string, chapterId: string, index: number, count: number, comment: string): void {
  const text = sanitize(comment);
  if (text === '') return;
  if (count <= 1) {
    writeMarkdown(db, jobId, chapterId, text);
    return;
  }
  const sections = parseSections(readMarkdown(db, jobId, chapterId) ?? '');
  for (const [i, s] of sections) if (s.count !== count) sections.delete(i);
  sections.set(index + 1, { count, text });
  const markdown = [...sections.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, s]) => `**片段 ${i}/${count}**\n\n${s.text}`)
    .join('\n\n');
  writeMarkdown(db, jobId, chapterId, markdown);
}

export function saveOverallReport(db: SqliteDatabase, jobId: string, markdown: string): void {
  writeMarkdown(db, jobId, '', markdown.trim());
}

/** 本任务各章的评语（chapterId → markdown）。 */
export function chapterComments(db: SqliteDatabase, jobId: string): Map<string, string> {
  const rows = db.prepare("SELECT chapter_id AS id, markdown FROM job_report WHERE job_id = ? AND chapter_id != ''").all(jobId) as { id: string; markdown: string }[];
  return new Map(rows.map((r) => [r.id, r.markdown]));
}

/** GET /jobs/:jid/report：整体报告 + 逐章评语（按卷序、章序；已删除的章节不返回）。 */
export function readReport(db: SqliteDatabase, jobId: string): JobReport {
  const overall = readMarkdown(db, jobId, '');
  const rows = db
    .prepare(
      `SELECT r.chapter_id AS chapterId, r.markdown FROM job_report r
       JOIN chapter c ON c.id = r.chapter_id JOIN volume v ON v.id = c.volume_id
       WHERE r.job_id = ? AND c.deleted_at IS NULL AND v.deleted_at IS NULL
       ORDER BY v.seq, v.created_at, c.seq, c.created_at`,
    )
    .all(jobId) as { chapterId: string; markdown: string }[];
  return { overall: overall === null || overall === '' ? null : overall, chapters: rows.map((r) => ({ chapterId: r.chapterId, markdown: r.markdown })) };
}
