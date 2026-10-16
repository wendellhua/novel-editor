import { LIMITS } from '../../shared/constants';
import type { IssueCategory } from '../../shared/types';
import type { SqliteDatabase } from '../storage/sqlite';

export type FilterOutcome =
  | { keep: true; category: IssueCategory }
  | { keep: false; reason: 'no_change' | 'proper_noun' };

export interface FilterInput {
  category: IssueCategory;
  target: string;
  replacement: string | null;
  /** 锚定后的位置（用于判断是否落在专名内部）。 */
  start: number;
  end: number;
}

const charCount = (s: string): number => [...s].length;

/** name 在 body 中的出现是否与 [start, end) 重叠（只查附近，避免扫描整章）。 */
function overlapsName(body: string, start: number, end: number, name: string): boolean {
  const from = Math.max(0, start - name.length + 1);
  for (let i = body.indexOf(name, from); i >= 0 && i < end; i = body.indexOf(name, i + 1)) {
    if (i + name.length > start) return true;
  }
  return false;
}

/**
 * INV-10：错别字检查结果的本地过滤，按顺序：
 * ① replacement 与 target 相同 → 丢弃（所有类别：没有修改的建议没有意义）；
 * ④ typo / punctuation 类的 target 包含任何已确认的设定名称或别名，或者落在正文中某个专名（≥ 2 字）的内部 → 丢弃；
 * ② target 不是 1～typoTargetMaxChars 个字，或 ③ 与 replacement 的字数差超过 typoLengthDeltaMax → 改为 grammar 类。
 * 字数按 Unicode 码点计。grammar 类只执行 ①。
 */
export function filterTypoIssue(item: FilterInput, body: string, names: readonly string[]): FilterOutcome {
  if (item.replacement !== null && item.replacement === item.target) return { keep: false, reason: 'no_change' };
  if (item.category !== 'typo' && item.category !== 'punctuation') return { keep: true, category: item.category };
  for (const name of names) {
    if (name === '') continue;
    if (item.target.includes(name)) return { keep: false, reason: 'proper_noun' };
    if (charCount(name) >= 2 && overlapsName(body, item.start, item.end, name)) return { keep: false, reason: 'proper_noun' };
  }
  const len = charCount(item.target);
  const delta = Math.abs(len - charCount(item.replacement ?? ''));
  if (len < 1 || len > LIMITS.typoTargetMaxChars || delta > LIMITS.typoLengthDeltaMax) return { keep: true, category: 'grammar' };
  return { keep: true, category: item.category };
}

/** 设定库中已确认条目的名称与别名（去重、去空）。T16 之前设定库为空。 */
export function confirmedNames(db: SqliteDatabase): string[] {
  const rows = db.prepare('SELECT name, aliases FROM bible_entry').all() as { name: string; aliases: string }[];
  const out = new Set<string>();
  for (const r of rows) {
    if (r.name.trim() !== '') out.add(r.name.trim());
    try {
      const aliases = JSON.parse(r.aliases) as unknown;
      if (Array.isArray(aliases)) for (const a of aliases) if (typeof a === 'string' && a.trim() !== '') out.add(a.trim());
    } catch {
      // aliases 不是合法 JSON：忽略别名，名称仍然生效
    }
  }
  return [...out];
}
