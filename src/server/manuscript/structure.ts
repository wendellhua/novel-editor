import type { Chapter, ChapterNode, TrashItemRef, TrashList, VolumeNode, WorkTree } from '../../shared/types';
import { invalid, missing } from '../errors';
import type { SqliteDatabase } from '../storage/sqlite';
import {
  EMPTY_BODY_HASH,
  getChapterRow,
  getVolumeRow,
  getWorkRow,
  listLiveChapterNodes,
  listLiveVolumes,
  newId,
  normalizeTitle,
  placeChapterAfter,
  placeChapterAt,
  placeVolume,
  purgeChapter,
  purgeVolume,
  renumberChapters,
  renumberVolumes,
  reorderChapters,
  reorderVolumes,
  touchWork,
} from './repo';
import { toChapter, toChapterNode, toWork, type VolumeRow } from './rows';

function toVolumeNode(v: VolumeRow, chapters: ChapterNode[]): VolumeNode {
  return { id: v.id, title: v.title, seq: v.seq, chapters };
}

export function getTree(db: SqliteDatabase): WorkTree {
  const volumes = listLiveVolumes(db);
  const byVolume = new Map<string, ChapterNode[]>(volumes.map((v) => [v.id, []]));
  for (const row of listLiveChapterNodes(db)) byVolume.get(row.volume_id)?.push(toChapterNode(row));
  return { work: toWork(getWorkRow(db)), volumes: volumes.map((v) => toVolumeNode(v, byVolume.get(v.id) ?? [])) };
}

function volumeNode(db: SqliteDatabase, id: string): VolumeNode {
  const v = getVolumeRow(db, id);
  return toVolumeNode(v, listLiveChapterNodes(db, id).map(toChapterNode));
}

// ---------------- 分卷 ----------------

export function insertVolume(db: SqliteDatabase, title: string, now: number): string {
  const id = newId();
  db.prepare('INSERT INTO volume(id, title, seq, created_at, updated_at) VALUES (?, ?, 2147483647, ?, ?)').run(id, normalizeTitle(title, '分卷标题'), now, now);
  return id;
}

export function createVolume(db: SqliteDatabase, input: { title: string; afterVolumeId?: string | null }, now: number): VolumeNode {
  const id = insertVolume(db, input.title, now);
  placeVolume(db, id, input.afterVolumeId);
  touchWork(db, now);
  return volumeNode(db, id);
}

export function renameVolume(db: SqliteDatabase, id: string, title: string, now: number): VolumeNode {
  getVolumeRow(db, id);
  db.prepare('UPDATE volume SET title = ?, updated_at = ? WHERE id = ?').run(normalizeTitle(title, '分卷标题'), now, id);
  touchWork(db, now);
  return volumeNode(db, id);
}

