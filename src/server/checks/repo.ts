import { reanchor } from '../../shared/anchor';
import { missing } from '../errors';
import type { Usage } from '../llm/errors';
import type { SqliteDatabase } from '../storage/sqlite';
import type { IssueRow, JobRow, UnitKey, UnitPhase, UnitRow } from './rows';

/** 写入单元时的最小字段。 */
export interface NewUnit {
  phase: UnitPhase;
  chapterId: string;
  chunkIndex: number;
  start: number;
  end: number;
  bodyHash: string;
}

// ---------------- 任务 ----------------

export function insertJob(db: SqliteDatabase, row: JobRow): void {
  db.prepare(
    `INSERT INTO job (id, type, skill_id, scope_kind, scope_id, profile_id, only_changed, options, status, total_units, done_units,
       failed_units, prompt_tokens, completion_tokens, error, created_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.type,
    row.skill_id,
    row.scope_kind,
    row.scope_id,
    row.profile_id,
    row.only_changed,
    row.options,
    row.status,
    row.total_units,
    row.done_units,
    row.failed_units,
    row.prompt_tokens,
    row.completion_tokens,
    row.error,
    row.created_at,
    row.started_at,
    row.finished_at,
  );
}

export function findJobRow(db: SqliteDatabase, id: string): JobRow | null {
  return (db.prepare('SELECT * FROM job WHERE id = ?').get(id) as JobRow | undefined) ?? null;
}

export function getJobRow(db: SqliteDatabase, id: string): JobRow {
  const row = findJobRow(db, id);
  if (row === null) throw missing('任务不存在');
  return row;
}

export function listJobRows(db: SqliteDatabase): JobRow[] {
  return db.prepare('SELECT * FROM job ORDER BY created_at DESC, rowid DESC').all() as unknown as JobRow[];
}

export function updateJob(db: SqliteDatabase, id: string, patch: Partial<Pick<JobRow, 'status' | 'error' | 'started_at' | 'finished_at'>>): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return;
  db.prepare(`UPDATE job SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), id);
}

export function addJobUsage(db: SqliteDatabase, id: string, usage: Usage): void {
  if (usage.promptTokens === 0 && usage.completionTokens === 0) return;
  db.prepare('UPDATE job SET prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ? WHERE id = ?').run(
    usage.promptTokens,
    usage.completionTokens,
    id,
  );
}

/** 删除任务及其单元、问题、报告（外键级联），以及该任务产生的未审核候选。 */
export function deleteJob(db: SqliteDatabase, id: string): void {
  db.prepare("DELETE FROM bible_candidate WHERE job_id = ? AND status = 'pending'").run(id);
  db.prepare('DELETE FROM job WHERE id = ?').run(id);
}

/**
 * 重启后的状态修正（ADR-006）：上一个进程里排队或运行中的任务变为 paused。
 * activeIds 是本进程正在排队或运行的任务，不受影响。返回被修正的任务数。
 */
export function pauseOrphanedJobs(db: SqliteDatabase, activeIds: readonly string[]): number {
  const placeholders = activeIds.map(() => '?').join(', ');
  const sql =
    "UPDATE job SET status = 'paused' WHERE status IN ('queued', 'running')" + (activeIds.length > 0 ? ` AND id NOT IN (${placeholders})` : '');
  return Number(db.prepare(sql).run(...activeIds).changes);
}

/** INV-18：done + failed ≤ total；status = done 时 done + failed = total。违反时抛错（由调用方让任务失败）。 */
export function assertJobCounts(row: Pick<JobRow, 'id' | 'status' | 'total_units' | 'done_units' | 'failed_units'>): void {
  const used = row.done_units + row.failed_units;
  if (row.done_units < 0 || row.failed_units < 0 || used > row.total_units) {
    throw new Error(`INV-18 违反：任务 ${row.id} done ${row.done_units} + failed ${row.failed_units} > total ${row.total_units}`);
  }
  if (row.status === 'done' && used !== row.total_units) {
    throw new Error(`INV-18 违反：任务 ${row.id} 已完成但 done ${row.done_units} + failed ${row.failed_units} ≠ total ${row.total_units}`);
  }
}

// ---------------- 单元 ----------------

export function insertUnits(db: SqliteDatabase, jobId: string, units: readonly NewUnit[]): void {
  const stmt = db.prepare(
    `INSERT INTO job_unit (job_id, phase, chapter_id, chunk_index, range_start, range_end, body_hash, status, attempts, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL)`,
  );
  for (const u of units) stmt.run(jobId, u.phase, u.chapterId, u.chunkIndex, u.start, u.end, u.bodyHash);
  if (units.length > 0) db.prepare('UPDATE job SET total_units = total_units + ? WHERE id = ?').run(units.length, jobId);
}

