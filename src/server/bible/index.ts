import { randomUUID } from 'node:crypto';
import type { BibleCandidate, BibleEntry, BibleFact, CandidateDecision, EntryKind, ServerEvent } from '../../shared/types';
import { invalid } from '../errors';
import type { WorkDbPool } from '../storage/db-pool';
import type { SqliteDatabase } from '../storage/sqlite';
import { tx } from '../storage/tx';
import type { Logger } from '../system/logger';
import { decideCandidates, listCandidates, pendingCount } from './candidates';
import { NameIndex, cleanNames, nameConflictError } from './names';
import {
  ATTRIBUTE_MAX_CHARS,
  QUOTE_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  VALUE_MAX_CHARS,
  chapterBodyOf,
  clipText,
  deleteEntryRow,
  facts,
  getEntry,
  getEntryRow,
  getFactRow,
  insertEntry,
  insertFact,
  listEntryRows,
  writeEntry,
  writeFact,
  type EntryFields,
  type FactFields,
} from './repo';
import { parseAliases, toEntry, toFact } from './rows';

/** POST W/bible/entries 的请求体（aliases、summary、firstChapterId 可省略）。 */
export type EntryInput = Pick<BibleEntry, 'kind' | 'name'> & Partial<Pick<BibleEntry, 'aliases' | 'summary' | 'firstChapterId'>>;
/** POST W/bible/entries/:eid/facts 的请求体（mutable 默认 false，chapterId 默认 null，quote 默认空）。 */
export type FactInput = Pick<BibleFact, 'attribute' | 'value'> & Partial<Pick<BibleFact, 'mutable' | 'chapterId' | 'quote'>>;

export interface BibleOptions {
  pool: WorkDbPool;
  log: Logger;
  publish: (event: ServerEvent) => void;
  now?: () => number;
  newId?: () => string;
}

/**
 * bible 模块门面（F5、ADR-009）：设定条目与事实的增删改（INV-8 引文校验、INV-9 名称查重），
 * 以及抽取候选的审核。候选由 bible_extract 任务生成（checks/handlers → candidates.writeExtractCandidates）。
 */
export class Bible {
  private readonly o: BibleOptions;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: BibleOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  private db(workId: string): SqliteDatabase {
    return this.o.pool.get(workId);
  }

  // ---------------- 条目 ----------------

  listEntries(workId: string, kind?: EntryKind): BibleEntry[] {
    return listEntryRows(this.db(workId), kind).map(toEntry);
  }

  private entryFields(db: SqliteDatabase, f: EntryFields, exceptId: string | null): EntryFields {
    const names = cleanNames(f.name, f.aliases);
    if (names.name === '') throw invalid('条目名称不能为空');
    if (f.firstChapterId !== null && chapterBodyOf(db, f.firstChapterId) === null) throw invalid('首次出现的章节不存在');
    const conflict = NameIndex.load(db).conflict([names.name, ...names.aliases], exceptId);
    if (conflict !== null) throw nameConflictError(conflict);
    return { ...f, name: names.name, aliases: names.aliases, summary: clipText(f.summary, SUMMARY_MAX_CHARS) };
  }

  createEntry(workId: string, input: EntryInput): BibleEntry {
    const db = this.db(workId);
    const id = this.newId();
    tx(db, () => {
      const f = this.entryFields(db, { kind: input.kind, name: input.name, aliases: input.aliases ?? [], summary: input.summary ?? '', firstChapterId: input.firstChapterId ?? null }, null);
      insertEntry(db, id, f, this.now());
    });
    return getEntry(db, id);
  }

  updateEntry(workId: string, id: string, patch: Partial<EntryInput>): BibleEntry {
    const db = this.db(workId);
    tx(db, () => {
      const row = getEntryRow(db, id);
      const f = this.entryFields(
        db,
        {
          kind: patch.kind ?? row.kind,
          name: patch.name ?? row.name,
          aliases: patch.aliases ?? parseAliases(row.aliases),
          summary: patch.summary ?? row.summary,
          firstChapterId: patch.firstChapterId === undefined ? row.first_chapter_id : patch.firstChapterId,
        },
        id,
      );
      writeEntry(db, id, f, this.now());
    });
    return getEntry(db, id);
  }

  deleteEntry(workId: string, id: string): void {
    const db = this.db(workId);
    tx(db, () => deleteEntryRow(db, id));
    this.publishPending(workId);
  }

  // ---------------- 事实 ----------------

  listFacts(workId: string, entryId: string): BibleFact[] {
    const db = this.db(workId);
    getEntryRow(db, entryId);
    return facts(db, entryId);
  }

  private factFields(f: FactFields): FactFields {
    const attribute = clipText(f.attribute, ATTRIBUTE_MAX_CHARS);
    const value = clipText(f.value, VALUE_MAX_CHARS);
    if (attribute === '' || value === '') throw invalid('属性和值都不能为空');
    if ([...f.quote].length > QUOTE_MAX_CHARS) throw invalid(`引文不能超过 ${QUOTE_MAX_CHARS} 字`);
    return { ...f, attribute, value };
  }

  createFact(workId: string, entryId: string, input: FactInput): BibleFact {
    const db = this.db(workId);
    const id = this.newId();
    tx(db, () => {
      getEntryRow(db, entryId);
      insertFact(db, id, entryId, this.factFields({ attribute: input.attribute, value: input.value, mutable: input.mutable ?? false, chapterId: input.chapterId ?? null, quote: input.quote ?? '' }), this.now());
    });
    return toFact(getFactRow(db, id));
  }

  updateFact(workId: string, id: string, patch: Partial<FactInput>): BibleFact {
    const db = this.db(workId);
    tx(db, () => {
      const row = getFactRow(db, id);
      const chapterId = patch.chapterId === undefined ? row.chapter_id : patch.chapterId;
      // 换了来源章节却没给新引文：旧引文不再适用
      const quote = patch.quote ?? (chapterId === row.chapter_id ? row.quote : '');
      writeFact(
        db,
        id,
        this.factFields({ attribute: patch.attribute ?? row.attribute, value: patch.value ?? row.value, mutable: patch.mutable ?? row.mutable === 1, chapterId, quote }),
        this.now(),
      );
    });
    return toFact(getFactRow(db, id));
  }

  deleteFact(workId: string, id: string): void {
    const db = this.db(workId);
    tx(db, () => {
      getFactRow(db, id);
      db.prepare('DELETE FROM bible_fact WHERE id = ?').run(id);
    });
  }

  // ---------------- 候选 ----------------

  listCandidates(workId: string, status?: BibleCandidate['status']): BibleCandidate[] {
    return listCandidates(this.db(workId), status);
  }

  decide(workId: string, decisions: readonly CandidateDecision[]): { accepted: number; rejected: number } {
    const db = this.db(workId);
    const result = tx(db, () => decideCandidates(db, decisions, { now: this.now(), newId: this.newId }));
    if (result.accepted + result.rejected > 0) this.o.log.info(`设定库：接受 ${result.accepted} 条候选、拒绝 ${result.rejected} 条`);
    this.publishPending(workId);
    return result;
  }

  pendingCount(workId: string): number {
    return pendingCount(this.db(workId));
  }

  /** 推送 candidates.changed（待审核数变化）。 */
  publishPending(workId: string): void {
    try {
      this.o.publish({ type: 'candidates.changed', workId, pending: pendingCount(this.db(workId)) });
    } catch (err) {
      this.o.log.warn('推送待审核候选数失败', err);
    }
  }
}
