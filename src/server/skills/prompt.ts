import { LIMITS } from '../../shared/constants';

/**
 * §7.4.1 ② 技能规则段：`## 检查规则（技能：{name}）` + SKILL.md 正文 + references（按路径排序）。
 * 总长不超过 maxChars，超出部分截断并注明。只用到 .md / .txt 文本（INV-13）。
 */
export function buildSkillRules(
  name: string,
  body: string,
  references: { path: string; text: string }[],
  maxChars: number = LIMITS.skillPromptMaxChars,
): string {
  const parts = [`## 检查规则（技能：${name}）`, body.trim()];
  for (const ref of [...references].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const text = ref.text.replace(/\r\n?/g, '\n').trim();
    if (text !== '') parts.push(`### 参考资料：${ref.path}\n\n${text}`);
  }
  const full = parts.filter((p) => p !== '').join('\n\n');
  if (full.length <= maxChars) return full;
  const note = `\n\n（技能内容超过 ${maxChars} 字，其余部分已截断）`;
  return `${full.slice(0, Math.max(0, maxChars - note.length))}${note}`;
}
