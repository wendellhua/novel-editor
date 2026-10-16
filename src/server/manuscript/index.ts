import type {
  Chapter,
  ChapterNode,
  CreateChapterRequest,
  CreateVolumeRequest,
  CreateWorkRequest,
  ExportFormat,
  MoveChapterRequest,
  RevisionDetail,
  RevisionMeta,
  SaveBodyRequest,
  SaveBodyResponse,
  TrashItemRef,
  TrashList,
  TrashedWork,
  UpdateWorkRequest,
  VolumeNode,
  Work,
  WorkSummary,
  WorkTree,
} from '../../shared/types';
import type { WorkDbPool } from '../storage/db-pool';
import type { SqliteDatabase } from '../storage/sqlite';
import { tx } from '../storage/tx';
import type { Logger } from '../system/logger';
import * as content from './content';
import { exportWork, type ExportResult } from './export';
import { normalizeNewlines } from '../../shared/text';
import { bodyHash, getChapterRow, insertRevision, writeChapterBody, type BodyWriteResult } from './repo';
import type { ChapterRow } from './rows';
import * as structure from './structure';
import { WorkLibrary } from './works';

/** fixChapterBody 的计划：body 为 null 表示不修改。 */
export interface ChapterFix<T> {
  body: string | null;
  result: T;
  /** 正文写入之后、事务提交之前执行（如把问题标为已采纳、平移其余问题）。 */
  afterWrite?(write: { bodyHash: string; rev: number; now: number }): void;
}

export interface ChapterFixResult<T> {
  result: T;
  rev: number;
  changed: boolean;
}

export interface ManuscriptOptions {
  pool: WorkDbPool;
  trashDir: string;
  appVersion: string;
  log: Logger;
  now?: () => number;
  onChapterUpdated?: (workId: string, chapterId: string, rev: number) => void;
}

function toSaveResponse(r: BodyWriteResult): SaveBodyResponse {
  return { rev: r.rev, wordCount: r.wordCount, updatedAt: r.updatedAt };
}

/** manuscript 模块对外的唯一服务入口：负责取连接、包事务、发出 chapter.updated 事件。 */
export class Manuscript {
  readonly works: WorkLibrary;
  private readonly pool: WorkDbPool;
  private readonly now: () => number;
  private readonly onChapterUpdated: ManuscriptOptions['onChapterUpdated'];

  constructor(options: ManuscriptOptions) {
    this.pool = options.pool;
    this.now = options.now ?? Date.now;
    this.onChapterUpdated = options.onChapterUpdated;
    this.works = new WorkLibrary({
      pool: options.pool,
      trashDir: options.trashDir,
      appVersion: options.appVersion,
      log: options.log,
      now: this.now,
    });
  }

  private write<T>(workId: string, fn: (db: SqliteDatabase, now: number) => T): T {
    const db = this.pool.get(workId);
    return tx(db, () => fn(db, this.now()));
  }

  private read<T>(workId: string, fn: (db: SqliteDatabase) => T): T {
    return fn(this.pool.get(workId));
  }

  // 作品
  listWorks(): WorkSummary[] {
    return this.works.list();
  }
  createWork(input: CreateWorkRequest): Work {
    return this.works.create(input);
  }
  updateWork(workId: string, patch: UpdateWorkRequest): Work {
    return this.write(workId, (db) => this.works.update(db, patch));
  }
  deleteWork(workId: string): void {
    this.works.remove(workId);
  }
  listTrashedWorks(): TrashedWork[] {
    return this.works.listTrash();
  }
  restoreWork(file: string): WorkSummary {
    return this.works.restore(file);
  }
  purgeTrashedWork(file: string): void {
    this.works.purge(file);
  }

