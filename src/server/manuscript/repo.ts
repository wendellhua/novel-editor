import { createHash, randomUUID } from 'node:crypto';
import { LIMITS } from '../../shared/constants';
import { countWords, normalizeNewlines } from '../../shared/text';
import type { RevisionReason, SaveBodyResponse } from '../../shared/types';
import { DomainError, invalid, missing } from '../errors';
import type { SqliteDatabase } from '../storage/sqlite';
import type { ChapterNodeRow, ChapterRow, RevisionRow, VolumeRow, WorkRow } from './rows';

export const TITLE_MAX_CHARS = 100;
export const META_MAX_CHARS = 2000;

export function bodyHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export const EMPTY_BODY_HASH = bodyHash('');

export function newId(): string {
  return randomUUID();
}

/** 标题：去掉首尾空白、合并换行；不能为空，最长 TITLE_MAX_CHARS 个字符。 */
export function normalizeTitle(raw: string, label: string): string {
  const title = raw.replace(/[\r\n]+/g, ' ').trim();
  if (title === '') throw invalid(`${label}不能为空`);
  if ([...title].length > TITLE_MAX_CHARS) throw invalid(`${label}不能超过 ${TITLE_MAX_CHARS} 个字`);
  return title;
}

export function normalizeMeta(raw: string, label: string): string {
  const value = normalizeNewlines(raw).trim();
  if ([...value].length > META_MAX_CHARS) throw invalid(`${label}不能超过 ${META_MAX_CHARS} 个字`);
  return value;
}

// ---------------- 读取 ----------------

export function getWorkRow(db: SqliteDatabase): WorkRow {
  const row = db.prepare('SELECT * FROM work').get() as WorkRow | undefined;
  if (row === undefined) throw missing('作品不存在');
  return row;
}

export function touchWork(db: SqliteDatabase, now: number): void {
  db.prepare('UPDATE work SET updated_at = ?').run(now);
}

export function listLiveVolumes(db: SqliteDatabase): VolumeRow[] {
  return db.prepare('SELECT * FROM volume WHERE deleted_at IS NULL ORDER BY seq, created_at').all() as unknown as VolumeRow[];
}

export function getVolumeRow(db: SqliteDatabase, id: string, opts: { allowDeleted?: boolean } = {}): VolumeRow {
  const row = db.prepare('SELECT * FROM volume WHERE id = ?').get(id) as VolumeRow | undefined;
  if (row === undefined || (row.deleted_at !== null && opts.allowDeleted !== true)) throw missing('分卷不存在');
  return row;
}

export function getChapterRow(db: SqliteDatabase, id: string, opts: { allowDeleted?: boolean } = {}): ChapterRow {
  const row = db.prepare('SELECT * FROM chapter WHERE id = ?').get(id) as ChapterRow | undefined;
  if (row === undefined) throw missing('章节不存在');
  if (opts.allowDeleted !== true) {
    if (row.deleted_at !== null) throw missing('章节不存在');
    const vol = db.prepare('SELECT deleted_at FROM volume WHERE id = ?').get(row.volume_id) as { deleted_at: number | null } | undefined;
    if (vol === undefined || vol.deleted_at !== null) throw missing('章节不存在');
  }
  return row;
}

export function listLiveChapterNodes(db: SqliteDatabase, volumeId?: string): ChapterNodeRow[] {
  const base =
    'SELECT c.id, c.volume_id, c.title, c.seq, c.word_count, c.updated_at FROM chapter c JOIN volume v ON v.id = c.volume_id ' +
    'WHERE c.deleted_at IS NULL AND v.deleted_at IS NULL';
  if (volumeId === undefined) {
    return db.prepare(`${base} ORDER BY v.seq, c.seq, c.created_at`).all() as unknown as ChapterNodeRow[];
  }
  return db.prepare(`${base} AND c.volume_id = ? ORDER BY c.seq, c.created_at`).all(volumeId) as unknown as ChapterNodeRow[];
}

// ---------------- 顺序（INV-2） ----------------

function liveChapterIds(db: SqliteDatabase, volumeId: string): string[] {
  const rows = db
    .prepare('SELECT id FROM chapter WHERE volume_id = ? AND deleted_at IS NULL ORDER BY seq, created_at')
    .all(volumeId) as { id: string }[];
  return rows.map((r) => r.id);
}

function liveVolumeIds(db: SqliteDatabase): string[] {
  return listLiveVolumes(db).map((v) => v.id);
}

