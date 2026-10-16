import { applyEdits, isAnchored, rangesOverlap, reanchor, rebaseAnchor, type TextEdit } from '../../shared/anchor';
import type { ApplyIssuesResponse, Issue, IssueCategory, IssueStatus } from '../../shared/types';
import { invalid, missing } from '../errors';
import type { Manuscript } from '../manuscript';
import type { WorkDbPool } from '../storage/db-pool';
import type { SqliteDatabase } from '../storage/sqlite';
import { tx } from '../storage/tx';
import type { Logger } from '../system/logger';
import { toIssue, type IssueRow } from './rows';

const STATUSES: Record<IssueStatus, true> = { open: true, applied: true, ignored: true, stale: true };
const CATEGORIES: Record<IssueCategory, true> = { typo: true, punctuation: true, grammar: true, review: true, setting: true, character: true, ai_flavor: true };

export interface IssueQuery {
  chapterId?: string;
  jobId?: string;
  status?: string;
  category?: string;
}

export interface IssuesOptions {
  pool: WorkDbPool;
  manuscript: Manuscript;
  log: Logger;
  now?: () => number;
}

export interface LiveChapter {
  id: string;
  body: string;
  body_hash: string;
}

export function liveChapter(db: SqliteDatabase, chapterId: string): LiveChapter | null {
  const r = db
    .prepare(
      'SELECT c.id, c.body, c.body_hash FROM chapter c JOIN volume v ON v.id = c.volume_id WHERE c.id = ? AND c.deleted_at IS NULL AND v.deleted_at IS NULL',
    )
    .get(chapterId) as LiveChapter | undefined;
  return r ?? null;
}

const setPosition = (db: SqliteDatabase, id: string, p: { start: number; end: number; excerpt: string }, hash: string, now: number): void => {
  db.prepare('UPDATE issue SET start_offset = ?, end_offset = ?, excerpt = ?, body_hash = ?, updated_at = ? WHERE id = ?').run(p.start, p.end, p.excerpt, hash, now, id);
};

const setStatus = (db: SqliteDatabase, ids: readonly string[], status: IssueStatus, now: number): void => {
  const stmt = db.prepare('UPDATE issue SET status = ?, updated_at = ? WHERE id = ?');
  for (const id of ids) stmt.run(status, now, id);
};

/**
 * 让一章中「待处理」与「已忽略」的问题对齐当前正文（INV-7）：body_hash 与正文一致的校验逐字一致；
 * 不一致的用 excerpt 重新锚定，成功则更新位置与哈希，失败时待处理的标为 stale、已忽略的保持不变。
 * 返回仍处于 open 的问题（位置已对齐当前正文）。调用方负责事务。
 */
export function alignChapter(db: SqliteDatabase, chapter: LiveChapter, now: number, log: Logger): IssueRow[] {
  const rows = db
    .prepare("SELECT * FROM issue WHERE chapter_id = ? AND status IN ('open', 'ignored') ORDER BY start_offset")
    .all(chapter.id) as unknown as IssueRow[];
  const open: IssueRow[] = [];
  for (const r of rows) {
    const ref = { excerpt: r.excerpt, target: r.target, start: r.start_offset, end: r.end_offset };
    if (r.body_hash === chapter.body_hash) {
      if (isAnchored(chapter.body, ref)) {
        if (r.status === 'open') open.push(r);
        continue;
      }
      log.warn(`问题 ${r.id} 与正文哈希一致却没有逐字对齐（INV-7），已标为失效`);
    } else {
      const hit = reanchor(chapter.body, ref);
      if (hit !== null) {
        setPosition(db, r.id, hit, chapter.body_hash, now);
        if (r.status === 'open') open.push({ ...r, start_offset: hit.start, end_offset: hit.end, excerpt: hit.excerpt, body_hash: chapter.body_hash });
        continue;
      }
      if (r.status === 'ignored') continue;
    }
    setStatus(db, [r.id], 'stale', now);
  }
  return open;
}

