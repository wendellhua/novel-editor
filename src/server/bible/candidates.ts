import { ENTRY_KINDS } from '../../shared/constants';
import type { ExtractOutput } from '../../shared/schemas/outputs';
import type { BibleCandidate, CandidateDecision, CandidatePayload, EntryKind, NewAliasPayload, NewEntryPayload, NewFactPayload } from '../../shared/types';
import { invalid, missing } from '../errors';
import type { SqliteDatabase } from '../storage/sqlite';
import { NameIndex, cleanNames, nameConflictError, nameKey } from './names';
import {
  ATTRIBUTE_MAX_CHARS,
  QUOTE_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  VALUE_MAX_CHARS,
  chapterBodyOf,
  clipText,
  findEntryRow,
  getEntryRow,
  hasSameFact,
  insertEntry,
  insertFact,
  writeEntry,
} from './repo';
import { parseAliases, parsePayload, toCandidate, type CandidateOp, type CandidateRow } from './rows';

/** 单个抽取单元最多处理的实体数、每个实体最多的事实数。 */
export const MAX_ENTITIES_PER_UNIT = 100;
export const MAX_FACTS_PER_ENTITY = 30;
/** new_entry / new_alias 候选的引文：名称在原文中第一次出现处前后各取多少字。 */
const NAME_QUOTE_CONTEXT = 20;

// ---------------- 读取 ----------------

export function listCandidates(db: SqliteDatabase, status?: BibleCandidate['status']): BibleCandidate[] {
  const rows = (
    status === undefined
      ? db.prepare('SELECT * FROM bible_candidate ORDER BY created_at, rowid').all()
      : db.prepare('SELECT * FROM bible_candidate WHERE status = ? ORDER BY created_at, rowid').all(status)
  ) as unknown as CandidateRow[];
  return rows.map(toCandidate);
}

export function pendingCount(db: SqliteDatabase): number {
  return (db.prepare("SELECT count(*) AS n FROM bible_candidate WHERE status = 'pending'").get() as { n: number }).n;
}

// ---------------- 由抽取结果生成候选（F5 第 2 步） ----------------

/**
 * 候选的去重键：新条目按名称，新事实按目标条目 + 属性 + 值，新别名按目标条目 + 别名（均为比较键）。
 * 同一章节同键的待审核候选不重复写入；被拒绝过的键不再生成（作者的「拒绝」是持久的）。
 */
export function candidateKey(op: CandidateOp, target: string | null, payload: CandidatePayload): string {
  if (op === 'new_entry') return `E|${nameKey((payload as NewEntryPayload).name)}`;
  if (op === 'new_fact') {
    const p = payload as NewFactPayload;
    return `F|${target ?? ''}|${nameKey(p.attribute)}|${nameKey(p.value)}`;
  }
  return `A|${target ?? ''}|${nameKey((payload as NewAliasPayload).alias)}`;
}

/** 名称在正文中第一次出现处的上下文（逐字子串，INV-8）。 */
function nameQuote(body: string, name: string): string {
  const i = body.indexOf(name);
  if (i < 0) return '';
  return body.slice(Math.max(0, i - NAME_QUOTE_CONTEXT), Math.min(body.length, i + name.length + NAME_QUOTE_CONTEXT));
}

export interface ExtractStats {
  written: number;
  /** 引文不是原文子串的事实、名称与别名都没出现在原文中的实体（INV-8）。 */
  dropped: number;
  duplicates: number;
}

interface WriteContext {
  jobId: string;
  chapterId: string;
  /** 本单元执行时的章节正文快照。 */
  body: string;
  now: number;
  newId: () => string;
}

type CleanFact = NewEntryPayload['facts'][number];

