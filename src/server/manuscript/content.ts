import { LIMITS } from '../../shared/constants';
import type { Chapter, RevisionDetail, RevisionMeta, SaveBodyRequest } from '../../shared/types';
import type { SqliteDatabase } from '../storage/sqlite';
import {
  assertBaseRev,
  getChapterRow,
  getRevisionRow,
  insertRevision,
  latestRevisionTime,
  pruneAutoRevisions,
  writeChapterBody,
  type BodyWriteResult,
} from './repo';
import { toChapter, toRevisionMeta, type RevisionRow } from './rows';

export function getChapter(db: SqliteDatabase, id: string): Chapter {
  return toChapter(getChapterRow(db, id));
}

/**
 * 保存正文（F2 L2 / L3）：乐观锁 → 唯一写入口 → 距上一条版本 ≥ 10 分钟时追加一条 auto 版本（快照为保存后的内容）。
 * 调用方负责事务。
 */
export function saveChapterBody(db: SqliteDatabase, id: string, req: SaveBodyRequest, now: number): BodyWriteResult {
  const row = getChapterRow(db, id);
  assertBaseRev(row, req.baseRev);
  const result = writeChapterBody(db, row, { body: req.body }, now);
  if (result.changed) {
    const last = latestRevisionTime(db, id);
    if (last === null || now - last >= LIMITS.autoRevisionIntervalMs) {
      insertRevision(db, getChapterRow(db, id), 'auto', now);
      pruneAutoRevisions(db, id, LIMITS.autoRevisionKeep);
    }
  }
  return result;
}

export function listRevisions(db: SqliteDatabase, chapterId: string): RevisionMeta[] {
  getChapterRow(db, chapterId);
  const rows = db
    .prepare('SELECT id, chapter_id, rev, word_count, reason, created_at FROM chapter_revision WHERE chapter_id = ? ORDER BY id DESC')
    .all(chapterId) as unknown as Omit<RevisionRow, 'title' | 'body'>[];
  return rows.map(toRevisionMeta);
}

export function createManualRevision(db: SqliteDatabase, chapterId: string, now: number): RevisionMeta {
  const id = insertRevision(db, getChapterRow(db, chapterId), 'manual', now);
  return toRevisionMeta(getRevisionRow(db, chapterId, id));
}

export function getRevision(db: SqliteDatabase, chapterId: string, revisionId: number): RevisionDetail {
  getChapterRow(db, chapterId);
  const row = getRevisionRow(db, chapterId, revisionId);
  return { ...toRevisionMeta(row), title: row.title, body: row.body };
}

/** 恢复版本（INV-4 / INV-6）：先校验 baseRev，再在同一事务里写 before_restore 快照、用版本的标题与正文覆盖。 */
export function restoreRevision(db: SqliteDatabase, chapterId: string, revisionId: number, baseRev: number, now: number): BodyWriteResult {
  const row = getChapterRow(db, chapterId);
  assertBaseRev(row, baseRev);
  const target = getRevisionRow(db, chapterId, revisionId);
  insertRevision(db, row, 'before_restore', now);
  return writeChapterBody(db, row, { body: target.body, title: target.title }, now);
}