function writeVolumeOrder(db: SqliteDatabase, ids: readonly string[]): void {
  const stmt = db.prepare('UPDATE volume SET seq = ? WHERE id = ? AND seq != ?');
  ids.forEach((id, i) => stmt.run(i, id, i));
}

function writeChapterOrder(db: SqliteDatabase, volumeId: string, ids: readonly string[]): void {
  const stmt = db.prepare('UPDATE chapter SET seq = ?, volume_id = ? WHERE id = ? AND (seq != ? OR volume_id != ?)');
  ids.forEach((id, i) => stmt.run(i, volumeId, id, i, volumeId));
}

export function renumberVolumes(db: SqliteDatabase): void {
  writeVolumeOrder(db, liveVolumeIds(db));
}

export function renumberChapters(db: SqliteDatabase, volumeId: string): void {
  writeChapterOrder(db, volumeId, liveChapterIds(db, volumeId));
}

/** 把卷插到 afterId 之后（null / undefined 表示末尾），并整体重排 seq。 */
export function placeVolume(db: SqliteDatabase, id: string, afterId: string | null | undefined): void {
  const ids = liveVolumeIds(db).filter((x) => x !== id);
  const at = afterId == null ? ids.length : ids.indexOf(afterId) + 1;
  if (afterId != null && at === 0) throw missing('参照分卷不存在');
  ids.splice(at, 0, id);
  writeVolumeOrder(db, ids);
}

export function placeChapterAfter(db: SqliteDatabase, volumeId: string, id: string, afterId: string | null | undefined): void {
  const ids = liveChapterIds(db, volumeId).filter((x) => x !== id);
  const at = afterId == null ? ids.length : ids.indexOf(afterId) + 1;
  if (afterId != null && at === 0) throw missing('参照章节不存在');
  ids.splice(at, 0, id);
  writeChapterOrder(db, volumeId, ids);
}

export function placeChapterAt(db: SqliteDatabase, volumeId: string, id: string, index: number): void {
  const ids = liveChapterIds(db, volumeId).filter((x) => x !== id);
  ids.splice(Math.max(0, Math.min(index, ids.length)), 0, id);
  writeChapterOrder(db, volumeId, ids);
}

function assertPermutation(given: readonly string[], actual: readonly string[], label: string): void {
  const set = new Set(given);
  if (set.size !== given.length || given.length !== actual.length || !actual.every((id) => set.has(id))) {
    throw invalid(`${label}必须是当前全部${label.replace('顺序', '')}的完整排列`);
  }
}

export function reorderVolumes(db: SqliteDatabase, ids: readonly string[]): void {
  assertPermutation(ids, liveVolumeIds(db), '分卷顺序');
  writeVolumeOrder(db, ids);
}

export function reorderChapters(db: SqliteDatabase, volumeId: string, ids: readonly string[]): void {
  assertPermutation(ids, liveChapterIds(db, volumeId), '章节顺序');
  writeChapterOrder(db, volumeId, ids);
}

/** 测试与诊断：返回违反 INV-2 的描述（空数组表示满足）。 */
export function findSeqViolations(db: SqliteDatabase): string[] {
  const problems: string[] = [];
  const check = (label: string, seqs: number[]): void => {
    seqs.forEach((s, i) => {
      if (s !== i) problems.push(`${label} 的 seq 应为 0..${seqs.length - 1}，实际 [${seqs.join(',')}]`);
    });
  };
  const vols = db.prepare('SELECT id, seq FROM volume WHERE deleted_at IS NULL ORDER BY seq').all() as { id: string; seq: number }[];
  check('分卷', vols.map((v) => v.seq));
  for (const v of vols) {
    const ch = db.prepare('SELECT seq FROM chapter WHERE volume_id = ? AND deleted_at IS NULL ORDER BY seq').all(v.id) as { seq: number }[];
    check(`分卷 ${v.id} 的章节`, ch.map((c) => c.seq));
  }
  return [...new Set(problems)];
}

// ---------------- 正文写入（INV-3 / INV-4） ----------------

export interface BodyWrite {
  body: string;
  title?: string;
}

export interface BodyWriteResult extends SaveBodyResponse {
  changed: boolean;
}

/** 校验乐观锁（INV-4）：baseRev ≠ rev 时抛 REV_CONFLICT，并附带服务端当前 rev 与 body。 */
export function assertBaseRev(row: ChapterRow, baseRev: number): void {
  if (baseRev !== row.rev) {
    throw new DomainError('REV_CONFLICT', '章节已在别处被修改', { rev: row.rev, body: row.body, title: row.title });
  }
}

