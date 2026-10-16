import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as sqlite from 'node:sqlite';
import type { SqliteDatabase } from './sqlite';

const BACKUP_FILE_RE = /^(\d{8})\.novel$/;

export function localDateStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

export function dailyBackupFile(backupsRoot: string, workId: string, date: Date): string {
  return join(backupsRoot, workId, `${localDateStamp(date)}.novel`);
}

/** 在线整库备份（sqlite.backup）：先写临时文件再 rename，备份中途失败不会留下残缺文件。调用期间源连接必须保持打开。 */
export async function backupDatabase(db: SqliteDatabase, destFile: string): Promise<void> {
  mkdirSync(dirname(destFile), { recursive: true });
  const temp = `${destFile}.partial`;
  rmSync(temp, { force: true });
  try {
    await sqlite.backup(db, temp);
    renameSync(temp, destFile);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  } finally {
    for (const suffix of ['-wal', '-shm']) rmSync(`${temp}${suffix}`, { force: true });
  }
}

/** 只保留日期最新的 keep 份 `{YYYYMMDD}.novel`，返回被删除的文件名。 */
export function pruneBackups(dir: string, keep: number): string[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((n) => BACKUP_FILE_RE.test(n))
    .sort()
    .reverse();
  const removed = files.slice(keep);
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return removed;
}