function rowsByIds(db: SqliteDatabase, ids: readonly string[]): IssueRow[] {
  return db.prepare('SELECT * FROM issue WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as unknown as IssueRow[];
}

/**
 * 问题的读取、采纳（F4 一键修正）与忽略。写正文只经过 Manuscript.fixChapterBody（before_fix 版本 + INV-3 写入口）。
 */
export class Issues {
  private readonly o: IssuesOptions;
  private readonly now: () => number;

  constructor(options: IssuesOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
  }

  /** 读取问题（§7.2）：先对涉及的章节做重新锚定（INV-7），再按卷序、章序、位置排序返回。已删除章节的问题不返回。 */
  list(workId: string, q: IssueQuery = {}): Issue[] {
    if (q.status !== undefined && !(q.status in STATUSES)) throw invalid(`status 只能是 ${Object.keys(STATUSES).join(' / ')}`);
    if (q.category !== undefined && !(q.category in CATEGORIES)) throw invalid(`category 只能是 ${Object.keys(CATEGORIES).join(' / ')}`);
    const db = this.o.pool.get(workId);
    tx(db, () => {
      const now = this.now();
      const stale = db
        .prepare(
          `SELECT DISTINCT i.chapter_id AS id FROM issue i JOIN chapter c ON c.id = i.chapter_id
           WHERE i.status IN ('open', 'ignored') AND i.body_hash != c.body_hash ${q.chapterId === undefined ? '' : 'AND i.chapter_id = ?'}`,
        )
        .all(...(q.chapterId === undefined ? [] : [q.chapterId])) as { id: string }[];
      for (const { id } of stale) {
        const chapter = liveChapter(db, id);
        if (chapter !== null) alignChapter(db, chapter, now, this.o.log);
      }
    });
    const where: string[] = ['c.deleted_at IS NULL', 'v.deleted_at IS NULL'];
    const args: string[] = [];
    for (const [col, value] of [
      ['i.chapter_id', q.chapterId],
      ['i.job_id', q.jobId],
      ['i.status', q.status],
      ['i.category', q.category],
    ] as const) {
      if (value === undefined) continue;
      where.push(`${col} = ?`);
      args.push(value);
    }
    const rows = db
      .prepare(
        `SELECT i.* FROM issue i JOIN chapter c ON c.id = i.chapter_id JOIN volume v ON v.id = c.volume_id
         WHERE ${where.join(' AND ')} ORDER BY v.seq, c.seq, i.start_offset, i.end_offset, i.created_at`,
      )
      .all(...args) as unknown as IssueRow[];
    return rows.map(toIssue);
  }

  /**
   * 一键修正（F4）：按章节分组，每章一个事务——对齐（重新锚定，失败标 stale）→ 去掉范围重叠的问题（保留 start 较小的，
   * 另一个保持 open、在结果中返回为 stale）→ before_fix 版本 → 从后往前替换 → rev 加 1 → 标为 applied →
   * 同章其余问题平移到新正文。客户端应先保存当前章节。
   */
  apply(workId: string, issueIds: readonly string[]): ApplyIssuesResponse {
    const ids = [...new Set(issueIds)];
    const db = this.o.pool.get(workId);
    const rows = rowsByIds(db, ids);
    if (rows.length !== ids.length) throw missing('部分问题不存在或已被删除，请刷新问题列表');
    const noFix = rows.filter((r) => r.replacement === null);
    if (noFix.length > 0) throw invalid('所选问题中有没有修改建议的条目，不能一键修正');

    const res: ApplyIssuesResponse = { applied: [], stale: [], chapters: [] };
    const byChapter = new Map<string, Set<string>>();
    for (const r of rows) byChapter.set(r.chapter_id, (byChapter.get(r.chapter_id) ?? new Set()).add(r.id));
    // 按卷序、章序逐章处理，响应中的 chapters 顺序与目录一致（已删除的章节排在最后）
    const order = new Map(
      (db.prepare('SELECT c.id FROM chapter c JOIN volume v ON v.id = c.volume_id ORDER BY v.seq, c.seq, c.created_at').all() as { id: string }[]).map((r, i) => [r.id, i]),
    );
    const chapters = [...byChapter.keys()].sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity));

    for (const chapterId of chapters) {
      const wanted = byChapter.get(chapterId) ?? new Set<string>();
      if (liveChapter(db, chapterId) === null) {
        tx(db, () => setStatus(db, [...wanted], 'stale', this.now()));
        res.stale.push(...wanted);
        continue;
      }
      const out = this.o.manuscript.fixChapterBody(workId, chapterId, (fdb, row, now) => {
        const chapter = { id: row.id, body: row.body, body_hash: row.body_hash };
        const open = alignChapter(fdb, chapter, now, this.o.log);
        const candidates = open.filter((r) => wanted.has(r.id)).sort((a, b) => a.start_offset - b.start_offset || a.end_offset - b.end_offset);
        const chosen: IssueRow[] = [];
        const stale = [...wanted].filter((id) => !candidates.some((c) => c.id === id));
        for (const c of candidates) {
          const last = chosen.at(-1);
          if (last !== undefined && rangesOverlap({ start: c.start_offset, end: c.end_offset }, { start: last.start_offset, end: last.end_offset })) stale.push(c.id);
          else chosen.push(c);
        }
        const edits: TextEdit[] = chosen.map((c) => ({ start: c.start_offset, end: c.end_offset, text: c.replacement ?? '' }));
        const result = { applied: chosen.map((c) => c.id), stale };
        if (edits.length === 0) return { body: null, result };
        const newBody = applyEdits(row.body, edits);
        return {
          body: newBody,
          result,
          afterWrite: ({ bodyHash, now: t }) => {
            setStatus(fdb, result.applied, 'applied', t);
            const appliedSet = new Set(result.applied);
            const others = fdb
              .prepare("SELECT * FROM issue WHERE chapter_id = ? AND status IN ('open', 'ignored') AND body_hash = ?")
              .all(chapterId, row.body_hash) as unknown as IssueRow[];
            for (const r of others) {
              if (appliedSet.has(r.id)) continue;
              const moved = rebaseAnchor(row.body, newBody, edits, { excerpt: r.excerpt, target: r.target, start: r.start_offset, end: r.end_offset });
              if (moved !== null) setPosition(fdb, r.id, moved, bodyHash, t);
            }
          },
        };
      });
      res.applied.push(...out.result.applied);
      res.stale.push(...out.result.stale);
      if (out.changed) res.chapters.push({ id: chapterId, rev: out.rev });
    }
    if (res.applied.length > 0) this.o.log.info(`作品 ${workId}：一键修正 ${res.applied.length} 处，${res.stale.length} 处已失效或范围重叠，涉及 ${res.chapters.length} 章`);
    return res;
  }

  /** 忽略问题：待处理或已失效的改为 ignored；已采纳的不变。 */
  ignore(workId: string, issueIds: readonly string[]): void {
    const ids = [...new Set(issueIds)];
    const db = this.o.pool.get(workId);
    if (rowsByIds(db, ids).length !== ids.length) throw missing('部分问题不存在或已被删除，请刷新问题列表');
    tx(db, () =>
      db
        .prepare("UPDATE issue SET status = 'ignored', updated_at = ? WHERE id IN (SELECT value FROM json_each(?)) AND status IN ('open', 'stale')")
        .run(this.now(), JSON.stringify(ids)),
    );
  }
}