/** 按写入顺序列出某阶段的待执行单元（改稿后重排的单元排在最后）。 */
export function pendingUnits(db: SqliteDatabase, jobId: string, phase: UnitPhase): UnitRow[] {
  return db
    .prepare("SELECT * FROM job_unit WHERE job_id = ? AND phase = ? AND status = 'pending' ORDER BY rowid")
    .all(jobId, phase) as unknown as UnitRow[];
}

export function countUnits(db: SqliteDatabase, jobId: string, phase: UnitPhase, chapterId: string): number {
  return (db.prepare('SELECT count(*) AS n FROM job_unit WHERE job_id = ? AND phase = ? AND chapter_id = ?').get(jobId, phase, chapterId) as { n: number })
    .n;
}

export function maxChunkIndex(db: SqliteDatabase, jobId: string, phase: UnitPhase, chapterId: string): number {
  const row = db
    .prepare('SELECT max(chunk_index) AS m FROM job_unit WHERE job_id = ? AND phase = ? AND chapter_id = ?')
    .get(jobId, phase, chapterId) as { m: number | null };
  return row.m ?? -1;
}

const KEY_WHERE = 'job_id = ? AND phase = ? AND chapter_id = ? AND chunk_index = ?';
const keyArgs = (jobId: string, k: UnitKey): [string, string, string, number] => [jobId, k.phase, k.chapterId, k.chunkIndex];

/** 把一个待执行单元标为完成或失败，并同步任务计数（与单元结果写入放在同一事务里）。 */
export function finishUnit(db: SqliteDatabase, jobId: string, key: UnitKey, outcome: { ok: true } | { ok: false; error: string }): void {
  const changed = outcome.ok
    ? db.prepare(`UPDATE job_unit SET status = 'done', attempts = attempts + 1, error = NULL WHERE ${KEY_WHERE} AND status = 'pending'`).run(...keyArgs(jobId, key))
    : db
        .prepare(`UPDATE job_unit SET status = 'failed', attempts = attempts + 1, error = ? WHERE ${KEY_WHERE} AND status = 'pending'`)
        .run(outcome.error.slice(0, 1000), ...keyArgs(jobId, key));
  if (Number(changed.changes) !== 1) throw new Error(`单元不在待执行状态：${jobId} ${key.phase}/${key.chapterId}/${key.chunkIndex}`);
  db.prepare(`UPDATE job SET ${outcome.ok ? 'done_units = done_units + 1' : 'failed_units = failed_units + 1'} WHERE id = ?`).run(jobId);
  assertJobCounts(getJobRow(db, jobId));
}

export function findUnit(db: SqliteDatabase, jobId: string, key: UnitKey): UnitRow | null {
  return (db.prepare(`SELECT * FROM job_unit WHERE ${KEY_WHERE}`).get(...keyArgs(jobId, key)) as UnitRow | undefined) ?? null;
}

/** ⑥ 标题中的「片段 i/n」：该章在本阶段、同一正文版本下的单元按 chunk_index 排序后的位置。 */
export function chunkPosition(db: SqliteDatabase, jobId: string, key: UnitKey, bodyHash: string): { index: number; count: number } {
  const rows = db
    .prepare('SELECT chunk_index AS i FROM job_unit WHERE job_id = ? AND phase = ? AND chapter_id = ? AND body_hash = ? ORDER BY chunk_index')
    .all(jobId, key.phase, key.chapterId, bodyHash) as { i: number }[];
  const index = rows.findIndex((r) => r.i === key.chunkIndex);
  return { index: Math.max(0, index), count: Math.max(1, rows.length) };
}

/** 某章在本阶段尚未执行的单元（改稿后重排用）。 */
export function pendingUnitsOfChapter(db: SqliteDatabase, jobId: string, phase: UnitPhase, chapterId: string): UnitRow[] {
  return db
    .prepare("SELECT * FROM job_unit WHERE job_id = ? AND phase = ? AND chapter_id = ? AND status = 'pending'")
    .all(jobId, phase, chapterId) as unknown as UnitRow[];
}

/** 恢复任务时把失败的单元重新放回待执行（failed_units 同步减少）。返回重置的单元数。 */
export function resetFailedUnits(db: SqliteDatabase, jobId: string): number {
  const n = Number(db.prepare("UPDATE job_unit SET status = 'pending', error = NULL WHERE job_id = ? AND status = 'failed'").run(jobId).changes);
  if (n > 0) db.prepare('UPDATE job SET failed_units = failed_units - ? WHERE id = ?').run(n, jobId);
  assertJobCounts(getJobRow(db, jobId));
  return n;
}

