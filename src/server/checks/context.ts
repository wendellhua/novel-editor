import { RECAP_CHAPTERS } from '../../shared/constants';
import { chapterLabel, tocChapters, type TocChapter } from '../manuscript/toc';
import type { SqliteDatabase } from '../storage/sqlite';
import { readSummary } from './analysis';
import type { PromptBlock } from './prompt';

export { chapterLabel, tocChapters, type TocChapter };

/**
 * §7.4.1 ④ 前情提要：全书顺序中本章之前 RECAP_CHAPTERS 章的摘要（没有摘要的章节跳过）。
 * 使用最近一次完整的摘要——即使它对应的是该章较早的正文版本（摘要单元失败、或检查期间改了稿），也比没有好。
 * 每章一段，可裁剪；order 越小越早，超预算时先裁最早的。
 */
export function recapBlocks(db: SqliteDatabase, chapterId: string, toc: readonly TocChapter[] = tocChapters(db)): PromptBlock[] {
  const i = toc.findIndex((c) => c.id === chapterId);
  if (i <= 0) return [];
  const blocks: PromptBlock[] = [];
  for (let k = Math.max(0, i - RECAP_CHAPTERS); k < i; k++) {
    const c = toc[k] as TocChapter;
    const s = readSummary(db, c.id);
    if (s !== null) blocks.push({ text: `【${chapterLabel(c)}】${s.summary}`, trimmable: true, order: k });
  }
  return blocks;
}

/** reduce 输入中的一章。 */
export interface ReduceSection {
  heading: string;
  body: string;
}

/**
 * 把各章的材料放进 budget 个字符（审稿 reduce 的 ⑥）：
 * - 放得下就原样拼接；
 * - 放不下时给每章正文同一个上限 cap（二分查找能放下的最大值），超出的截断并以「…」结尾；
 * - cap 为 0 仍放不下（章节极多）时，按目录顺序保留能放下的章节，末尾注明省略了几章。
 */
export function fitSections(sections: readonly ReduceSection[], budget: number): { text: string; truncated: number; omitted: number } {
  const render = (cap: number, count = sections.length): { text: string; truncated: number } => {
    let truncated = 0;
    const parts = sections.slice(0, count).map((s) => {
      const cps = [...s.body];
      if (cps.length <= cap) return `${s.heading}\n${s.body}`;
      truncated++;
      return `${s.heading}\n${cap > 0 ? `${cps.slice(0, cap).join('')}…` : '…'}`;
    });
    return { text: parts.join('\n\n'), truncated };
  };
  const full = render(Number.MAX_SAFE_INTEGER);
  if (full.text.length <= budget) return { ...full, omitted: 0 };
  let lo = 0;
  let hi = Math.max(0, ...sections.map((s) => [...s.body].length));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (render(mid).text.length <= budget) lo = mid;
    else hi = mid - 1;
  }
  const capped = render(lo);
  if (capped.text.length <= budget) return { ...capped, omitted: 0 };
  // cap = 0 时每章渲染为「标题\n…」，章与章之间空一行：按前缀长度求能放下的最多章数
  const note = (n: number): string => `\n\n（另有 ${n} 章因篇幅省略）`;
  let count = 0;
  let used = 0;
  for (const s of sections) {
    const add = (count === 0 ? 0 : 2) + s.heading.length + 2;
    if (used + add + note(sections.length - count - 1).length > budget) break;
    used += add;
    count++;
  }
  const kept = render(0, count);
  return { text: kept.text + note(sections.length - count), truncated: kept.truncated, omitted: sections.length - count };
}
