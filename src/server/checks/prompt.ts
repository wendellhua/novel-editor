import { PROMPT_BUDGET_MARGIN_TOKENS } from '../../shared/constants';
import type { LlmProfileRecord } from '../../shared/types';
import type { ChatMessage } from '../llm/client';

/** ③④⑤ 中的一段内容。trimmable = false 的段落永不裁剪（如条目名称与不变事实）。 */
export interface PromptBlock {
  text: string;
  trimmable: boolean;
  /** 同一部分内的裁剪先后：越小越先被裁掉（③ 中较早的可变事实、④ 中较早的章节摘要）。 */
  order: number;
}

/** §7.4.1 六个部分。①②⑥ 不裁剪。 */
export interface PromptParts {
  protocol: string;
  skillRules: string;
  setting: PromptBlock[];
  recap: PromptBlock[];
  mentions: PromptBlock[];
  target: { header: string; text: string };
}

export type TrimmableSection = 'mentions' | 'recap' | 'setting';

export interface AssembledPrompt {
  messages: ChatMessage[];
  /** 全部消息内容的字符数（按 1 字 = 1 token 估算，A5）。 */
  inputChars: number;
  budget: number;
  /** 依次被裁掉的段落（用于日志与快照测试）。 */
  trimmed: { section: TrimmableSection; text: string }[];
  /** 不可裁剪的部分本身就超过预算。 */
  overBudget: boolean;
}

/** 裁剪顺序：⑤ → ④ → ③（§7.4.1）。 */
export const TRIM_ORDER: readonly TrimmableSection[] = ['mentions', 'recap', 'setting'];

const HEADINGS: Record<TrimmableSection | 'target', string> = {
  setting: '## 设定上下文',
  recap: '## 前情提要',
  mentions: '## 前文提及',
  target: '## 待查正文',
};

/** §7.4.1 的输入预算：contextTokens − maxOutputTokens − PROMPT_BUDGET_MARGIN_TOKENS。 */
export function promptBudget(profile: Pick<LlmProfileRecord, 'contextTokens' | 'maxOutputTokens'>): number {
  return profile.contextTokens - profile.maxOutputTokens - PROMPT_BUDGET_MARGIN_TOKENS;
}

/** ⑥ 的片段标题：`【第{卷序}卷 {卷名} · 第{章序}章 {章名} · 片段 {i}/{n}】`（序号从 1 开始）。 */
export function targetHeader(volume: { seq: number; title: string }, chapter: { seq: number; title: string }, index: number, count: number): string {
  return `【第${volume.seq + 1}卷 ${volume.title} · 第${chapter.seq + 1}章 ${chapter.title} · 片段 ${index + 1}/${count}】`;
}

function render(parts: PromptParts, keep: Record<TrimmableSection, PromptBlock[]>): ChatMessage[] {
  const system = [parts.protocol.trim(), parts.skillRules.trim()].filter((s) => s !== '').join('\n\n');
  const sections: string[] = [];
  for (const name of ['setting', 'recap', 'mentions'] as const) {
    const blocks = keep[name];
    if (blocks.length > 0) sections.push(`${HEADINGS[name]}\n\n${blocks.map((b) => b.text.trim()).join('\n\n')}`);
  }
  sections.push(`${HEADINGS.target}\n\n${parts.target.header}\n${parts.target.text}`);
  return [
    { role: 'system', content: system },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

const sizeOf = (messages: ChatMessage[]): number => messages.reduce((n, m) => n + m.content.length, 0);

/**
 * 组装提示词（§7.4.1，顺序固定）。超出预算时按 ⑤ → ④ → ③ 的顺序逐段裁剪，同一部分内先裁 order 小的；
 * 每裁一段重新计算长度，刚好放得下就停止。不可裁剪的部分超出预算时照样返回并标记 overBudget。
 */
export function assemblePrompt(parts: PromptParts, budget: number): AssembledPrompt {
  const keep: Record<TrimmableSection, PromptBlock[]> = { setting: [...parts.setting], recap: [...parts.recap], mentions: [...parts.mentions] };
  const trimmed: AssembledPrompt['trimmed'] = [];
  let messages = render(parts, keep);
  for (const section of TRIM_ORDER) {
    while (sizeOf(messages) > budget) {
      const candidates = keep[section].filter((b) => b.trimmable);
      if (candidates.length === 0) break;
      const victim = candidates.reduce((a, b) => (b.order < a.order ? b : a));
      keep[section] = keep[section].filter((b) => b !== victim);
      trimmed.push({ section, text: victim.text });
      messages = render(parts, keep);
    }
  }
  const inputChars = sizeOf(messages);
  return { messages, inputChars, budget, trimmed, overBudget: inputChars > budget };
}
