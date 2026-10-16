import type { Logger } from '../system/logger';
import type { WorkDbPool } from './db-pool';
import type { SqliteDatabase } from './sqlite';
import { tx } from './tx';

export const FTS_FLUSH_DELAY_MS = 3000;

export function pendingFtsCount(db: SqliteDatabase): number {
  return (db.prepare('SELECT count(*) AS n FROM chapter_fts_dirty').get() as { n: number }).n;
}

/**
 * 把脏行重建进全文索引（同步、单事务）。任何 FTS 查询之前都必须先调用本函数，保证索引与正文一致。
 * 返回重建的章节数。
 */
export function flushFtsIndex(db: SqliteDatabase): number {
  const rids = (db.prepare('SELECT rid FROM chapter_fts_dirty ORDER BY rid').all() as { rid: number }[]).map((r) => r.rid);
  if (rids.length === 0) return 0;
  const del = db.prepare('DELETE FROM chapter_fts WHERE rowid = ?');
  const ins = db.prepare('INSERT INTO chapter_fts(rowid, body) SELECT rid, body FROM chapter WHERE rid = ?');
  const clear = db.prepare('DELETE FROM chapter_fts_dirty WHERE rid = ?');
  tx(db, () => {
    for (const rid of rids) {
      del.run(rid);
      ins.run(rid);
      clear.run(rid);
    }
  });
  return rids.length;
}

/** 按词长选择检索方式（ADR-003）：≥ 3 字走 trigram MATCH（按短语），< 3 字回退 instr()。返回章节 rid。 */
export function searchChapterRids(db: SqliteDatabase, term: string): number[] {
  const t = term.trim();
  if (t === '') return [];
  if ([...t].length >= 3) {
    flushFtsIndex(db);
    const phrase = `"${t.replace(/"/g, '""')}"`;
    return (db.prepare('SELECT rowid AS rid FROM chapter_fts WHERE chapter_fts MATCH ? ORDER BY rowid').all(phrase) as { rid: number }[]).map((r) => r.rid);
  }
  return (db.prepare('SELECT rid FROM chapter WHERE instr(body, ?) > 0 ORDER BY rid').all(t) as { rid: number }[]).map((r) => r.rid);
}

/** 后台索引器：作品有正文写入后防抖 FTS_FLUSH_DELAY_MS 再重建，把索引开销移出保存请求路径。 */
export class FtsIndexer {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pool: WorkDbPool;
  private readonly log: Logger;
  private readonly delayMs: number;

  constructor(options: { pool: WorkDbPool; log: Logger; delayMs?: number }) {
    this.pool = options.pool;
    this.log = options.log;
    this.delayMs = options.delayMs ?? FTS_FLUSH_DELAY_MS;
  }

  schedule(workId: string): void {
    const existing = this.timers.get(workId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(workId);
      this.flushNow(workId);
    }, this.delayMs);
    timer.unref();
    this.timers.set(workId, timer);
  }

  flushNow(workId: string): number {
    try {
      return flushFtsIndex(this.pool.get(workId));
    } catch (err) {
      this.log.warn(`重建作品 ${workId} 的全文索引失败，将在下次查询前重试`, err);
      return 0;
    }
  }

  /** 退出前调用：立即处理所有已排队的作品并清除定时器。 */
  flushAll(): void {
    for (const [workId, timer] of this.timers) {
      clearTimeout(timer);
      this.flushNow(workId);
    }
    this.timers.clear();
  }

  get scheduled(): number {
    return this.timers.size;
  }
}
