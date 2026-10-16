import { join } from 'node:path';
import { Manuscript } from '../../src/server/manuscript';
import { DailyBackupScheduler } from '../../src/server/storage/daily-backup';
import { WorkDbPool } from '../../src/server/storage/db-pool';
import { createSilentLogger } from '../../src/server/system/logger';
import { dataPaths, ensureDataDirs, type DataPaths } from '../../src/server/system/paths';
import { makeTempDir } from './tmp';

export interface ManuscriptFixture {
  ms: Manuscript;
  pool: WorkDbPool;
  paths: DataPaths;
  backups: DailyBackupScheduler;
  clock: { t: number };
  events: { workId: string; chapterId: string; rev: number }[];
  cleanup(): void;
}

export function makeManuscript(options: { backups?: boolean } = {}): ManuscriptFixture {
  const tmp = makeTempDir('ne-ms-');
  const paths = dataPaths(tmp.dir);
  ensureDataDirs(paths);
  const log = createSilentLogger();
  const clock = { t: Date.UTC(2026, 9, 9, 2, 0, 0) };
  const backups = new DailyBackupScheduler({ backupsRoot: paths.backups, keep: 7, log, now: () => new Date(clock.t) });
  const pool = new WorkDbPool({
    dir: paths.works,
    appVersion: 'test',
    log,
    onOpen: options.backups === true ? backups.onOpen : undefined,
  });
  const events: ManuscriptFixture['events'] = [];
  const ms = new Manuscript({
    pool,
    trashDir: paths.trash,
    appVersion: 'test',
    log,
    now: () => clock.t,
    onChapterUpdated: (workId, chapterId, rev) => events.push({ workId, chapterId, rev }),
  });
  return {
    ms,
    pool,
    paths,
    backups,
    clock,
    events,
    cleanup: () => {
      pool.closeAll();
      tmp.cleanup();
    },
  };
}

export const worksFile = (paths: DataPaths, workId: string): string => join(paths.works, `${workId}.novel`);
