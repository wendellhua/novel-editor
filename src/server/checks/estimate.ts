import type { JobEstimate } from '../../shared/types';
import type { NewUnit } from './repo';
import type { UnitPhase } from './rows';
import type { Plan } from './units';

/** ⑥ 片段标题与各部分小标题的大致长度（字）。 */
export const PROMPT_FRAME_CHARS = 80;

/** 预估用：④ 前情提要中每章摘要的大致长度（含标签），以及审稿汇总时每章材料（评语、问题、摘要）的大致长度。 */
export const RECAP_ESTIMATE_CHARS = 230;
export const REDUCE_ESTIMATE_CHARS_PER_CHAPTER = 600;
/** 预估用：一致性检查每个片段的 ③ 设定上下文与 ⑤ 前文提及的大致长度。 */
export const CONSISTENCY_CONTEXT_ESTIMATE_CHARS = 1500;
/** 预估用：④ 中剧情记忆（状态快照 + 近期剧情）的大致长度。 */
export const MEMORY_ESTIMATE_CHARS = 1500;
/** 预估用：灵感胶囊、智能扩写的 ③（作品信息与设定）与上一章结尾的大致长度。 */
export const CREATIVE_CONTEXT_ESTIMATE_CHARS = 2000;

export interface EstimateExtras {
  /** 每个 main 单元另加的上下文字数（④ 前情提要等）。 */
  mainContextChars?: number;
  /** reduce 单元的输入字数（已按预算封顶）。 */
  reduceInputChars?: number;
}

/**
 * 预估输入 token（按 1 字 = 1 token，A5）：每个单元 = 本阶段的固定开销（① 协议 + ② 技能规则 + 标题）+ 片段正文，
 * main 单元再加 ④ 等上下文，reduce 单元加汇总材料。⑤ 前文提及等按实际内容裁剪的部分在 T17 补上。
 */
export function estimateJob(plan: Plan, overheadChars: Readonly<Partial<Record<UnitPhase, number>>>, extras: EstimateExtras = {}): JobEstimate {
  const unitChars = (u: NewUnit): number => {
    const base = (overheadChars[u.phase] ?? 0) + PROMPT_FRAME_CHARS + (u.end - u.start);
    if (u.phase === 'main') return base + (extras.mainContextChars ?? 0);
    if (u.phase === 'reduce') return base + (extras.reduceInputChars ?? 0);
    return base;
  };
  return {
    chapters: plan.chapters,
    chars: plan.chars,
    units: plan.units.length,
    skippedChapters: plan.skippedChapters,
    estimatedInputTokens: plan.units.reduce((n, u) => n + unitChars(u), 0),
  };
}
