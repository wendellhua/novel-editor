import { parse as parseYaml } from 'yaml';
import { skillInvalid } from './errors';

export interface ParsedSkill {
  name: string;
  description: string;
  version: string;
  /** frontmatter 之后的正文（统一为 \n 换行，去掉首尾空行）。 */
  body: string;
}

export const SKILL_NAME_MAX = 100;
export const SKILL_DESCRIPTION_MAX = 4000;

const FRONTMATTER_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * 解析 SKILL.md（§7.5）：用 `yaml` 解析 frontmatter，支持多行写法（`>`、`|`、引号折行）。
 * `name`、`description` 必填且非空；`version` 可选（数字也接受），默认 '0.0.0'；其他字段忽略。
 */
export function parseSkillMd(text: string): ParsedSkill {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = FRONTMATTER_RE.exec(normalized);
  if (m === null) throw skillInvalid('SKILL.md 开头缺少 --- 包围的 frontmatter');
  let meta: unknown;
  try {
    meta = parseYaml(m[1] ?? '', { schema: 'core', maxAliasCount: 0 });
  } catch (err) {
    throw skillInvalid(`SKILL.md 的 frontmatter 不是合法 YAML：${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) throw skillInvalid('SKILL.md 的 frontmatter 必须是键值对');
  const fields = meta as Record<string, unknown>;

  const name = scalarText(fields.name);
  if (name === null || name === '') throw skillInvalid('SKILL.md 缺少 name');
  if (name.length > SKILL_NAME_MAX) throw skillInvalid(`SKILL.md 的 name 超过 ${SKILL_NAME_MAX} 字`);
  const description = scalarText(fields.description);
  if (description === null || description === '') throw skillInvalid('SKILL.md 缺少 description');
  const version = fields.version === undefined || fields.version === null ? '0.0.0' : (scalarText(fields.version) ?? '0.0.0');

  return {
    name,
    description: description.length > SKILL_DESCRIPTION_MAX ? `${description.slice(0, SKILL_DESCRIPTION_MAX)}…` : description,
    version: version === '' ? '0.0.0' : version.slice(0, 50),
    body: normalized.slice(m[0].length).replace(/^\n+/, '').replace(/\s+$/, ''),
  };
}
