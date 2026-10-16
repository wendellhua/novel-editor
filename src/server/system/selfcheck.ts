import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SelfcheckResult } from '../../shared/types';
import { openDatabase, type SqliteDatabase } from '../storage/sqlite';

function scalar(db: SqliteDatabase, sql: string, ...params: string[]): unknown {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : Object.values(row)[0];
}

/** 在作品目录里真实建库读写一次，确认 SQLite、FTS5 与中文 trigram 检索可用（T4 打包验证、诊断用）。 */
export function runSelfcheck(dir: string): SelfcheckResult {
  const file = join(dir, `.selfcheck-${process.pid}-${randomBytes(3).toString('hex')}.db`);
  let db: SqliteDatabase | null = null;
  try {
    db = openDatabase(file);
    db.exec('PRAGMA journal_mode = WAL');
    const sqliteVersion = String(scalar(db, 'SELECT sqlite_version()'));
    const fts5 = scalar(db, "SELECT sqlite_compileoption_used('ENABLE_FTS5')") === 1;
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(body, tokenize='trigram')");
    db.prepare('INSERT INTO probe(body) VALUES (?)').run('林惊羽在青云山下拔出了噬魂棒');
    const trigram = scalar(db, 'SELECT count(*) FROM probe WHERE probe MATCH ?', '噬魂棒') === 1;
    return { ok: fts5 && trigram, sqliteVersion, fts5, trigram, error: null };
  } catch (err) {
    return { ok: false, sqliteVersion: '', fts5: false, trigram: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    db?.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  }
}
