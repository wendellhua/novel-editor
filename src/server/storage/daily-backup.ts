import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../system/logger';
import { backupDatabase, dailyBackupFile, pruneBackups } from './backup';
import type { WorkDbPool } from './db-pool';

export interface DailyBackupOptions {
  backupsRoot: string;
  keep: number;
  log: Logger;
  now?: () => Date;
}

/**
 * 每日整库备份（ADR-004 L3）：作品当天第一次放入连接池时，后台备份到 `backups/{workId}/{YYYYMMDD}.novel`，
 * 只保留最新 keep 份。备份期间 pin 住连接，避免被 LRU 关闭。失败只记日志，不影响写作。
 */
export class DailyBackupScheduler {
  private readonly running = new Map<string, Promise<void>>();
  private readonly options: DailyBackupOptions;

  constructor(options: DailyBackupOptions) {
    this.options = options;
  }

  /** 作为 WorkDbPool 的 onOpen 钩子使用。 */
  readonly onOpen = (workId: string, pool: WorkDbPool): void => {
    void this.ensure(workId, pool);
  };

  ensure(workId: string, pool: WorkDbPool): Promise<void> {
    const pending = this.running.get(workId);
    if (pending !== undefined) return pending;
    const { backupsRoot, keep, log, now = () => new Date() } = this.options;
    const dest = dailyBackupFile(backupsRoot, workId, now());
    if (existsSync(dest)) return Promise.resolve();
    const lease = pool.pin(workId);
    const task = backupDatabase(lease.db, dest)
      .then(() => {
        const removed = pruneBackups(join(backupsRoot, workId), keep);
        log.info(`已备份作品 ${workId} → ${dest}${removed.length > 0 ? `（清理旧备份 ${removed.join(', ')}）` : ''}`);
      })
      .catch((err: unknown) => log.error(`备份作品 ${workId} 失败`, err))
      .finally(() => {
        lease.release();
        this.running.delete(workId);
      });
    this.running.set(workId, task);
    return task;
  }

  async whenIdle(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }
}
