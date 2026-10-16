import type { EntryKind } from '../../shared/types';
import { chapterShortLabel, type TocChapter } from '../manuscript/toc';
import type { SqliteDatabase } from '../storage/sqlite';
import { searchChapterRids } from '../storage/fts';
import { parseAliases, type EntryRow, type FactRow } from './rows';

/** 与 checks/prompt 的 PromptBlock 结构一致（这里不依赖 checks，避免循环引用）。 */
export interface ContextBlock {
  text: string;
  trimmable: boolean;
  order: number;
}

export const KIND_LABELS: Record<EntryKind, string> = { character: '角色', location: '地点', faction: '势力', item: '物品', rule: '规则', other: '其他' };

/** 少于这么多个字的名称不参与匹配（单字名在正文中随处可见）。 */
export const MIN_MATCH_CHARS = 2;
/** ⑤ 每个条目最多取几段前文、每段前后各取多少字。 */
export const MENTIONS_PER_ENTRY = 2;
export const MENTION_CONTEXT_CHARS = 80;

export interface ContextEntry {
  id: string;
  kind: EntryKind;
  name: string;
  aliases: string[];
  summary: string;
  /** 在文本中出现的名称（名称或别名，按长度从长到短）。 */
  hits: string[];
}

const chars = (s: string): number => [...s].length;

/** 本地按名称、别名匹配出在 text 中出现的已确认条目（§7.4.1 ③ 的「本块中出现的条目」）。 */
export function entriesInText(db: SqliteDatabase, text: string): ContextEntry[] {
  const out: ContextEntry[] = [];
  for (const r of db.prepare('SELECT * FROM bible_entry ORDER BY created_at, rowid').all() as unknown as EntryRow[]) {
    const aliases = parseAliases(r.aliases);
    const hits = [r.name, ...aliases].filter((n) => chars(n.trim()) >= MIN_MATCH_CHARS && text.includes(n)).sort((a, b) => chars(b) - chars(a));
    if (hits.length > 0) out.push({ id: r.id, kind: r.kind, name: r.name, aliases, summary: r.summary, hits });
  }
  return out;
}

/**
 * 错别字检查的 ③ 专名白名单（ADR-009）：本片段中出现的设定库名称与别名，告诉模型它们一律正确。
 * 只有一段、可裁剪（本地 INV-10 ④ 的专名过滤仍然兜底）。
 */
export function nameWhitelistBlocks(entries: readonly ContextEntry[]): ContextBlock[] {
  const names = [...new Set(entries.flatMap((e) => [e.name, ...e.aliases]).filter((n) => n.trim() !== ''))];
  if (names.length === 0) return [];
  return [{ text: `以下是本作品设定库中的专有名词（含别名），一律视为正确写法，不要当作错别字报告：${names.join('、')}`, trimmable: true, order: 0 }];
}

/** 抽取时的 ③：只列出已有条目的名称、别名与简介，帮助模型沿用设定库中的叫法。可裁剪。 */
export function knownEntryBlocks(entries: readonly ContextEntry[]): ContextBlock[] {
  return entries.map((e, i) => ({
    text: `【${KIND_LABELS[e.kind]}】${e.name}${e.aliases.length > 0 ? `（别名：${e.aliases.join('、')}）` : ''}${e.summary !== '' ? `：${e.summary}` : ''}`,
    trimmable: true,
    order: i,
  }));
}

/**
 * 一致性检查的 ③ 设定上下文（ADR-009）：
 * - 每个条目一段不可裁剪的内容：类型、名称、别名、简介与全部**不变**事实；
 * - **可变**事实按属性只取「截至上一章」的最新值（来源章节在本章之前；作者手填、来源章节已删除的视为最早），
 *   每条一段、注明来源，可裁剪，越早的越先裁。
 */
export function settingBlocks(db: SqliteDatabase, entries: readonly ContextEntry[], chapterId: string, toc: readonly TocChapter[]): ContextBlock[] {
  const position = new Map(toc.map((c, i) => [c.id, i]));
  const current = position.get(chapterId) ?? toc.length;
  const blocks: ContextBlock[] = [];
  for (const e of entries) {
    const facts = db.prepare('SELECT * FROM bible_fact WHERE entry_id = ? ORDER BY created_at, rowid').all(e.id) as unknown as FactRow[];
    const fixed = facts.filter((f) => f.mutable === 0).map((f) => `- ${f.attribute}：${f.value}`);
    const head = `【${KIND_LABELS[e.kind]}】${e.name}${e.aliases.length > 0 ? `（别名：${e.aliases.join('、')}）` : ''}${e.summary !== '' ? `：${e.summary}` : ''}`;
    blocks.push({ text: [head, ...fixed].join('\n'), trimmable: false, order: 0 });
    const latest = new Map<string, { fact: FactRow; at: number }>();
    for (const f of facts.filter((x) => x.mutable === 1)) {
      const at = f.chapter_id === null ? -1 : (position.get(f.chapter_id) ?? -1);
      if (at >= current) continue;
      const key = f.attribute.trim();
      const prev = latest.get(key);
      if (prev === undefined || at >= prev.at) latest.set(key, { fact: f, at });
    }
    for (const { fact, at } of [...latest.values()].sort((a, b) => a.at - b.at)) {
      const source = at < 0 ? '作者设定' : `截至${chapterShortLabel(toc[at] as TocChapter)}`;
      blocks.push({ text: `- ${e.name} · ${fact.attribute}：${fact.value}（可变，${source}）`, trimmable: true, order: at });
    }
  }
  return blocks;
}

/**
 * ⑤ 前文提及：每个条目最多取 MENTIONS_PER_ENTRY 段早于本章的原文片段（前后各 MENTION_CONTEXT_CHARS 字）——
 * 第一次出现的章节与最近一次出现的章节，分别给出来历与最新状态。
 * 检索（ADR-003）：名称 ≥ 3 字走 FTS5 trigram 短语匹配，2 字走 instr()；依次尝试条目在本块中出现的名称（长的优先）。
 */
export function mentionBlocks(db: SqliteDatabase, entries: readonly ContextEntry[], chapterId: string, toc: readonly TocChapter[]): ContextBlock[] {
  const position = new Map(toc.map((c, i) => [c.rid, i]));
  const current = toc.findIndex((c) => c.id === chapterId);
  if (current <= 0) return [];
  const bodyOf = db.prepare('SELECT body FROM chapter WHERE id = ?');
  const blocks: ContextBlock[] = [];
  for (const e of entries) {
    for (const term of e.hits) {
      const earlier = searchChapterRids(db, term)
        .map((rid) => position.get(rid))
        .filter((i): i is number => i !== undefined && i < current)
        .sort((a, b) => a - b);
      if (earlier.length === 0) continue;
      const picks = [...new Set([earlier[0] as number, earlier.at(-1) as number])].slice(0, MENTIONS_PER_ENTRY);
      for (const i of picks) {
        const c = toc[i] as TocChapter;
        const body = (bodyOf.get(c.id) as { body: string } | undefined)?.body ?? '';
        const at = body.indexOf(term);
        if (at < 0) continue;
        const start = Math.max(0, at - MENTION_CONTEXT_CHARS);
        const end = Math.min(body.length, at + term.length + MENTION_CONTEXT_CHARS);
        const passage = `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\s+/gu, ' ').trim()}${end < body.length ? '…' : ''}`;
        blocks.push({ text: `【${e.name} · ${chapterShortLabel(c)}】${passage}`, trimmable: true, order: i });
      }
      break;
    }
  }
  return blocks;
}