/**
 * 正文写入的唯一入口（INV-3）：换行归一化、长度上限、字数与哈希同步更新、rev 恰好加 1。
 * 内容与标题都没变时不写入（rev 不变，changed=false）。调用方负责先 assertBaseRev 并包在事务里。
 */
export function writeChapterBody(db: SqliteDatabase, row: ChapterRow, input: BodyWrite, now: number): BodyWriteResult {
  const body = normalizeNewlines(input.body);
  if (body.length > LIMITS.chapterBodyMaxChars) throw invalid(`单章正文不能超过 ${LIMITS.chapterBodyMaxChars} 个字符`);
  const title = input.title === undefined ? row.title : normalizeTitle(input.title, '章节标题');
  const hash = bodyHash(body);
  if (hash === row.body_hash && title === row.title) {
    return { rev: row.rev, wordCount: row.word_count, updatedAt: row.updated_at, changed: false };
  }
  const wordCount = countWords(body);
  const result = db
    .prepare('UPDATE chapter SET body = ?, title = ?, word_count = ?, body_hash = ?, rev = rev + 1, updated_at = ? WHERE rid = ? AND rev = ?')
    .run(body, title, wordCount, hash, now, row.rid, row.rev);
  if (result.changes !== 1) throw new DomainError('REV_CONFLICT', '章节已在别处被修改');
  touchWork(db, now);
  return { rev: row.rev + 1, wordCount, updatedAt: now, changed: true };
}

// ---------------- 版本 ----------------

export function insertRevision(db: SqliteDatabase, row: Pick<ChapterRow, 'id' | 'rev' | 'title' | 'body' | 'word_count'>, reason: RevisionReason, now: number): number {
  const r = db
    .prepare('INSERT INTO chapter_revision(chapter_id, rev, title, body, word_count, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.id, row.rev, row.title, row.body, row.word_count, reason, now);
  return Number(r.lastInsertRowid);
}

export function latestRevisionTime(db: SqliteDatabase, chapterId: string): number | null {
  const row = db.prepare('SELECT max(created_at) AS t FROM chapter_revision WHERE chapter_id = ?').get(chapterId) as { t: number | null };
  return row.t;
}

/** 每章只保留最新 keep 条 auto 版本；manual / before_fix / before_restore 不参与清理。 */
export function pruneAutoRevisions(db: SqliteDatabase, chapterId: string, keep: number): void {
  db.prepare(
    "DELETE FROM chapter_revision WHERE chapter_id = ? AND reason = 'auto' AND id NOT IN " +
      "(SELECT id FROM chapter_revision WHERE chapter_id = ? AND reason = 'auto' ORDER BY id DESC LIMIT ?)",
  ).run(chapterId, chapterId, keep);
}

export function getRevisionRow(db: SqliteDatabase, chapterId: string, revisionId: number): RevisionRow {
  const row = db.prepare('SELECT * FROM chapter_revision WHERE id = ? AND chapter_id = ?').get(revisionId, chapterId) as RevisionRow | undefined;
  if (row === undefined) throw missing('版本不存在');
  return row;
}

// ---------------- 彻底删除 ----------------

/** 彻底删除章节及其关联数据（版本、分析缓存经外键级联；其余表无外键，手动清理）。 */
export function purgeChapter(db: SqliteDatabase, chapterId: string): void {
  db.prepare('DELETE FROM issue WHERE chapter_id = ?').run(chapterId);
  db.prepare('DELETE FROM job_report WHERE chapter_id = ?').run(chapterId);
  db.prepare('DELETE FROM bible_candidate WHERE chapter_id = ?').run(chapterId);
  db.prepare('UPDATE bible_fact SET chapter_id = NULL WHERE chapter_id = ?').run(chapterId);
  db.prepare('UPDATE bible_entry SET first_chapter_id = NULL WHERE first_chapter_id = ?').run(chapterId);
  db.prepare('DELETE FROM chapter WHERE id = ?').run(chapterId);
}

export function purgeVolume(db: SqliteDatabase, volumeId: string): void {
  const ids = db.prepare('SELECT id FROM chapter WHERE volume_id = ?').all(volumeId) as { id: string }[];
  for (const { id } of ids) purgeChapter(db, id);
  db.prepare('DELETE FROM volume WHERE id = ?').run(volumeId);
}
