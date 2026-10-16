import { existsSync, renameSync, rmSync } from 'node:fs';
import { SchemaTooNewError, migrate, readMeta, writeMeta } from './migrations';
import { openDatabase, type SqliteDatabase } from './sqlite';
import { tx } from './tx';

export type WorkDbErrorCode = 'NOT_FOUND' | 'EXISTS' | 'IDENTITY' | 'TOO_NEW' | 'CORRUPT';

export class WorkDbError extends Error {
  readonly code: WorkDbErrorCode;
  constructor(code: WorkDbErrorCode, message: string) {
    super(message);
    this.name = 'WorkDbError';
    this.code = code;
  }
}

/** workId 一律是小写 UUID：既是主键也是文件名，校验它可杜绝路径穿越。 */
export const WORK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidWorkId(id: string): boolean {
  return WORK_ID_RE.test(id);
}

/** 每个连接都要设置的 PRAGMA（ADR-003）。busy timeout 由 openDatabase 统一设为 5 s。 */
export function configureConnection(db: SqliteDatabase): void {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
}

/** INV-1：work 表恰好 1 行，且 work.id = meta.work_id = 文件名中的 workId。 */
export function assertWorkIdentity(db: SqliteDatabase, workId: string): void {
  const metaId = readMeta(db, 'work_id');
  if (metaId !== workId) throw new WorkDbError('IDENTITY', `作品文件身份不符：文件名 ${workId}，meta.work_id ${String(metaId)}`);
  const rows = db.prepare('SELECT id FROM work').all() as { id: string }[];
  if (rows.length !== 1 || rows[0]?.id !== workId) {
    throw new WorkDbError('IDENTITY', `作品文件的 work 表应恰好 1 行且 id 为 ${workId}，实际 ${rows.length} 行`);
  }
}

function wrapOpenError(err: unknown, file: string): WorkDbError {
  if (err instanceof WorkDbError) return err;
  if (err instanceof SchemaTooNewError) return new WorkDbError('TOO_NEW', err.message);
  const message = err instanceof Error ? err.message : String(err);
  return new WorkDbError('CORRUPT', `无法打开作品文件 ${file}：${message}`);
}

export function openWorkDb(file: string, workId: string, appVersion: string): SqliteDatabase {
  if (!existsSync(file)) throw new WorkDbError('NOT_FOUND', `作品不存在：${workId}`);
  let db: SqliteDatabase | null = null;
  try {
    db = openDatabase(file);
    configureConnection(db);
    migrate(db, appVersion);
    assertWorkIdentity(db, workId);
    return db;
  } catch (err) {
    db?.close();
    throw wrapOpenError(err, file);
  }
}

function removeWithSidecars(file: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${file}${suffix}`, { force: true });
}

/**
 * 新建作品库：先在 `{file}.creating` 中建表并执行 seed（与写入 meta.work_id 同一事务），
 * 校验 INV-1 后关闭、整体 rename 到目标位置，作品库里不会出现半成品文件。
 */
export function createWorkDb(file: string, workId: string, appVersion: string, seed: (db: SqliteDatabase) => void): void {
  if (!isValidWorkId(workId)) throw new WorkDbError('IDENTITY', `非法的 workId：${workId}`);
  if (existsSync(file)) throw new WorkDbError('EXISTS', `作品文件已存在：${file}`);
  const temp = `${file}.creating`;
  removeWithSidecars(temp);
  const db = openDatabase(temp);
  try {
    configureConnection(db);
    migrate(db, appVersion);
    tx(db, () => {
      writeMeta(db, 'work_id', workId);
      seed(db);
    });
    assertWorkIdentity(db, workId);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (err) {
    db.close();
    removeWithSidecars(temp);
    throw err;
  }
  db.close();
  for (const suffix of ['-wal', '-shm']) rmSync(`${temp}${suffix}`, { force: true });
  renameSync(temp, file);
}
