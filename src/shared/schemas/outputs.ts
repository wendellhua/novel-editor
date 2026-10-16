/**
 * 模型输出 JSON Schema（§7.4.2，字段名逐字固定）。服务端用 Ajv 校验（INV-11），json_schema 档原样发给模型。
 * 为兼容 OpenAI strict 模式：每个对象都 additionalProperties: false 且列出全部 required；
 * 只使用 type / properties / required / additionalProperties / items / enum 这几个关键字（§6.5 校验）。
 * 长度、条数等质量约束不放在 Schema 里，由本地锚定与过滤处理——一条不合格不应让整批输出作废。
 */

const str = { type: 'string' } as const;
const strOrNull = { type: ['string', 'null'] } as const;
const bool = { type: 'boolean' } as const;
const strEnum = <T extends string>(values: readonly T[]) => ({ type: 'string', enum: [...values] }) as const;

function obj(properties: Record<string, object>): object {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
const arrayOf = (items: object): object => ({ type: 'array', items });

export interface TypoOutput {
  issues: {
    excerpt: string;
    target: string;
    replacement: string;
    category: 'typo' | 'punctuation' | 'grammar';
    severity: 'error' | 'warning';
    message: string;
  }[];
}

export interface ReviewOutput {
  issues: { excerpt: string; target: string; replacement: string | null; severity: 'warning' | 'info'; message: string }[];
  comment: string;
}

export interface ReviewReduceOutput {
  report: string;
}

export interface ConsistencyOutput {
  issues: {
    excerpt: string;
    target: string;
    replacement: string | null;
    severity: 'error' | 'warning';
    entryName: string;
    evidence: string;
    message: string;
  }[];
}

export interface ExtractOutput {
  entities: {
    name: string;
    kind: 'character' | 'location' | 'faction' | 'item' | 'rule' | 'other';
    aliases: string[];
    summary: string;
    facts: { attribute: string; value: string; mutable: boolean; quote: string }[];
  }[];
}

export interface SummaryOutput {
  summary: string;
}

/** AI 修复（F4 补充）：按问题的意见改写 target，replacement 是放回原处的完整文字。 */
export interface FixOutput {
  replacement: string;
}

/** AI 味检测：每条是一处 AI 味明显的文字与它去 AI 味后的改写（可一键优化）。 */
export interface AiFlavorOutput {
  issues: { excerpt: string; target: string; replacement: string; severity: 'warning' | 'info'; message: string }[];
}

/** 灵感胶囊：当前局势、情绪曲线与若干条剧情发展路线（本地渲染为 Markdown 报告）。 */
export interface InspirationOutput {
  situation: string;
  emotion: string;
  routes: { title: string; premise: string; beats: string[]; tension: string; hook: string; risk: string }[];
}

/** 智能扩写：接在本章已有正文之后的续写。 */
export interface ExpandOutput {
  text: string;
}

/** 剧情记忆的一次增量更新：本批新正文中的事件 + 更新后的全书状态（ADR-011）。 */
export interface MemoryOutput {
  events: string[];
  mainline: string;
  characters: { name: string; status: string }[];
  threads: string[];
  emotion: string;
}

export const OUTPUT_SCHEMAS = {
  typo: obj({
    issues: arrayOf(
      obj({
        excerpt: str,
        target: str,
        replacement: str,
        category: strEnum(['typo', 'punctuation', 'grammar']),
        severity: strEnum(['error', 'warning']),
        message: str,
      }),
    ),
  }),
  review: obj({
    issues: arrayOf(obj({ excerpt: str, target: str, replacement: strOrNull, severity: strEnum(['warning', 'info']), message: str })),
    comment: str,
  }),
  review_reduce: obj({ report: str }),
  consistency: obj({
    issues: arrayOf(
      obj({
        excerpt: str,
        target: str,
        replacement: strOrNull,
        severity: strEnum(['error', 'warning']),
        entryName: str,
        evidence: str,
        message: str,
      }),
    ),
  }),
  extract: obj({
    entities: arrayOf(
      obj({
        name: str,
        kind: strEnum(['character', 'location', 'faction', 'item', 'rule', 'other']),
        aliases: arrayOf(str),
        summary: str,
        facts: arrayOf(obj({ attribute: str, value: str, mutable: bool, quote: str })),
      }),
    ),
  }),
  summary: obj({ summary: str }),
  fix: obj({ replacement: str }),
  ai_flavor: obj({
    issues: arrayOf(obj({ excerpt: str, target: str, replacement: str, severity: strEnum(['warning', 'info']), message: str })),
  }),
  inspiration: obj({
    situation: str,
    emotion: str,
    routes: arrayOf(obj({ title: str, premise: str, beats: arrayOf(str), tension: str, hook: str, risk: str })),
  }),
  expand: obj({ text: str }),
  memory: obj({
    events: arrayOf(str),
    mainline: str,
    characters: arrayOf(obj({ name: str, status: str })),
    threads: arrayOf(str),
    emotion: str,
  }),
} as const;

export type OutputSchemaName = keyof typeof OUTPUT_SCHEMAS;
