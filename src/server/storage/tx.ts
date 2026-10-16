import type { SqliteDatabase } from './sqlite';

const depth = new WeakMap<SqliteDatabase, number>();

/**
 * 事务封装（ADR-003）：最外层 `BEGIN IMMEDIATE … COMMIT`，嵌套调用使用 SAVEPOINT。
 * fn 抛错时回滚本层并重新抛出。fn 必须是同步函数：node:sqlite 为同步 API，跨 await 持有事务会阻塞其他写入。
 */
export function tx<T>(db: SqliteDatabase, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const savepoint = `sp_${level}`;
  db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  depth.set(db, level + 1);
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('tx() 的回调必须是同步函数');
    db.exec(level === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    if (db.isOpen && db.isTransaction) {
      db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    }
    throw err;
  } finally {
    depth.set(db, level);
  }
}
