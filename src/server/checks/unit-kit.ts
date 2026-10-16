import type { ChapterSnapshot, CommitResult, UnitContext } from './handlers';
import { targetHeader, type PromptParts } from './prompt';

/** 处理器共用的小工具（handlers、creative、memory-unit 都用；只依赖 handlers 的类型，避免循环引用）。 */
export const NOTHING: CommitResult = { written: 0, unanchored: 0, filtered: 0, duplicates: 0 };

export function requireChapter(ctx: UnitContext): ChapterSnapshot {
  if (ctx.chapter === null) throw new Error(`${ctx.unit.phase} 阶段的单元缺少章节`);
  return ctx.chapter;
}

/** ⑥：本单元的片段标题与原文。 */
export function chunkTarget(ctx: UnitContext): PromptParts['target'] {
  const c = requireChapter(ctx);
  return {
    header: targetHeader(c.volume, c, ctx.chunk.index, ctx.chunk.count),
    text: c.body.slice(ctx.unit.range_start, ctx.unit.range_end),
  };
}
