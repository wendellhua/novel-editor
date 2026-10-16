import type { SqliteDatabase } from '../sqlite';
import { tx } from '../tx';
import { migration001 } from './001-initial';
import { migration002 } from './002-creative';
import type { Migration } from './types';

export type { Migration } from './types';

/** 代码所支持的最新 schema 版本（§6.5：必须等于迁移列表的最后一个版本号）。 */
export const SCHEMA_VERSION = 2;

export const MIGRATIONS: readonly Migration[] = [migration001, migration002];

/**
 * §6.5 静态数据约束，返回全部问题：SCHEMA_VERSION 是 ≥ 1 的整数；版本号从 1 开始连续递增；
 * 每个迁移有非空 name 与 up()；最新版本等于 SCHEMA_VERSION。
 */
export function findMigrationProblems(list: readonly Migration[] = MIGRATIONS, latest: number = SCHEMA_VERSION): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(latest) || latest < 1) problems.push(`SCHEMA_VERSION 必须是 ≥ 1 的整数：${String(latest)}`);
  list.forEach((m, i) => {
    if (m.version !== i + 1) problems.push(`迁移版本号必须从 1 连续递增：第 ${i + 1} 个迁移的版本号是 ${String(m.version)}`);
    if (typeof m.name !== 'string' || m.name.trim() === '') problems.push(`第 ${i + 1} 个迁移缺少 name`);
    if (typeof m.up !== 'function') problems.push(`第 ${i + 1} 个迁移（${String(m.name)}）缺少 up()`);
  });
  const last = list.at(-1)?.version ?? 0;
  if (last !== latest) problems.push(`最新迁移版本 ${String(last)} 与 SCHEMA_VERSION ${String(latest)} 不一致`);
  return problems;
}

export function validateMigrations(list: readonly Migration[] = MIGRATIONS, latest: number = SCHEMA_VERSION): void {
  const problems = findMigrationProblems(list, latest);
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

function hasMetaTable(db: SqliteDatabase): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() !== undefined;
}

export function readMeta(db: SqliteDatabase, key: string): string | null {
  if (!hasMetaTable(db)) return null;
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function writeMeta(db: SqliteDatabase, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function currentSchemaVersion(db: SqliteDatabase): number {
  const raw = readMeta(db, 'schema_version');
  if (raw === null) return 0;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0) throw new Error(`meta.schema_version 非法：${raw}`);
  return v;
}

export class SchemaTooNewError extends Error {
  readonly fileVersion: number;
  constructor(fileVersion: number) {
    super(`作品文件的数据版本（${fileVersion}）高于本程序支持的版本（${SCHEMA_VERSION}），请升级 NovelEditor`);
    this.name = 'SchemaTooNewError';
    this.fileVersion = fileVersion;
  }
}

/**
 * 逐个执行未应用的迁移；每个迁移连同 meta 更新放在同一个事务里。
 * rebuildsTables 的迁移在事务外关闭外键（PRAGMA foreign_keys 在事务内无效），提交前 foreign_key_check 必须为空，结束后恢复。
 */
export function migrate(db: SqliteDatabase, appVersion: string, list: readonly Migration[] = MIGRATIONS): { from: number; to: number } {
  const from = currentSchemaVersion(db);
  const latest = list.at(-1)?.version ?? 0;
  if (from > latest) throw new SchemaTooNewError(from);
  for (const m of list) {
    if (m.version <= from) continue;
    const fkWasOn = m.rebuildsTables === true && (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1;
    if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx(db, () => {
        m.up(db);
        if (m.rebuildsTables === true) {
          const broken = db.prepare('PRAGMA foreign_key_check').all();
          if (broken.length > 0) throw new Error(`迁移 ${m.version}（${m.name}）后外键检查失败：${JSON.stringify(broken.slice(0, 5))}`);
        }
        writeMeta(db, 'schema_version', String(m.version));
        writeMeta(db, 'app_version', appVersion);
      });
    } finally {
      if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
    }
  }
  return { from, to: Math.max(from, latest) };
}
