import { normalizeForMatch } from '../../shared/text';
import { DomainError } from '../errors';
import type { SqliteDatabase } from '../storage/sqlite';
import { parseAliases, type EntryRow } from './rows';

/** 名称、别名的长度与个数上限。 */
export const NAME_MAX_CHARS = 100;
export const ALIASES_MAX = 50;

/** INV-9 的比较键：normalizeForMatch（NFKC、统一标点、去空白）后再转小写。 */
export const nameKey = (s: string): string => normalizeForMatch(s.trim()).text.toLowerCase();

/** 清洗名称与别名：去首尾空白、去空值、截断长度；别名按比较键去重，并去掉与名称相同的别名。 */
export function cleanNames(name: string, aliases: readonly string[]): { name: string; aliases: string[] } {
  const clip = (s: string): string => [...s.trim()].slice(0, NAME_MAX_CHARS).join('');
  const n = clip(name);
  const seen = new Set([nameKey(n)]);
  const out: string[] = [];
  for (const a of aliases) {
    const c = clip(a);
    const k = nameKey(c);
    if (k === '' || seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= ALIASES_MAX) break;
  }
  return { name: n, aliases: out };
}

export interface NameConflict {
  /** 冲突的名称或别名（来自待写入的一方）。 */
  name: string;
  entryId: string;
  entryName: string;
}

/** 已确认条目的名称索引（比较键 → 条目）。 */
export class NameIndex {
  private readonly byKey = new Map<string, { id: string; name: string }>();

  constructor(rows: readonly Pick<EntryRow, 'id' | 'name' | 'aliases'>[]) {
    for (const r of rows) this.add(r.id, r.name, parseAliases(r.aliases));
  }

  static load(db: SqliteDatabase): NameIndex {
    return new NameIndex(db.prepare('SELECT id, name, aliases FROM bible_entry').all() as unknown as EntryRow[]);
  }

  add(id: string, name: string, aliases: readonly string[]): void {
    for (const s of [name, ...aliases]) {
      const k = nameKey(s);
      if (k !== '' && !this.byKey.has(k)) this.byKey.set(k, { id, name });
    }
  }

  remove(id: string): void {
    for (const [k, v] of this.byKey) if (v.id === id) this.byKey.delete(k);
  }

  /** 名称对应的条目 id（按比较键）。 */
  find(name: string): string | null {
    return this.byKey.get(nameKey(name))?.id ?? null;
  }

  /** names 中第一个与「除 exceptId 之外的条目」冲突的名称。 */
  conflict(names: readonly string[], exceptId: string | null = null): NameConflict | null {
    for (const n of names) {
      const hit = this.byKey.get(nameKey(n));
      if (hit !== undefined && hit.id !== exceptId) return { name: n, entryId: hit.id, entryName: hit.name };
    }
    return null;
  }
}

/** INV-9 冲突：409 NAME_CONFLICT，附带冲突的条目，界面据此提示合并。 */
export function nameConflictError(c: NameConflict, extra: Record<string, unknown> = {}): DomainError {
  return new DomainError('NAME_CONFLICT', `「${c.name}」已是条目「${c.entryName}」的名称或别名，可以合并到该条目`, {
    name: c.name,
    entryId: c.entryId,
    entryName: c.entryName,
    ...extra,
  });
}
