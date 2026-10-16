import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupDatabase, dailyBackupFile, pruneBackups } from '../../src/server/storage/backup';
import { WorkDbPool } from '../../src/server/storage/db-pool';
import { FtsIndexer, flushFtsIndex, pendingFtsCount, searchChapterRids } from '../../src/server/storage/fts';
import { MIGRATIONS, SCHEMA_VERSION, migrate, validateMigrations, writeMeta } from '../../src/server/storage/migrations';
import { openDatabase, type SqliteDatabase } from '../../src/server/storage/sqlite';
import { tx } from '../../src/server/storage/tx';
import { WorkDbError, createWorkDb, openWorkDb } from '../../src/server/storage/work-db';
import { createSilentLogger } from '../../src/server/system/logger';
import { makeTempDir } from '../helpers/tmp';

const APP = 'test';
let tmp: ReturnType<typeof makeTempDir>;
beforeEach(() => {
  tmp = makeTempDir('ne-storage-');
});
afterEach(() => tmp.cleanup());

function seedWork(workId: string) {
  return (db: SqliteDatabase): void => {
    db.prepare('INSERT INTO work(id, title, created_at, updated_at) VALUES (?, ?, 1, 1)').run(workId, '测试作品');
    db.prepare("INSERT INTO volume(id, title, seq, created_at, updated_at) VALUES ('v1', '第一卷', 0, 1, 1)").run();
  };
}

function newWork(): { workId: string; file: string } {
  const workId = randomUUID();
  const file = join(tmp.dir, `${workId}.novel`);
  createWorkDb(file, workId, APP, seedWork(workId));
  return { workId, file };
}

function insertChapter(db: SqliteDatabase, id: string, body: string): void {
  db.prepare(
    "INSERT INTO chapter(id, volume_id, title, seq, body, body_hash, created_at, updated_at) VALUES (?, 'v1', ?, 0, ?, 'h', 1, 1)",
  ).run(id, id, body);
}

/** 直接查索引（不冲刷），用来观察延迟索引的中间状态。 */
const matchCount = (db: SqliteDatabase, term: string): number =>
  (db.prepare('SELECT count(*) AS n FROM chapter_fts WHERE chapter_fts MATCH ?').get(`"${term}"`) as { n: number }).n;