export function deleteVolume(db: SqliteDatabase, id: string, now: number): void {
  getVolumeRow(db, id);
  db.prepare('UPDATE volume SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
  renumberVolumes(db);
  touchWork(db, now);
}

export function setVolumeOrder(db: SqliteDatabase, ids: readonly string[], now: number): void {
  reorderVolumes(db, ids);
  touchWork(db, now);
}

// ---------------- 章节 ----------------

export function insertChapter(db: SqliteDatabase, volumeId: string, title: string, now: number): string {
  const id = newId();
  db.prepare(
    'INSERT INTO chapter(id, volume_id, title, seq, body, word_count, body_hash, rev, created_at, updated_at) ' +
      "VALUES (?, ?, ?, 2147483647, '', 0, ?, 0, ?, ?)",
  ).run(id, volumeId, normalizeTitle(title, '章节标题'), EMPTY_BODY_HASH, now, now);
  return id;
}

export function createChapter(
  db: SqliteDatabase,
  input: { volumeId: string; title: string; afterChapterId?: string | null },
  now: number,
): Chapter {
  getVolumeRow(db, input.volumeId);
  if (input.afterChapterId != null) {
    const after = getChapterRow(db, input.afterChapterId);
    if (after.volume_id !== input.volumeId) throw invalid('参照章节不在该分卷中');
  }
  const id = insertChapter(db, input.volumeId, input.title, now);
  placeChapterAfter(db, input.volumeId, id, input.afterChapterId);
  touchWork(db, now);
  return toChapter(getChapterRow(db, id));
}

export function renameChapter(db: SqliteDatabase, id: string, title: string, now: number): ChapterNode {
  getChapterRow(db, id);
  db.prepare('UPDATE chapter SET title = ?, updated_at = ? WHERE id = ?').run(normalizeTitle(title, '章节标题'), now, id);
  touchWork(db, now);
  return toChapterNode(getChapterRow(db, id));
}

export function deleteChapter(db: SqliteDatabase, id: string, now: number): void {
  const row = getChapterRow(db, id);
  db.prepare('UPDATE chapter SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
  renumberChapters(db, row.volume_id);
  touchWork(db, now);
}

/** 移动章节到目标卷的 index 位置（同卷内即为调整顺序），两侧 seq 都整体重排（INV-2）。 */
export function moveChapter(db: SqliteDatabase, id: string, input: { volumeId: string; index: number }, now: number): void {
  if (!Number.isInteger(input.index) || input.index < 0) throw invalid('index 必须是非负整数');
  const row = getChapterRow(db, id);
  getVolumeRow(db, input.volumeId);
  placeChapterAt(db, input.volumeId, id, input.index);
  if (row.volume_id !== input.volumeId) renumberChapters(db, row.volume_id);
  touchWork(db, now);
}

export function setChapterOrder(db: SqliteDatabase, volumeId: string, ids: readonly string[], now: number): void {
  getVolumeRow(db, volumeId);
  reorderChapters(db, volumeId, ids);
  touchWork(db, now);
}

// ---------------- 作品内回收站（INV-5） ----------------

export function getTrash(db: SqliteDatabase): TrashList {
  const volumes = db
    .prepare('SELECT id, title, deleted_at FROM volume WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')
    .all() as { id: string; title: string; deleted_at: number }[];
  const chapters = db
    .prepare('SELECT id, volume_id, title, deleted_at FROM chapter WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')
    .all() as { id: string; volume_id: string; title: string; deleted_at: number }[];
  return {
    volumes: volumes.map((v) => ({ id: v.id, title: v.title, deletedAt: v.deleted_at })),
    chapters: chapters.map((c) => ({ id: c.id, volumeId: c.volume_id, title: c.title, deletedAt: c.deleted_at })),
  };
}

function restoreVolumeRow(db: SqliteDatabase, id: string, now: number): void {
  db.prepare('UPDATE volume SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, id);
  placeVolume(db, id, null);
}

/** 恢复到所在父级的末尾；恢复的章节所在分卷也在回收站时，一并恢复该分卷。 */
export function restoreTrashItem(db: SqliteDatabase, ref: TrashItemRef, now: number): void {
  if (ref.kind === 'volume') {
    const v = getVolumeRow(db, ref.id, { allowDeleted: true });
    if (v.deleted_at === null) throw invalid('该分卷不在回收站中');
    restoreVolumeRow(db, ref.id, now);
  } else {
    const c = getChapterRow(db, ref.id, { allowDeleted: true });
    if (c.deleted_at === null) throw invalid('该章节不在回收站中');
    const v = getVolumeRow(db, c.volume_id, { allowDeleted: true });
    if (v.deleted_at !== null) restoreVolumeRow(db, v.id, now);
    db.prepare('UPDATE chapter SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now, ref.id);
    placeChapterAfter(db, c.volume_id, ref.id, null);
  }
  touchWork(db, now);
}

export function purgeTrashItem(db: SqliteDatabase, ref: TrashItemRef): void {
  if (ref.kind === 'volume') {
    const v = getVolumeRow(db, ref.id, { allowDeleted: true });
    if (v.deleted_at === null) throw invalid('只能彻底删除回收站中的分卷');
    purgeVolume(db, ref.id);
  } else {
    const c = getChapterRow(db, ref.id, { allowDeleted: true });
    if (c.deleted_at === null) throw invalid('只能彻底删除回收站中的章节');
    purgeChapter(db, ref.id);
  }
}

export function emptyTrash(db: SqliteDatabase): void {
  const trash = getTrash(db);
  for (const v of trash.volumes) purgeVolume(db, v.id);
  for (const c of trash.chapters) {
    if (db.prepare('SELECT 1 FROM chapter WHERE id = ?').get(c.id) !== undefined) purgeChapter(db, c.id);
  }
}

export function assertTrashRef(ref: unknown): asserts ref is TrashItemRef {
  const r = ref as Partial<TrashItemRef> | null;
  if (r === null || (r.kind !== 'volume' && r.kind !== 'chapter') || typeof r.id !== 'string') throw missing('回收站条目不存在');
}
