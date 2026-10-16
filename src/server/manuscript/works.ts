import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CreateWorkRequest, TrashedWork, UpdateWorkRequest, Work, WorkSummary } from '../../shared/types';
import { invalid, missing } from '../errors';
import type { WorkDbPool } from '../storage/db-pool';
import type { SqliteDatabase } from '../storage/sqlite';
import { WORK_ID_RE, isValidWorkId, openWorkDb } from '../storage/work-db';
import type { Logger } from '../system/logger';
import { getWorkRow, newId, normalizeMeta, normalizeTitle, touchWork } from './repo';
import { toWork } from './rows';
import { insertChapter, insertVolume } from './structure';

export const DEFAULT_VOLUME_TITLE = '第一卷';
export const DEFAULT_CHAPTER_TITLE = '第一章';

const WORK_FILE_RE = /^([0-9a-f-]{36})\.novel$/;
const TRASH_FILE_RE = /^([0-9a-f-]{36})-(\d{13})\.novel$/;

export function summarize(db: SqliteDatabase): WorkSummary {
  const w = getWorkRow(db);
  const stats = db
    .prepare(
      'SELECT count(*) AS n, coalesce(sum(c.word_count), 0) AS words FROM chapter c JOIN volume v ON v.id = c.volume_id ' +
        'WHERE c.deleted_at IS NULL AND v.deleted_at IS NULL',
    )
    .get() as { n: number; words: number };
  return { id: w.id, title: w.title, author: w.author, wordCount: stats.words, chapterCount: stats.n, updatedAt: w.updated_at };
}

export interface WorkLibraryOptions {
  pool: WorkDbPool;
  trashDir: string;
  appVersion: string;
  log: Logger;
  now: () => number;
}

/** 作品级操作：列表、新建、修改信息、删除（移入 trash/）、作品回收站（INV-5：绝不 unlink，除非用户彻底删除）。 */
export class WorkLibrary {
  private readonly o: WorkLibraryOptions;

  constructor(options: WorkLibraryOptions) {
    this.o = options;
  }

  list(): WorkSummary[] {
    const out: WorkSummary[] = [];
    for (const name of readdirSync(this.o.pool.dir)) {
      const workId = WORK_FILE_RE.exec(name)?.[1];
      if (workId === undefined || !isValidWorkId(workId)) continue;
      try {
        out.push(this.o.pool.withTransient(workId, summarize));
      } catch (err) {
        this.o.log.warn(`跳过无法打开的作品文件 ${name}`, err);
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  create(input: CreateWorkRequest): Work {
    const now = this.o.now();
    const workId = newId();
    const title = normalizeTitle(input.title, '作品名');
    const author = normalizeMeta(input.author ?? '', '作者');
    const genre = normalizeMeta(input.genre ?? '', '类型');
    const synopsis = normalizeMeta(input.synopsis ?? '', '简介');
    const db = this.o.pool.create(workId, (d) => {
      d.prepare('INSERT INTO work(id, title, author, genre, synopsis, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        workId,
        title,
        author,
        genre,
        synopsis,
        now,
        now,
      );
      const volumeId = insertVolume(d, DEFAULT_VOLUME_TITLE, now);
      d.prepare('UPDATE volume SET seq = 0 WHERE id = ?').run(volumeId);
      const chapterId = insertChapter(d, volumeId, DEFAULT_CHAPTER_TITLE, now);
      d.prepare('UPDATE chapter SET seq = 0 WHERE id = ?').run(chapterId);
    });
    return toWork(getWorkRow(db));
  }

  update(db: SqliteDatabase, patch: UpdateWorkRequest): Work {
    const now = this.o.now();
    const cur = getWorkRow(db);
    const next = {
      title: patch.title === undefined ? cur.title : normalizeTitle(patch.title, '作品名'),
      author: patch.author === undefined ? cur.author : normalizeMeta(patch.author, '作者'),
      genre: patch.genre === undefined ? cur.genre : normalizeMeta(patch.genre, '类型'),
      synopsis: patch.synopsis === undefined ? cur.synopsis : normalizeMeta(patch.synopsis, '简介'),
    };
    db.prepare('UPDATE work SET title = ?, author = ?, genre = ?, synopsis = ?').run(next.title, next.author, next.genre, next.synopsis);
    touchWork(db, now);
    return toWork(getWorkRow(db));
  }

  /** 删除作品：关闭连接后把文件移入 trash/{workId}-{deletedAt}.novel（不 unlink）。 */
  remove(workId: string): void {
    const file = this.o.pool.fileOf(workId);
    if (!existsSync(file)) throw missing('作品不存在');
    this.o.pool.close(workId);
    const dest = join(this.o.trashDir, `${workId}-${this.o.now()}.novel`);
    renameSync(file, dest);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${file}${suffix}`)) renameSync(`${file}${suffix}`, `${dest}${suffix}`);
    }
  }

  listTrash(): TrashedWork[] {
    const out: TrashedWork[] = [];
    for (const name of readdirSync(this.o.trashDir)) {
      const m = TRASH_FILE_RE.exec(name);
      if (m === null || !WORK_ID_RE.test(m[1] ?? '')) continue;
      const workId = m[1] ?? '';
      let title = '（无法读取的作品文件）';
      try {
        const db = openWorkDb(join(this.o.trashDir, name), workId, this.o.appVersion);
        try {
          title = getWorkRow(db).title;
        } finally {
          db.close();
        }
      } catch (err) {
        this.o.log.warn(`回收站中的作品文件无法读取：${name}`, err);
      }
      out.push({ file: name, workId, title, deletedAt: Number(m[2]) });
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  private trashFile(file: string): { path: string; workId: string } {
    const m = TRASH_FILE_RE.exec(file);
    const path = join(this.o.trashDir, file);
    if (m === null || !WORK_ID_RE.test(m[1] ?? '') || !existsSync(path)) throw missing('回收站中没有这部作品');
    return { path, workId: m[1] ?? '' };
  }

  restore(file: string): WorkSummary {
    const { path, workId } = this.trashFile(file);
    const dest = this.o.pool.fileOf(workId);
    if (existsSync(dest)) throw invalid('作品库中已存在同一部作品，无法恢复');
    const check = openWorkDb(path, workId, this.o.appVersion);
    check.close();
    renameSync(path, dest);
    return this.o.pool.withTransient(workId, summarize);
  }

  purge(file: string): void {
    const { path } = this.trashFile(file);
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  }
}