/** 删除待执行单元并同步 total（章节已删除、改稿后重排）。 */
export function dropPendingUnits(db: SqliteDatabase, jobId: string, keys: readonly UnitKey[]): number {
  let removed = 0;
  const stmt = db.prepare(`DELETE FROM job_unit WHERE ${KEY_WHERE} AND status = 'pending'`);
  for (const k of keys) removed += Number(stmt.run(...keyArgs(jobId, k)).changes);
  if (removed > 0) db.prepare('UPDATE job SET total_units = total_units - ? WHERE id = ?').run(removed, jobId);
  assertJobCounts(getJobRow(db, jobId));
  return removed;
}

/**
 * onlyChanged（F3 第 1 步）：返回「上一次同类型、同技能检查时的正文哈希」与当前一致的章节。
 * 判定：存在某个同类型、同技能的任务，该章的 main 单元全部完成且 body_hash 都等于当前正文哈希。
 */
export function unchangedSinceLastCheck(db: SqliteDatabase, type: string, skillId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT u.chapter_id AS chapterId, min(u.body_hash) AS lo, max(u.body_hash) AS hi, sum(u.status != 'done') AS notDone
       FROM job_unit u JOIN job j ON j.id = u.job_id
       WHERE j.type = ? AND j.skill_id = ? AND u.phase = 'main'
       GROUP BY u.job_id, u.chapter_id`,
    )
    .all(type, skillId) as { chapterId: string; lo: string; hi: string; notDone: number }[];
  const current = new Map(
    (db.prepare('SELECT id, body_hash FROM chapter WHERE deleted_at IS NULL').all() as { id: string; body_hash: string }[]).map((r) => [r.id, r.body_hash]),
  );
  const out = new Set<string>();
  for (const r of rows) {
    if (r.notDone === 0 && r.lo === r.hi && current.get(r.chapterId) === r.lo) out.add(r.chapterId);
  }
  return out;
}

/** 已有有效分析缓存（body_hash 与当前正文一致）的章节：摘要、或已完成设定抽取。 */
export function chaptersWithValidAnalysis(db: SqliteDatabase, kind: 'summary' | 'bible_extract'): Set<string> {
  const rows = db
    .prepare('SELECT a.chapter_id AS id FROM chapter_analysis a JOIN chapter c ON c.id = a.chapter_id WHERE a.kind = ? AND a.body_hash = c.body_hash')
    .all(kind) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

export const chaptersWithValidSummary = (db: SqliteDatabase): Set<string> => chaptersWithValidAnalysis(db, 'summary');

// ---------------- 问题 ----------------

export function insertIssue(db: SqliteDatabase, row: IssueRow): void {
  db.prepare(
    `INSERT INTO issue (id, job_id, chapter_id, category, severity, excerpt, target, start_offset, end_offset, replacement,
       message, evidence, body_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.job_id,
    row.chapter_id,
    row.category,
    row.severity,
    row.excerpt,
    row.target,
    row.start_offset,
    row.end_offset,
    row.replacement,
    row.message,
    row.evidence,
    row.body_hash,
    row.status,
    row.created_at,
    row.updated_at,
  );
}

/**
 * §7.4.3 第 5 步去重用：snapshot 正文上已经存在的问题位置。
 * - 本任务在同一正文版本下写入的全部问题；
 * - 其他任务中仍「待处理」或「已忽略」的问题（位置按 snapshot 正文重新锚定后比较）——重复检查不会列出两遍，
 *   作者忽略过的问题也不会因为再查一次而重新出现。
 */
export function existingIssueKeys(db: SqliteDatabase, jobId: string, chapterId: string, body: string, bodyHash: string): Set<string> {
  const keys = new Set<string>();
  const own = db
    .prepare('SELECT start_offset AS s, end_offset AS e, category AS c FROM issue WHERE job_id = ? AND chapter_id = ? AND body_hash = ?')
    .all(jobId, chapterId, bodyHash) as { s: number; e: number; c: string }[];
  for (const r of own) keys.add(issueKey(r.s, r.e, r.c));
  const others = db
    .prepare(
      "SELECT excerpt, target, start_offset AS start, end_offset AS end, category, body_hash FROM issue WHERE chapter_id = ? AND job_id != ? AND status IN ('open', 'ignored')",
    )
    .all(chapterId, jobId) as { excerpt: string; target: string; start: number; end: number; category: string; body_hash: string }[];
  for (const r of others) {
    const pos = r.body_hash === bodyHash ? { start: r.start, end: r.end } : reanchor(body, r);
    if (pos !== null) keys.add(issueKey(pos.start, pos.end, r.category));
  }
  return keys;
}

export const issueKey = (start: number, end: number, category: string): string => `${start}:${end}:${category}`;

export function countIssues(db: SqliteDatabase, jobId: string): number {
  return (db.prepare('SELECT count(*) AS n FROM issue WHERE job_id = ?').get(jobId) as { n: number }).n;
}
