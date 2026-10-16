import * as sqlite from 'node:sqlite';

export type SqliteDatabase = InstanceType<typeof sqlite.DatabaseSync>;

/** Node 26 中 DatabaseSync 已改名为 Database（旧名为弃用别名，DEP0210），两者都兼容（ADR-003）。 */
const DatabaseCtor: typeof sqlite.DatabaseSync =
  (sqlite as unknown as { Database?: typeof sqlite.DatabaseSync }).Database ?? sqlite.DatabaseSync;

export function openDatabase(path: string, options: sqlite.DatabaseSyncOptions = {}): SqliteDatabase {
  return new DatabaseCtor(path, { timeout: 5000, ...options });
}
