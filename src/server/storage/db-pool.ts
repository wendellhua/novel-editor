import { join } from 'node:path';
import type { Logger } from '../system/logger';
import type { SqliteDatabase } from './sqlite';
import { WorkDbError, createWorkDb, isValidWorkId, openWorkDb } from './work-db';

export const DEFAULT_MAX_OPEN = 8;

interface Entry {
  db: SqliteDatabase;
  pins: number;
}

export interface Lease {
  db: SqliteDatabase;
  release(): void;
}

export interface WorkDbPoolOptions {
  dir: string;
  appVersion: string;
  log: Logger;
  max?: number;
  /** 某作品库被放入连接池（非临时打开）后调用，用于每日备份等。 */
  onOpen?: (workId: string, pool: WorkDbPool) => void;
}

/**
 * 作品库连接池（ADR-003）：按 LRU 最多同时打开 max 个库，超出时关闭最久未用且未被 pin 的连接。
 * 使用规则：`get()` 拿到的连接只在当前同步代码段内有效，不要跨 await 持有；需要跨 await 时用 `pin()`。
 */
export class WorkDbPool {
  readonly dir: string;
  private readonly appVersion: string;
  private readonly log: Logger;
  private readonly max: number;
  private readonly onOpen: WorkDbPoolOptions['onOpen'];
  private readonly entries = new Map<string, Entry>();

  constructor(options: WorkDbPoolOptions) {
    this.dir = options.dir;
    this.appVersion = options.appVersion;
    this.log = options.log;
    this.max = options.max ?? DEFAULT_MAX_OPEN;
    this.onOpen = options.onOpen;
  }

  fileOf(workId: string): string {
    if (!isValidWorkId(workId)) throw new WorkDbError('NOT_FOUND', `作品不存在：${workId}`);
    return join(this.dir, `${workId}.novel`);
  }

  get size(): number {
    return this.entries.size;
  }

  has(workId: string): boolean {
    return this.entries.has(workId);
  }

  get(workId: string): SqliteDatabase {
    return this.entry(workId).db;
  }

  pin(workId: string): Lease {
    const entry = this.entry(workId);
    entry.pins++;
    let released = false;
    return {
      db: entry.db,
      release: () => {
        if (released) return;
        released = true;
        entry.pins--;
        this.evict();
      },
    };
  }

  /** 已在池中就复用；否则临时打开、用完即关，不占用池位置（用于作品列表等批量只读场景）。 */
  withTransient<T>(workId: string, fn: (db: SqliteDatabase) => T): T {
    const cached = this.entries.get(workId);
    if (cached !== undefined) return fn(cached.db);
    const db = openWorkDb(this.fileOf(workId), workId, this.appVersion);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  create(workId: string, seed: (db: SqliteDatabase) => void): SqliteDatabase {
    createWorkDb(this.fileOf(workId), workId, this.appVersion, seed);
    return this.get(workId);
  }

  close(workId: string): void {
    const entry = this.entries.get(workId);
    if (entry === undefined) return;
    if (entry.pins > 0) throw new Error(`作品 ${workId} 正被使用，不能关闭`);
    this.entries.delete(workId);
    this.safeClose(workId, entry.db);
  }

  closeAll(): void {
    for (const [workId, entry] of this.entries) this.safeClose(workId, entry.db);
    this.entries.clear();
  }

  private entry(workId: string): Entry {
    const existing = this.entries.get(workId);
    if (existing !== undefined) {
      this.entries.delete(workId);
      this.entries.set(workId, existing);
      return existing;
    }
    const entry: Entry = { db: openWorkDb(this.fileOf(workId), workId, this.appVersion), pins: 0 };
    this.entries.set(workId, entry);
    this.evict(workId);
    try {
      this.onOpen?.(workId, this);
    } catch (err) {
      this.log.warn(`作品 ${workId} 打开后的钩子执行失败`, err);
    }
    return entry;
  }

  /** 从最久未用开始关闭未被 pin 的连接；keep 是正要返回给调用方的条目，永不淘汰。 */
  private evict(keep?: string): void {
    if (this.entries.size <= this.max) return;
    for (const [workId, entry] of this.entries) {
      if (this.entries.size <= this.max) return;
      if (entry.pins > 0 || workId === keep) continue;
      this.entries.delete(workId);
      this.safeClose(workId, entry.db);
    }
  }

  private safeClose(workId: string, db: SqliteDatabase): void {
    try {
      if (db.isOpen) db.close();
    } catch (err) {
      this.log.warn(`关闭作品库 ${workId} 失败`, err);
    }
  }
}