  // 结构
  getTree(workId: string): WorkTree {
    return this.read(workId, structure.getTree);
  }
  createVolume(workId: string, input: CreateVolumeRequest): VolumeNode {
    return this.write(workId, (db, now) => structure.createVolume(db, input, now));
  }
  renameVolume(workId: string, volumeId: string, title: string): VolumeNode {
    return this.write(workId, (db, now) => structure.renameVolume(db, volumeId, title, now));
  }
  deleteVolume(workId: string, volumeId: string): void {
    this.write(workId, (db, now) => structure.deleteVolume(db, volumeId, now));
  }
  reorderVolumes(workId: string, ids: readonly string[]): void {
    this.write(workId, (db, now) => structure.setVolumeOrder(db, ids, now));
  }
  createChapter(workId: string, input: CreateChapterRequest): Chapter {
    return this.write(workId, (db, now) => structure.createChapter(db, input, now));
  }
  renameChapter(workId: string, chapterId: string, title: string): ChapterNode {
    return this.write(workId, (db, now) => structure.renameChapter(db, chapterId, title, now));
  }
  deleteChapter(workId: string, chapterId: string): void {
    this.write(workId, (db, now) => structure.deleteChapter(db, chapterId, now));
  }
  moveChapter(workId: string, chapterId: string, input: MoveChapterRequest): void {
    this.write(workId, (db, now) => structure.moveChapter(db, chapterId, input, now));
  }
  reorderChapters(workId: string, volumeId: string, ids: readonly string[]): void {
    this.write(workId, (db, now) => structure.setChapterOrder(db, volumeId, ids, now));
  }
  getTrash(workId: string): TrashList {
    return this.read(workId, structure.getTrash);
  }
  restoreTrash(workId: string, ref: TrashItemRef): void {
    this.write(workId, (db, now) => structure.restoreTrashItem(db, ref, now));
  }
  purgeTrash(workId: string, ref: TrashItemRef | 'all'): void {
    this.write(workId, (db) => (ref === 'all' ? structure.emptyTrash(db) : structure.purgeTrashItem(db, ref)));
  }

  // 正文与版本
  getChapter(workId: string, chapterId: string): Chapter {
    return this.read(workId, (db) => content.getChapter(db, chapterId));
  }
  saveChapterBody(workId: string, chapterId: string, req: SaveBodyRequest): SaveBodyResponse {
    const r = this.write(workId, (db, now) => content.saveChapterBody(db, chapterId, req, now));
    if (r.changed) this.onChapterUpdated?.(workId, chapterId, r.rev);
    return toSaveResponse(r);
  }
  listRevisions(workId: string, chapterId: string): RevisionMeta[] {
    return this.read(workId, (db) => content.listRevisions(db, chapterId));
  }
  createManualRevision(workId: string, chapterId: string): RevisionMeta {
    return this.write(workId, (db, now) => content.createManualRevision(db, chapterId, now));
  }
  getRevision(workId: string, chapterId: string, revisionId: number): RevisionDetail {
    return this.read(workId, (db) => content.getRevision(db, chapterId, revisionId));
  }
  restoreRevision(workId: string, chapterId: string, revisionId: number, baseRev: number): SaveBodyResponse {
    const r = this.write(workId, (db, now) => content.restoreRevision(db, chapterId, revisionId, baseRev, now));
    if (r.changed) this.onChapterUpdated?.(workId, chapterId, r.rev);
    return toSaveResponse(r);
  }

  /**
   * F4 一键修正（以及插入智能扩写）的正文写入口：在同一个事务里调用 plan 计算修正后的正文（plan 可以同时读写 issue 等表）；
   * 正文有变化时先写 reason 版本（默认 before_fix），再经 writeChapterBody 写入（INV-3、rev 加 1），然后调用 afterWrite；
   * 提交后推送 chapter.updated。plan 抛错时整个事务回滚。
   */
  fixChapterBody<T>(
    workId: string,
    chapterId: string,
    plan: (db: SqliteDatabase, row: ChapterRow, now: number) => ChapterFix<T>,
    reason: 'before_fix' | 'before_expand' = 'before_fix',
  ): ChapterFixResult<T> {
    const out = this.write(workId, (db, now) => {
      const row = getChapterRow(db, chapterId);
      const fix = plan(db, row, now);
      if (fix.body === null || normalizeNewlines(fix.body) === row.body) return { result: fix.result, rev: row.rev, changed: false };
      insertRevision(db, row, reason, now);
      const written = writeChapterBody(db, row, { body: fix.body }, now);
      fix.afterWrite?.({ bodyHash: bodyHash(normalizeNewlines(fix.body)), rev: written.rev, now });
      return { result: fix.result, rev: written.rev, changed: true };
    });
    if (out.changed) this.onChapterUpdated?.(workId, chapterId, out.rev);
    return out;
  }

  // 导出
  async exportWork(workId: string, format: ExportFormat): Promise<ExportResult> {
    const lease = this.pool.pin(workId);
    try {
      return await exportWork(lease.db, format);
    } finally {
      lease.release();
    }
  }
}