describe('迁移（§6.5 静态数据约束）', () => {
  it('内置迁移列表合法，最新版本等于 SCHEMA_VERSION', () => {
    expect(() => validateMigrations()).not.toThrow();
    expect(MIGRATIONS.at(-1)?.version).toBe(SCHEMA_VERSION);
  });

  it('版本号不连续或与 SCHEMA_VERSION 不符时报错', () => {
    const m = (version: number) => ({ version, name: `m${version}`, up: () => undefined });
    expect(() => validateMigrations([m(1), m(3)], 3)).toThrow('连续递增');
    expect(() => validateMigrations([m(2)], 2)).toThrow('连续递增');
    expect(() => validateMigrations([m(1), m(2)], 3)).toThrow('不一致');
  });

  it('迁移失败时整体回滚，版本号不前进', () => {
    const db = openDatabase(join(tmp.dir, 'm.db'));
    const bad = [
      ...MIGRATIONS,
      { version: SCHEMA_VERSION + 1, name: 'bad', up: (d: SqliteDatabase) => d.exec('CREATE TABLE x(a); SELECT * FROM nope;') },
    ];
    expect(() => migrate(db, APP, bad)).toThrow();
    expect((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe(String(SCHEMA_VERSION));
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='x'").get()).toBeUndefined();
    db.close();
  });

  it('v1 → v2（重建 job / issue / chapter_revision）：数据、顺序、自增 id 与外键级联都保留，外键在迁移后重新开启', () => {
    const file = join(tmp.dir, 'v1.db');
    const db = openDatabase(file);
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, APP, [MIGRATIONS[0]!]);
    db.exec(`
INSERT INTO volume(id, title, seq, created_at, updated_at) VALUES ('v1', '卷', 0, 1, 1);
INSERT INTO chapter(id, volume_id, title, seq, body, body_hash, created_at, updated_at) VALUES ('c1', 'v1', '章', 0, '正文', 'h', 1, 1);
INSERT INTO chapter_revision(chapter_id, rev, title, body, word_count, reason, created_at) VALUES ('c1', 1, '章', '旧1', 2, 'auto', 1), ('c1', 2, '章', '旧2', 2, 'before_fix', 2);
INSERT INTO job(id, type, skill_id, scope_kind, scope_id, profile_id, status, total_units, done_units, created_at) VALUES
  ('j2', 'review', 's', 'work', 'w', 'p', 'done', 1, 1, 5), ('j1', 'typo', 's', 'work', 'w', 'p', 'done', 1, 1, 5);
INSERT INTO job_unit(job_id, phase, chapter_id, chunk_index, range_start, range_end, body_hash, status) VALUES ('j1', 'main', 'c1', 0, 0, 2, 'h', 'done');
INSERT INTO issue(id, job_id, chapter_id, category, severity, excerpt, target, start_offset, end_offset, replacement, message, body_hash, status, created_at, updated_at)
  VALUES ('i1', 'j1', 'c1', 'typo', 'error', '正文', '正', 0, 1, '证', '错字', 'h', 'open', 1, 1);
INSERT INTO job_report(job_id, chapter_id, markdown) VALUES ('j2', '', '报告');
`);
    migrate(db, APP);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: String(SCHEMA_VERSION) });
    expect(db.prepare('PRAGMA foreign_keys').get(), '迁移后重新开启外键').toEqual({ foreign_keys: 1 });
    expect(db.prepare('SELECT id, options FROM job ORDER BY rowid').all(), '保留插入顺序，options 默认 {}').toEqual([
      { id: 'j2', options: '{}' },
      { id: 'j1', options: '{}' },
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM job_unit').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT id, replacement FROM issue').all()).toEqual([{ id: 'i1', replacement: '证' }]);
    expect(db.prepare('SELECT id, reason FROM chapter_revision ORDER BY id').all()).toEqual([
      { id: 1, reason: 'auto' },
      { id: 2, reason: 'before_fix' },
    ]);
    // 新的 CHECK 约束：新类型 / 类别 / 原因可以写入，未知值仍被拒绝
    db.exec("INSERT INTO job(id, type, skill_id, scope_kind, scope_id, profile_id, status, created_at) VALUES ('j3', 'memory', 's', 'work', 'w', 'p', 'done', 6)");
    db.exec("INSERT INTO issue(id, job_id, chapter_id, category, severity, excerpt, target, start_offset, end_offset, message, body_hash, status, created_at, updated_at) VALUES ('i2', 'j3', 'c1', 'ai_flavor', 'info', '正文', '正', 0, 1, 'm', 'h', 'open', 1, 1)");
    expect(() => db.exec("INSERT INTO job(id, type, skill_id, scope_kind, scope_id, profile_id, status, created_at) VALUES ('j4', 'outline', 's', 'work', 'w', 'p', 'done', 6)")).toThrow();
    db.exec("INSERT INTO chapter_revision(chapter_id, rev, title, body, word_count, reason, created_at) VALUES ('c1', 3, '章', '新', 1, 'before_expand', 3)");
    expect((db.prepare("SELECT id FROM chapter_revision WHERE reason = 'before_expand'").get() as { id: number }).id, '自增 id 接着旧的最大值').toBe(3);
    // 外键级联仍然生效：删除任务时单元、问题、报告一并删除
    db.exec("DELETE FROM job WHERE id IN ('j1', 'j2')");
    expect(db.prepare('SELECT (SELECT count(*) FROM job_unit) AS u, (SELECT count(*) FROM issue) AS i, (SELECT count(*) FROM job_report) AS r').get()).toEqual({ u: 0, i: 1, r: 0 });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_issue_chapter'").get(), '索引已重建').toBeDefined();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
});

describe('作品库创建与打开', () => {
  it('创建后只留下目标文件，PRAGMA 与 schema 版本正确', () => {
    const { workId, file } = newWork();
    expect(readdirSync(tmp.dir)).toEqual([`${workId}.novel`]);
    const db = openWorkDb(file, workId, APP);
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: String(SCHEMA_VERSION) });
    db.close();
  });

  it('目标已存在时拒绝创建；seed 失败时不留下任何文件', () => {
    const { workId, file } = newWork();
    expect(() => createWorkDb(file, workId, APP, seedWork(workId))).toThrow(WorkDbError);
    const other = randomUUID();
    expect(() =>
      createWorkDb(join(tmp.dir, `${other}.novel`), other, APP, () => {
        throw new Error('seed 失败');
      }),
    ).toThrow('seed 失败');
    expect(readdirSync(tmp.dir)).toEqual([`${workId}.novel`]);
  });

  it('INV-1：文件名与 work_id 不一致时拒绝打开', () => {
    const { file } = newWork();
    const fake = randomUUID();
    const copy = join(tmp.dir, `${fake}.novel`);
    copyFileSync(file, copy);
    expect(() => openWorkDb(copy, fake, APP)).toThrow(expect.objectContaining({ code: 'IDENTITY' }));
  });

  it('INV-1：work 表不是恰好 1 行时拒绝打开', () => {
    const { workId, file } = newWork();
    let db = openWorkDb(file, workId, APP);
    db.prepare("INSERT INTO work(id, title, created_at, updated_at) VALUES ('x', 'x', 1, 1)").run();
    db.close();
    expect(() => openWorkDb(file, workId, APP)).toThrow(expect.objectContaining({ code: 'IDENTITY' }));
    db = openDatabase(file);
    db.exec('DELETE FROM work');
    db.close();
    expect(() => openWorkDb(file, workId, APP)).toThrow(expect.objectContaining({ code: 'IDENTITY' }));
  });

  it('数据版本高于程序时拒绝打开（TOO_NEW）；非数据库文件报 CORRUPT；不存在报 NOT_FOUND', () => {
    const { workId, file } = newWork();
    const db = openDatabase(file);
    writeMeta(db, 'schema_version', String(SCHEMA_VERSION + 5));
    db.close();
    expect(() => openWorkDb(file, workId, APP)).toThrow(expect.objectContaining({ code: 'TOO_NEW' }));

    const garbageId = randomUUID();
    const garbage = join(tmp.dir, `${garbageId}.novel`);
    writeFileSync(garbage, 'this is not sqlite '.repeat(100));
    expect(() => openWorkDb(garbage, garbageId, APP)).toThrow(expect.objectContaining({ code: 'CORRUPT' }));
    expect(() => openWorkDb(join(tmp.dir, 'none.novel'), 'none', APP)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

describe('FTS5 trigram 延迟索引（ADR-003）', () => {
  it('新增章节立即入索引；改正文只登记脏行，冲刷后索引更新', () => {
    const { workId, file } = newWork();
    const db = openWorkDb(file, workId, APP);
    insertChapter(db, 'c1', '林惊羽在青云山下拔出了噬魂棒。');
    insertChapter(db, 'c2', '张小凡望着远方。');
    expect(matchCount(db, '噬魂棒')).toBe(1);
    expect(pendingFtsCount(db)).toBe(0);

    db.prepare("UPDATE chapter SET body = '陆雪琪拔出天琊神剑。' WHERE id = 'c1'").run();
    expect(pendingFtsCount(db)).toBe(1);
    expect(matchCount(db, '天琊神剑'), '冲刷前索引尚未更新').toBe(0);
    expect(flushFtsIndex(db)).toBe(1);
    expect(pendingFtsCount(db)).toBe(0);
    expect(matchCount(db, '噬魂棒')).toBe(0);
    expect(matchCount(db, '天琊神剑')).toBe(1);

    db.prepare("UPDATE chapter SET title = '改名' WHERE id = 'c1'").run();
    expect(pendingFtsCount(db), '只改标题不登记脏行').toBe(0);

    db.prepare("UPDATE chapter SET body = '又改了一次' WHERE id = 'c1'").run();
    db.prepare("DELETE FROM chapter WHERE id = 'c1'").run();
    expect(pendingFtsCount(db), '删除时一并清掉脏行').toBe(0);
    expect(matchCount(db, '天琊神剑')).toBe(0);
    expect(matchCount(db, '张小凡')).toBe(1);
    db.close();
  });

  it('searchChapterRids：≥3 字先冲刷再 MATCH，<3 字用 instr；引号被转义', () => {
    const { workId, file } = newWork();
    const db = openWorkDb(file, workId, APP);
    insertChapter(db, 'c1', '青云门弟子');
    insertChapter(db, 'c2', '他说："噬魂棒"');
    db.prepare("UPDATE chapter SET body = '青云山下噬魂棒' WHERE id = 'c1'").run();
    const rids = db.prepare('SELECT id, rid FROM chapter').all() as { id: string; rid: number }[];
    const ridOf = (id: string): number => rids.find((r) => r.id === id)!.rid;
    expect(searchChapterRids(db, '噬魂棒')).toEqual([ridOf('c1'), ridOf('c2')]);
    expect(pendingFtsCount(db)).toBe(0);
    expect(searchChapterRids(db, '青云')).toEqual([ridOf('c1')]);
    expect(searchChapterRids(db, '"噬魂')).toEqual([ridOf('c2')]);
    expect(searchChapterRids(db, '  ')).toEqual([]);
    db.close();
  });

  it('删行 + VACUUM 后索引结构完好，检索结果正确', () => {
    const { workId, file } = newWork();
    const db = openWorkDb(file, workId, APP);
    for (let i = 0; i < 20; i++) insertChapter(db, `c${i}`, `第${i}章正文，关键词${i}号噬魂棒`);
    db.exec("DELETE FROM chapter WHERE id IN ('c1','c3','c5','c7')");
    db.exec('VACUUM');
    expect(() => db.exec("INSERT INTO chapter_fts(chapter_fts) VALUES ('integrity-check')")).not.toThrow();
    expect(searchChapterRids(db, '噬魂棒')).toHaveLength(16);
    db.close();
  });

  it('FtsIndexer：防抖后自动冲刷；flushAll 立即处理排队的作品', async () => {
    const pool = new WorkDbPool({ dir: tmp.dir, appVersion: APP, log: createSilentLogger() });
    const { workId } = newWork();
    const db = pool.get(workId);
    insertChapter(db, 'c1', '初稿');
    const indexer = new FtsIndexer({ pool, log: createSilentLogger(), delayMs: 30 });
    db.prepare("UPDATE chapter SET body = '修改后的正文' WHERE id = 'c1'").run();
    indexer.schedule(workId);
    indexer.schedule(workId);
    expect(indexer.scheduled).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(pendingFtsCount(db)).toBe(0);
    db.prepare("UPDATE chapter SET body = '第三版正文' WHERE id = 'c1'").run();
    indexer.schedule(workId);
    indexer.flushAll();
    expect(pendingFtsCount(db)).toBe(0);
    expect(indexer.scheduled).toBe(0);
    pool.closeAll();
  });
});

describe('tx()', () => {
  it('抛错时整体回滚', () => {
    const { workId, file } = newWork();
    const db = openWorkDb(file, workId, APP);
    expect(() =>
      tx(db, () => {
        insertChapter(db, 'c1', 'a');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare('SELECT count(*) AS n FROM chapter').get()).toEqual({ n: 0 });
    expect(db.isTransaction).toBe(false);
    db.close();
  });

  it('嵌套事务：内层失败只回滚内层', () => {
    const { workId, file } = newWork();
    const db = openWorkDb(file, workId, APP);
    tx(db, () => {
      insertChapter(db, 'outer', 'a');
      expect(() =>
        tx(db, () => {
          insertChapter(db, 'inner', 'b');
          throw new Error('inner');
        }),
      ).toThrow('inner');
    });
    expect(db.prepare('SELECT id FROM chapter').all()).toEqual([{ id: 'outer' }]);
    db.close();
  });

  it('拒绝异步回调', () => {
    const { workId, file } = newWork();
    const db = openWorkDb(file, workId, APP);
    expect(() => tx(db, (async () => undefined) as unknown as () => void)).toThrow('同步');
    expect(db.isTransaction).toBe(false);
    db.close();
  });
});

describe('WorkDbPool（LRU 最多 N 个连接）', () => {
  function makePool(max: number, onOpen?: (id: string) => void) {
    return new WorkDbPool({ dir: tmp.dir, appVersion: APP, log: createSilentLogger(), max, onOpen });
  }

  it('超出上限时关闭最久未用的连接', () => {
    const pool = makePool(2);
    const [a, b, c] = [newWork(), newWork(), newWork()];
    const dbA = pool.get(a.workId);
    pool.get(b.workId);
    pool.get(a.workId);
    const dbB = pool.get(b.workId);
    pool.get(c.workId);
    expect(pool.size).toBe(2);
    expect(dbA.isOpen).toBe(false);
    expect(dbB.isOpen).toBe(true);
    pool.closeAll();
    expect(dbB.isOpen).toBe(false);
  });

  it('被 pin 的连接不会被淘汰，release 后才淘汰', () => {
    const pool = makePool(1);
    const [a, b] = [newWork(), newWork()];
    const lease = pool.pin(a.workId);
    const dbB = pool.get(b.workId);
    expect(lease.db.isOpen).toBe(true);
    expect(dbB.isOpen, '刚打开的连接不能被立即淘汰').toBe(true);
    expect(pool.size).toBe(2);
    lease.release();
    expect(lease.db.isOpen).toBe(false);
    expect(pool.size).toBe(1);
    expect(() => pool.close(b.workId)).not.toThrow();
  });

  it('withTransient 不占用池位置；onOpen 只在放入池时触发', () => {
    const opened: string[] = [];
    const pool = makePool(2, (id) => opened.push(id));
    const a = newWork();
    const title = pool.withTransient(a.workId, (db) => (db.prepare('SELECT title FROM work').get() as { title: string }).title);
    expect(title).toBe('测试作品');
    expect(pool.size).toBe(0);
    expect(opened).toEqual([]);
    pool.get(a.workId);
    pool.get(a.workId);
    expect(opened).toEqual([a.workId]);
    pool.closeAll();
  });

  it('非法 workId 视为不存在（防路径穿越）', () => {
    const pool = makePool(2);
    expect(() => pool.get('../config')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => pool.get(randomUUID())).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

describe('整库备份', () => {
  it('备份文件可打开且内容一致，不留临时文件', async () => {
    const { workId, file } = newWork();
    const db = openWorkDb(file, workId, APP);
    insertChapter(db, 'c1', '备份测试正文');
    const dest = dailyBackupFile(join(tmp.dir, 'backups'), workId, new Date(2026, 9, 9));
    expect(dest.endsWith(join(workId, '20261009.novel'))).toBe(true);
    await backupDatabase(db, dest);
    db.close();
    expect(readdirSync(join(tmp.dir, 'backups', workId))).toEqual(['20261009.novel']);
    const copy = openDatabase(dest);
    expect(copy.prepare('SELECT body FROM chapter').get()).toEqual({ body: '备份测试正文' });
    expect(copy.prepare("SELECT value FROM meta WHERE key='work_id'").get()).toEqual({ value: workId });
    copy.close();
  });

  it('只保留最新的 N 份', () => {
    const dir = join(tmp.dir, 'b');
    mkdirSync(dir);
    for (const d of ['20261001', '20261002', '20261003', '20261004']) writeFileSync(join(dir, `${d}.novel`), 'x');
    writeFileSync(join(dir, 'note.txt'), 'keep');
    expect(pruneBackups(dir, 2).sort()).toEqual(['20261001.novel', '20261002.novel']);
    expect(readdirSync(dir).sort()).toEqual(['20261003.novel', '20261004.novel', 'note.txt']);
    expect(existsSync(join(dir, 'note.txt'))).toBe(true);
  });
});
