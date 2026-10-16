import { ENTRY_KINDS } from '../../shared/constants';
import type { BibleEntry, BibleFact, EntryKind } from '../../shared/types';
import { invalid, missing } from '../errors';
import type { SqliteDatabase } from '../storage/sqlite';
import { nameKey } from './names';
import { toEntry, toFact, type EntryRow, type FactRow } from './rows';

export const SUMMARY_MAX_CHARS = 2000;
export const ATTRIBUTE_MAX_CHARS = 100;
export const VALUE_MAX_CHARS = 2000;
export const QUOTE_MAX_CHARS = 500;

export const clipText = (s: string, max: number): string => [...s.trim()].slice(0, max).join('');

// ---------------- 条目 ----------------

const kindOrder = (k: EntryKind): number => ENTRY_KINDS.indexOf(k);

/** 条目按类型（ENTRY_KINDS 顺序）、名称排序。 */
export function listEntryRows(db: SqliteDatabase, kind?: EntryKind): EntryRow[] {
  const rows = (
    kind === undefined ? db.prepare('SELECT * FROM bible_entry').all() : db.prepare('SELECT * FROM bible_entry WHERE kind = ?').all(kind)
  ) as unknown as EntryRow[];
  return rows.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.name.localeCompare(b.name, 'zh-Hans-CN') || a.created_at - b.created_at);
}

export function findEntryRow(db: SqliteDatabase, id: string): EntryRow | null {
  return (db.prepare('SELECT * FROM bible_entry WHERE id = ?').get(id) as EntryRow | undefined) ?? null;
}

export function getEntryRow(db: SqliteDatabase, id: string): EntryRow {
  const row = findEntryRow(db, id);
  if (row === null) throw missing('设定条目不存在');
  return row;
}

export function getEntry(db: SqliteDatabase, id: string): BibleEntry {
  return toEntry(getEntryRow(db, id));
}

export interface EntryFields {
  kind: EntryKind;
  name: string;
  aliases: string[];
  summary: string;
  firstChapterId: string | null;
}

export function insertEntry(db: SqliteDatabase, id: string, f: EntryFields, now: number): void {
  db.prepare('INSERT INTO bible_entry (id, kind, name, aliases, summary, first_chapter_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    f.kind,
    f.name,
    JSON.stringify(f.aliases),
    f.summary,
    f.firstChapterId,
    now,
    now,
  );
}

export function writeEntry(db: SqliteDatabase, id: string, f: EntryFields, now: number): void {
  db.prepare('UPDATE bible_entry SET kind = ?, name = ?, aliases = ?, summary = ?, first_chapter_id = ?, updated_at = ? WHERE id = ?').run(
    f.kind,
    f.name,
    JSON.stringify(f.aliases),
    f.summary,
    f.firstChapterId,
    now,
    id,
  );
}

/** 删除条目：事实级联删除；以它为目标的待审核候选一并删除（已经没有意义）。 */
export function deleteEntryRow(db: SqliteDatabase, id: string): void {
  getEntryRow(db, id);
  db.prepare("DELETE FROM bible_candidate WHERE target_entry_id = ? AND status = 'pending'").run(id);
  db.prepare('DELETE FROM bible_entry WHERE id = ?').run(id);
}

// ---------------- 事实 ----------------

export function listFactRows(db: SqliteDatabase, entryId: string): FactRow[] {
  return db.prepare('SELECT * FROM bible_fact WHERE entry_id = ? ORDER BY created_at, rowid').all(entryId) as unknown as FactRow[];
}

export function getFactRow(db: SqliteDatabase, id: string): FactRow {
  const row = db.prepare('SELECT * FROM bible_fact WHERE id = ?').get(id) as FactRow | undefined;
  if (row === undefined) throw missing('设定事实不存在');
  return row;
}

export interface FactFields {
  attribute: string;
  value: string;
  mutable: boolean;
  chapterId: string | null;
  quote: string;
}

/** 章节正文（含回收站中的章节）；章节不存在时为 null。 */
export function chapterBodyOf(db: SqliteDatabase, chapterId: string): string | null {
  const row = db.prepare('SELECT body FROM chapter WHERE id = ?').get(chapterId) as { body: string } | undefined;
  return row?.body ?? null;
}

/**
 * INV-8：引文非空时，必须在写入这一刻逐字出现在来源章节正文中；手填事实（chapterId 为 null）不能带引文。
 * 来源章节必须存在。
 */
export function assertQuote(db: SqliteDatabase, chapterId: string | null, quote: string): void {
  if (chapterId !== null && chapterBodyOf(db, chapterId) === null) throw invalid('来源章节不存在');
  if (quote === '') return;
  if (chapterId === null) throw invalid('引文必须注明来源章节');
  if (!(chapterBodyOf(db, chapterId) ?? '').includes(quote)) throw invalid('引文必须逐字出现在来源章节的正文中');
}

export function insertFact(db: SqliteDatabase, id: string, entryId: string, f: FactFields, now: number): void {
  assertQuote(db, f.chapterId, f.quote);
  db.prepare(
    'INSERT INTO bible_fact (id, entry_id, attribute, value, mutable, chapter_id, quote, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, entryId, f.attribute, f.value, f.mutable ? 1 : 0, f.chapterId, f.quote, now, now);
}

export function writeFact(db: SqliteDatabase, id: string, f: FactFields, now: number): void {
  assertQuote(db, f.chapterId, f.quote);
  db.prepare('UPDATE bible_fact SET attribute = ?, value = ?, mutable = ?, chapter_id = ?, quote = ?, updated_at = ? WHERE id = ?').run(
    f.attribute,
    f.value,
    f.mutable ? 1 : 0,
    f.chapterId,
    f.quote,
    now,
    id,
  );
}

/** 同一条目下属性与值都相同（按比较键）的事实已存在。 */
export function hasSameFact(db: SqliteDatabase, entryId: string, attribute: string, value: string): boolean {
  const a = nameKey(attribute);
  const v = nameKey(value);
  return listFactRows(db, entryId).some((r) => nameKey(r.attribute) === a && nameKey(r.value) === v);
}

export const facts = (db: SqliteDatabase, entryId: string): BibleFact[] => listFactRows(db, entryId).map(toFact);