function cleanFacts(facts: ExtractOutput['entities'][number]['facts'], body: string, stats: ExtractStats): CleanFact[] {
  const out: CleanFact[] = [];
  const seen = new Set<string>();
  for (const f of facts.slice(0, MAX_FACTS_PER_ENTITY)) {
    const attribute = clipText(f.attribute, ATTRIBUTE_MAX_CHARS);
    const value = clipText(f.value, VALUE_MAX_CHARS);
    const quote = f.quote.trim();
    if (attribute === '' || value === '') continue;
    if (quote === '' || [...quote].length > QUOTE_MAX_CHARS || !body.includes(quote)) {
      stats.dropped++;
      continue;
    }
    const key = `${nameKey(attribute)}|${nameKey(value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ attribute, value, mutable: f.mutable, quote });
  }
  return out;
}

type Entity = ExtractOutput['entities'][number];

/**
 * 同一份输出里共享名称或别名的实体合并为一个（模型有时把「小林」与「林远又名小林」分开输出）：
 * 声明了对方名称为别名的一方作为主名称；别名、事实取并集。
 */
export function mergeEntities(entities: readonly Entity[]): Entity[] {
  const groups: Entity[] = [];
  const byKey = new Map<string, Entity>();
  const keysOf = (e: Entity): string[] => [e.name, ...e.aliases].map(nameKey).filter((k) => k !== '');
  for (const raw of entities) {
    const e: Entity = { ...raw, aliases: [...raw.aliases], facts: [...raw.facts] };
    const hit = keysOf(e)
      .map((k) => byKey.get(k))
      .find((g): g is Entity => g !== undefined);
    if (hit === undefined) {
      groups.push(e);
      for (const k of keysOf(e)) byKey.set(k, e);
      continue;
    }
    if (e.aliases.some((a) => nameKey(a) === nameKey(hit.name))) {
      hit.aliases.push(hit.name);
      hit.name = e.name;
      hit.kind = e.kind;
    } else {
      hit.aliases.push(e.name);
    }
    hit.aliases = cleanNames(hit.name, [...hit.aliases, ...e.aliases]).aliases;
    hit.facts.push(...e.facts);
    if (hit.summary.trim() === '') hit.summary = e.summary;
    for (const k of keysOf(hit)) byKey.set(k, hit);
  }
  return groups;
}

/**
 * 把一个抽取单元的输出写成候选（在单元完成的事务内调用）：
 * - INV-8：事实引文必须是本章正文的逐字子串，否则丢弃；名称与别名都没在正文中出现的实体丢弃。
 * - 按名称 / 别名匹配已确认条目：匹配上的生成 new_alias（新叫法）与 new_fact（条目还没有的事实）；没匹配上的生成 new_entry。
 * - 同一章节同名的待审核新条目合并为一个候选（别名、事实取并集）；同键的其他候选不重复；拒绝过的不再生成。
 * - 写入前删除本章中引文已不在当前正文里的待审核候选（章节改稿后重新抽取）。
 */
export function writeExtractCandidates(db: SqliteDatabase, ctx: WriteContext, output: ExtractOutput): ExtractStats {
  const stats: ExtractStats = { written: 0, dropped: 0, duplicates: 0 };
  const stale = (db.prepare("SELECT id, quote FROM bible_candidate WHERE chapter_id = ? AND status = 'pending'").all(ctx.chapterId) as { id: string; quote: string }[])
    .filter((r) => r.quote !== '' && !ctx.body.includes(r.quote))
    .map((r) => r.id);
  for (const id of stale) db.prepare('DELETE FROM bible_candidate WHERE id = ?').run(id);

  const index = NameIndex.load(db);
  const rejected = new Set<string>();
  const pending = new Map<string, CandidateRow>();
  for (const r of db.prepare("SELECT * FROM bible_candidate WHERE status != 'accepted'").all() as unknown as CandidateRow[]) {
    const p = parsePayload(r.payload);
    if (p === null) continue;
    const key = candidateKey(r.op, r.target_entry_id, p);
    if (r.status === 'rejected') rejected.add(key);
    else if (r.chapter_id === ctx.chapterId) pending.set(key, r);
  }

  const add = (op: CandidateOp, target: string | null, payload: CandidatePayload, quote: string): void => {
    const key = candidateKey(op, target, payload);
    if (rejected.has(key)) {
      stats.duplicates++;
      return;
    }
    const existing = pending.get(key);
    if (existing !== undefined) {
      if (op === 'new_entry') mergePendingEntry(db, existing, payload as NewEntryPayload);
      stats.duplicates++;
      return;
    }
    const row: CandidateRow = {
      id: ctx.newId(),
      job_id: ctx.jobId,
      op,
      target_entry_id: target,
      payload: JSON.stringify(payload),
      chapter_id: ctx.chapterId,
      quote,
      status: 'pending',
      created_at: ctx.now,
      decided_at: null,
    };
    db.prepare(
      'INSERT INTO bible_candidate (id, job_id, op, target_entry_id, payload, chapter_id, quote, status, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(row.id, row.job_id, row.op, row.target_entry_id, row.payload, row.chapter_id, row.quote, row.status, row.created_at, row.decided_at);
    pending.set(key, row);
    stats.written++;
  };

  for (const entity of mergeEntities(output.entities.slice(0, MAX_ENTITIES_PER_UNIT))) {
    const { name, aliases } = cleanNames(entity.name, entity.aliases);
    if (name === '') continue;
    const facts = cleanFacts(entity.facts, ctx.body, stats);
    const inText = [name, ...aliases].filter((n) => ctx.body.includes(n));
    if (inText.length === 0) {
      stats.dropped++;
      continue;
    }
    const matched = [name, ...aliases].map((n) => index.find(n)).find((id): id is string => id !== null) ?? null;
    if (matched !== null) {
      for (const n of inText) if (index.find(n) === null) add('new_alias', matched, { alias: n }, nameQuote(ctx.body, n));
      for (const f of facts) {
        if (hasSameFact(db, matched, f.attribute, f.value)) {
          stats.duplicates++;
          continue;
        }
        add('new_fact', matched, { attribute: f.attribute, value: f.value, mutable: f.mutable }, f.quote);
      }
      continue;
    }
    const kind: EntryKind = ENTRY_KINDS.includes(entity.kind) ? entity.kind : 'other';
    add(
      'new_entry',
      null,
      // 别名中已属于其他条目的去掉，否则接受时必然冲突
      { kind, name, aliases: aliases.filter((a) => index.find(a) === null), summary: clipText(entity.summary, 200), facts },
      nameQuote(ctx.body, inText[0] as string),
    );
  }
  return stats;
}

/** 同一章节同名的待审核新条目：合并别名与事实（按比较键去重），引文不变。 */
function mergePendingEntry(db: SqliteDatabase, row: CandidateRow, extra: NewEntryPayload): void {
  const p = parsePayload(row.payload) as NewEntryPayload | null;
  if (p === null) return;
  const names = cleanNames(p.name, [...p.aliases, extra.name, ...extra.aliases]);
  const seen = new Set(p.facts.map((f) => `${nameKey(f.attribute)}|${nameKey(f.value)}`));
  const facts = [...p.facts];
  for (const f of extra.facts) {
    const k = `${nameKey(f.attribute)}|${nameKey(f.value)}`;
    if (!seen.has(k)) {
      seen.add(k);
      facts.push(f);
    }
  }
  const merged: NewEntryPayload = { ...p, aliases: names.aliases, summary: p.summary || extra.summary, facts: facts.slice(0, MAX_FACTS_PER_ENTITY * 2) };
  row.payload = JSON.stringify(merged);
  db.prepare('UPDATE bible_candidate SET payload = ? WHERE id = ?').run(row.payload, row.id);
}

// ---------------- 审核（F5 第 3 步） ----------------

const isStr = (v: unknown, max: number, allowEmpty = false): v is string => typeof v === 'string' && (allowEmpty || v.trim() !== '') && [...v].length <= max;

/** 「编辑后接受」时作者提交的载荷：按候选类型逐字段校验。 */
function checkPayload(op: CandidateOp, p: unknown): CandidatePayload {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw invalid('候选内容格式不正确');
  const o = p as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (op === 'new_alias') {
    if (keys !== 'alias' || !isStr(o.alias, 100)) throw invalid('别名候选必须只有非空的 alias');
    return { alias: o.alias };
  }
  if (op === 'new_fact') {
    if (keys !== 'attribute,mutable,value' || !isStr(o.attribute, ATTRIBUTE_MAX_CHARS) || !isStr(o.value, VALUE_MAX_CHARS) || typeof o.mutable !== 'boolean') {
      throw invalid('事实候选必须有非空的 attribute、value 与布尔值 mutable');
    }
    return { attribute: o.attribute, value: o.value, mutable: o.mutable };
  }
  const facts = o.facts;
  if (
    keys !== 'aliases,facts,kind,name,summary' ||
    !ENTRY_KINDS.includes(o.kind as EntryKind) ||
    !isStr(o.name, 100) ||
    !Array.isArray(o.aliases) ||
    !o.aliases.every((a) => isStr(a, 100, true)) ||
    !isStr(o.summary, SUMMARY_MAX_CHARS, true) ||
    !Array.isArray(facts) ||
    !facts.every(
      (f) =>
        typeof f === 'object' &&
        f !== null &&
        isStr((f as Record<string, unknown>).attribute, ATTRIBUTE_MAX_CHARS) &&
        isStr((f as Record<string, unknown>).value, VALUE_MAX_CHARS) &&
        typeof (f as Record<string, unknown>).mutable === 'boolean' &&
        isStr((f as Record<string, unknown>).quote, QUOTE_MAX_CHARS, true),
    )
  ) {
    throw invalid('新条目候选的内容格式不正确');
  }
  return o as unknown as NewEntryPayload;
}

interface DecideContext {
  now: number;
  newId: () => string;
}

/** 接受时写入事实：同条目已有相同属性与值的跳过；引文已不在来源章节当前正文中时（章节改过稿）不保留引文。 */
function addFact(db: SqliteDatabase, ctx: DecideContext, entryId: string, chapterId: string, f: { attribute: string; value: string; mutable: boolean; quote: string }): void {
  const attribute = clipText(f.attribute, ATTRIBUTE_MAX_CHARS);
  const value = clipText(f.value, VALUE_MAX_CHARS);
  if (attribute === '' || value === '' || hasSameFact(db, entryId, attribute, value)) return;
  const body = chapterBodyOf(db, chapterId);
  const exists = body !== null;
  const quote = exists && f.quote !== '' && body.includes(f.quote) ? f.quote : '';
  insertFact(db, ctx.newId(), entryId, { attribute, value, mutable: f.mutable, chapterId: exists ? chapterId : null, quote }, ctx.now);
}

/** 把名称加为目标条目的别名：已是它的名称或别名的跳过；属于其他条目时 INV-9 冲突。 */
function addAliases(db: SqliteDatabase, index: NameIndex, entryId: string, names: readonly string[], candidateId: string, strict: boolean, now: number): void {
  const row = getEntryRow(db, entryId);
  const current = parseAliases(row.aliases);
  const add: string[] = [];
  for (const n of names) {
    const owner = index.find(n);
    if (owner === entryId) continue;
    if (owner !== null) {
      if (strict) throw nameConflictError(index.conflict([n], entryId) ?? { name: n, entryId: owner, entryName: '' }, { candidateId });
      continue;
    }
    add.push(n);
  }
  if (add.length === 0) return;
  const cleaned = cleanNames(row.name, [...current, ...add]);
  writeEntry(db, entryId, { kind: row.kind, name: row.name, aliases: cleaned.aliases, summary: row.summary, firstChapterId: row.first_chapter_id }, now);
  index.add(entryId, row.name, cleaned.aliases);
}

/**
 * 逐条处理审核决定（在一个事务内由调用方包裹）：
 * - accept：new_entry 新建条目（INV-9 查重；与**本批中刚由其他候选新建的条目**冲突时自动合并进去，
 *   这样同名的一组候选可以一次全部接受）；new_fact 写入目标条目；new_alias 加为目标条目的别名；
 * - merge：把候选并入 mergeIntoEntryId——新条目的名称与别名成为目标的别名（属于其他条目的跳过）、事实写入目标；
 *   事实与别名候选改为写入目标条目；
 * - reject：标为已拒绝，以后同键的候选不再生成。
 * payload 存在时表示「编辑后接受」，按候选类型校验后代替原内容。已处理过的候选跳过。冲突时整批回滚（409 NAME_CONFLICT）。
 */
export function decideCandidates(db: SqliteDatabase, decisions: readonly CandidateDecision[], ctx: DecideContext): { accepted: number; rejected: number } {
  const index = NameIndex.load(db);
  const createdInBatch = new Set<string>();
  const result = { accepted: 0, rejected: 0 };
  const seen = new Set<string>();
  const mark = db.prepare('UPDATE bible_candidate SET status = ?, payload = ?, target_entry_id = ?, decided_at = ? WHERE id = ?');

  for (const d of decisions) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    const row = db.prepare('SELECT * FROM bible_candidate WHERE id = ?').get(d.id) as CandidateRow | undefined;
    if (row === undefined) throw missing('候选不存在');
    if (row.status !== 'pending') continue;
    if (d.action === 'reject') {
      mark.run('rejected', row.payload, row.target_entry_id, ctx.now, row.id);
      result.rejected++;
      continue;
    }
    const payload = d.payload === undefined ? parsePayload(row.payload) : checkPayload(row.op, d.payload);
    if (payload === null) throw invalid('候选内容已损坏，只能拒绝');

    let target = row.target_entry_id;
    if (d.action === 'merge') {
      if (d.mergeIntoEntryId === undefined) throw invalid('合并时必须指定目标条目');
      if (findEntryRow(db, d.mergeIntoEntryId) === null) throw missing('要合并到的条目不存在');
      target = d.mergeIntoEntryId;
    } else if (row.op !== 'new_entry' && (target === null || findEntryRow(db, target) === null)) {
      throw invalid('候选对应的条目已被删除，可以合并到其他条目或拒绝');
    }

    if (row.op === 'new_entry') {
      const p = payload as NewEntryPayload;
      const names = cleanNames(p.name, p.aliases);
      if (names.name === '') throw invalid('条目名称不能为空');
      if (d.action === 'accept') {
        const conflict = index.conflict([names.name, ...names.aliases]);
        if (conflict !== null && !createdInBatch.has(conflict.entryId)) throw nameConflictError(conflict, { candidateId: row.id });
        target = conflict?.entryId ?? null;
      }
      if (target === null) {
        const id = ctx.newId();
        insertEntry(
          db,
          id,
          { kind: p.kind, name: names.name, aliases: names.aliases, summary: clipText(p.summary, SUMMARY_MAX_CHARS), firstChapterId: chapterBodyOf(db, row.chapter_id) === null ? null : row.chapter_id },
          ctx.now,
        );
        index.add(id, names.name, names.aliases);
        createdInBatch.add(id);
        target = id;
      } else {
        addAliases(db, index, target, [names.name, ...names.aliases], row.id, false, ctx.now);
        const t = getEntryRow(db, target);
        if (t.summary === '' && p.summary.trim() !== '') {
          writeEntry(db, target, { kind: t.kind, name: t.name, aliases: parseAliases(t.aliases), summary: clipText(p.summary, SUMMARY_MAX_CHARS), firstChapterId: t.first_chapter_id }, ctx.now);
        }
      }
      for (const f of p.facts) addFact(db, ctx, target, row.chapter_id, f);
    } else if (row.op === 'new_fact') {
      const p = payload as NewFactPayload;
      addFact(db, ctx, target as string, row.chapter_id, { ...p, quote: row.quote });
    } else {
      addAliases(db, index, target as string, [(payload as NewAliasPayload).alias.trim()], row.id, true, ctx.now);
    }
    // 记录最终写入的条目（新条目候选为新建或并入的条目）
    mark.run('accepted', JSON.stringify(payload), target, ctx.now, row.id);
    result.accepted++;
  }
  return result;
}
