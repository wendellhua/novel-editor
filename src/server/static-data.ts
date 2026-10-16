import Ajv from 'ajv';
import * as C from '../shared/constants';
import { API_SCHEMAS } from '../shared/schemas/api';
import { OUTPUT_SCHEMAS } from '../shared/schemas/outputs';
import type { AssetReader } from './assets';
import { JOB_HANDLERS, type JobHandler } from './checks/handlers';
import { targetHeader } from './checks/prompt';
import { FIX_PROTOCOL } from './checks/protocol';
import { NEEDS_REDUCE, NEEDS_SUMMARY } from './checks/units';
import { compileAllApiSchemas } from './http/validate';
import { LLM_PRESETS, findPresetProblems } from './llm/presets';
import { findBuiltinProblems } from './skills/builtin';
import { sanitizeRegistry } from './skills/registry';
import { findMigrationProblems } from './storage/migrations';
import { AJV_OPTIONS } from './system/ajv';
import { sanitizeAppConfig, sanitizeLlmConfig, type Sanitized } from './system/config';

// ---------------------------------------------------------------------------
// shared/constants.ts（§6.4 / §6.5）
// ---------------------------------------------------------------------------

/** 被校验的共享常量。测试会传入改坏的副本，确认每条约束都能发现问题。 */
export interface SharedConstants {
  DEFAULT_PORT: number;
  CHECK_TYPES: readonly string[];
  JOB_TYPES: readonly string[];
  TASK_KINDS: readonly string[];
  JSON_MODES: readonly string[];
  ENTRY_KINDS: readonly string[];
  THEME_MODES: readonly string[];
  CHUNK_CHARS: Readonly<Record<string, number>>;
  LIMITS: Readonly<Record<string, number>>;
  BODY_LIMITS: Readonly<Record<string, number>>;
  SENTENCE_END_CHARS: string;
  LLM_PROFILE_DEFAULTS: Readonly<{
    jsonMode: string;
    maxConcurrency: number;
    timeoutMs: number;
    maxOutputTokens: number;
    contextTokens: number;
    temperature: number;
  }>;
  LLM_PROFILE_RANGES: Readonly<Record<string, readonly [number, number]>>;
  LLM_FIELD_MAX: Readonly<Record<string, number>>;
  LLM_PROMPT_HEADROOM: number;
  LLM_EXTRA_BODY_RESERVED: readonly string[];
  LLM_RETRY_DELAYS_MS: readonly number[];
  LLM_RETRY_AFTER_MAX_MS: number;
  LLM_TIMEOUT_RETRIES: number;
  LLM_PROBE_REQUEST_TIMEOUT_MS: number;
  LLM_PROBE_DEADLINE_MS: number;
  PROMPT_BUDGET_MARGIN_TOKENS: number;
  PROMPT_PROTOCOL_MAX_CHARS: number;
  ENABLED_JOB_TYPES: readonly string[];
  AUTO_JOB_TYPES: readonly string[];
  CHAPTER_SCOPE_JOB_TYPES: readonly string[];
  CREATIVE_LIMITS: Readonly<Record<string, number>>;
  EXPAND_TOKENS_PER_CHAR: number;
  LLM_DEFAULT_FALLBACKS: Readonly<Record<string, readonly string[] | undefined>>;
  RECAP_CHAPTERS: number;
  MAX_ISSUES_PER_UNIT: number;
}

export const SHARED_CONSTANTS: SharedConstants = {
  DEFAULT_PORT: C.DEFAULT_PORT,
  CHECK_TYPES: C.CHECK_TYPES,
  JOB_TYPES: C.JOB_TYPES,
  TASK_KINDS: C.TASK_KINDS,
  ENABLED_JOB_TYPES: C.ENABLED_JOB_TYPES,
  AUTO_JOB_TYPES: C.AUTO_JOB_TYPES,
  CHAPTER_SCOPE_JOB_TYPES: C.CHAPTER_SCOPE_JOB_TYPES,
  CREATIVE_LIMITS: C.CREATIVE_LIMITS,
  EXPAND_TOKENS_PER_CHAR: C.EXPAND_TOKENS_PER_CHAR,
  LLM_DEFAULT_FALLBACKS: C.LLM_DEFAULT_FALLBACKS,
  RECAP_CHAPTERS: C.RECAP_CHAPTERS,
  MAX_ISSUES_PER_UNIT: C.MAX_ISSUES_PER_UNIT,
  JSON_MODES: C.JSON_MODES,
  ENTRY_KINDS: C.ENTRY_KINDS,
  THEME_MODES: C.THEME_MODES,
  CHUNK_CHARS: C.CHUNK_CHARS,
  LIMITS: C.LIMITS,
  BODY_LIMITS: C.BODY_LIMITS,
  SENTENCE_END_CHARS: C.SENTENCE_END_CHARS,
  LLM_PROFILE_DEFAULTS: C.LLM_PROFILE_DEFAULTS,
  LLM_PROFILE_RANGES: C.LLM_PROFILE_RANGES,
  LLM_FIELD_MAX: C.LLM_FIELD_MAX,
  LLM_PROMPT_HEADROOM: C.LLM_PROMPT_HEADROOM,
  LLM_EXTRA_BODY_RESERVED: C.LLM_EXTRA_BODY_RESERVED,
  LLM_RETRY_DELAYS_MS: C.LLM_RETRY_DELAYS_MS,
  LLM_RETRY_AFTER_MAX_MS: C.LLM_RETRY_AFTER_MAX_MS,
  LLM_TIMEOUT_RETRIES: C.LLM_TIMEOUT_RETRIES,
  LLM_PROBE_REQUEST_TIMEOUT_MS: C.LLM_PROBE_REQUEST_TIMEOUT_MS,
  LLM_PROBE_DEADLINE_MS: C.LLM_PROBE_DEADLINE_MS,
  PROMPT_BUDGET_MARGIN_TOKENS: C.PROMPT_BUDGET_MARGIN_TOKENS,
  PROMPT_PROTOCOL_MAX_CHARS: C.PROMPT_PROTOCOL_MAX_CHARS,
};

const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const KB = 1024;

/** UTF-8 下每个 UTF-16 码元最多 3 字节（代理对是 2 个码元 4 字节），JSON 外壳另留 64 KB。 */
export const utf8JsonBytesFor = (chars: number): number => chars * 3 + 64 * KB;

/** 文件夹导入的请求体上限：全部文件 base64 编码后的大小 + 每个文件 2 KB 的 JSON 开销（路径最长 500 字）。 */
export const folderImportBytesFor = (unpackedBytes: number, files: number): number => Math.ceil(unpackedBytes / 3) * 4 + files * 2 * KB;

/** §6.5「shared/constants.ts」：返回全部问题。 */
export function findConstantProblems(c: SharedConstants = SHARED_CONSTANTS): string[] {
  const p: string[] = [];

  // 枚举：非空、无重复、CHECK_TYPES ⊆ JOB_TYPES ⊆ TASK_KINDS
  const enums = { CHECK_TYPES: c.CHECK_TYPES, JOB_TYPES: c.JOB_TYPES, TASK_KINDS: c.TASK_KINDS, JSON_MODES: c.JSON_MODES, ENTRY_KINDS: c.ENTRY_KINDS, THEME_MODES: c.THEME_MODES };
  for (const [name, list] of Object.entries(enums)) {
    if (list.length === 0) p.push(`${name} 不能为空`);
    if (new Set(list).size !== list.length) p.push(`${name} 有重复值`);
    if (list.some((v) => typeof v !== 'string' || v === '')) p.push(`${name} 含空值`);
  }
  for (const v of c.CHECK_TYPES) if (!c.JOB_TYPES.includes(v)) p.push(`CHECK_TYPES 的「${v}」不在 JOB_TYPES 中`);
  for (const v of c.JOB_TYPES) if (!c.TASK_KINDS.includes(v)) p.push(`JOB_TYPES 的「${v}」不在 TASK_KINDS 中`);
  if (c.ENABLED_JOB_TYPES.length === 0) p.push('ENABLED_JOB_TYPES 不能为空');
  if (new Set(c.ENABLED_JOB_TYPES).size !== c.ENABLED_JOB_TYPES.length) p.push('ENABLED_JOB_TYPES 有重复值');
  for (const v of c.ENABLED_JOB_TYPES) if (!c.JOB_TYPES.includes(v)) p.push(`ENABLED_JOB_TYPES 的「${v}」不在 JOB_TYPES 中`);
  // 系统任务与「只能当前章节」的类型：都已启用、互不重叠；系统任务不在作者可发起的 CHECK_TYPES 中
  for (const [name, list] of Object.entries({ AUTO_JOB_TYPES: c.AUTO_JOB_TYPES, CHAPTER_SCOPE_JOB_TYPES: c.CHAPTER_SCOPE_JOB_TYPES })) {
    if (new Set(list).size !== list.length) p.push(`${name} 有重复值`);
    for (const v of list) if (!c.ENABLED_JOB_TYPES.includes(v)) p.push(`${name} 的「${v}」不在 ENABLED_JOB_TYPES 中`);
  }
  for (const v of c.AUTO_JOB_TYPES) {
    if (c.CHECK_TYPES.includes(v)) p.push(`AUTO_JOB_TYPES 的「${v}」不能出现在 CHECK_TYPES 中（作者不能手动发起）`);
    if (c.CHAPTER_SCOPE_JOB_TYPES.includes(v)) p.push(`「${v}」不能同时属于 AUTO_JOB_TYPES 与 CHAPTER_SCOPE_JOB_TYPES`);
  }
  // 创作辅助：正整数；自动更新上限不小于触发阈值；扩写字数区间合法，且最长的扩写放得进默认模型配置的最大输出
  const CL = c.CREATIVE_LIMITS;
  for (const [k, v] of Object.entries(CL)) if (!isPosInt(v)) p.push(`CREATIVE_LIMITS.${k} 必须是正整数：${v}`);
  if ((CL.memoryAutoMaxChars ?? 0) < (CL.memoryThresholdChars ?? 0)) p.push('CREATIVE_LIMITS.memoryAutoMaxChars 不能小于 memoryThresholdChars');
  if (!((CL.expandMinChars ?? 0) <= (CL.expandDefaultChars ?? 0) && (CL.expandDefaultChars ?? 0) <= (CL.expandMaxChars ?? 0))) {
    p.push('CREATIVE_LIMITS 必须满足 expandMinChars ≤ expandDefaultChars ≤ expandMaxChars');
  }
  if (!(c.EXPAND_TOKENS_PER_CHAR > 0)) p.push(`EXPAND_TOKENS_PER_CHAR 必须大于 0：${c.EXPAND_TOKENS_PER_CHAR}`);
  const expandOut = Math.ceil((CL.expandMaxChars ?? 0) * c.EXPAND_TOKENS_PER_CHAR) + 200;
  if (expandOut > c.LLM_PROFILE_DEFAULTS.maxOutputTokens) {
    p.push(`最长扩写约需 ${expandOut} token 输出，超过默认最大输出 ${c.LLM_PROFILE_DEFAULTS.maxOutputTokens}（CREATIVE_LIMITS.expandMaxChars × EXPAND_TOKENS_PER_CHAR + 200）`);
  }
  // 默认模型沿用表：键与值都是 TASK_KINDS，不能沿用自己
  for (const [k, list] of Object.entries(c.LLM_DEFAULT_FALLBACKS)) {
    if (!c.TASK_KINDS.includes(k)) p.push(`LLM_DEFAULT_FALLBACKS 的键「${k}」不在 TASK_KINDS 中`);
    for (const v of list ?? []) {
      if (!c.TASK_KINDS.includes(v)) p.push(`LLM_DEFAULT_FALLBACKS.${k} 的「${v}」不在 TASK_KINDS 中`);
      if (v === k) p.push(`LLM_DEFAULT_FALLBACKS.${k} 不能沿用自己`);
    }
  }
  if (!isPosInt(c.RECAP_CHAPTERS) || c.RECAP_CHAPTERS > 10) p.push(`RECAP_CHAPTERS 必须是 1～10 的整数：${c.RECAP_CHAPTERS}`);
  if (!isPosInt(c.MAX_ISSUES_PER_UNIT)) p.push(`MAX_ISSUES_PER_UNIT 必须是正整数：${c.MAX_ISSUES_PER_UNIT}`);

  if (!Number.isInteger(c.DEFAULT_PORT) || c.DEFAULT_PORT < 1024 || c.DEFAULT_PORT > 65535) {
    p.push(`DEFAULT_PORT 必须是 [1024, 65535] 内的整数（config.json 的 port 约束）：${c.DEFAULT_PORT}`);
  }

  // CHUNK_CHARS：键恰好是 TASK_KINDS，值是 ≥ 2 的整数（splitParagraphChunks 的前提）
  const chunkKeys = Object.keys(c.CHUNK_CHARS);
  for (const k of c.TASK_KINDS) if (!chunkKeys.includes(k)) p.push(`CHUNK_CHARS 缺少「${k}」`);
  for (const k of chunkKeys) if (!c.TASK_KINDS.includes(k)) p.push(`CHUNK_CHARS 有多余的键「${k}」`);
  for (const [k, v] of Object.entries(c.CHUNK_CHARS)) {
    if (!Number.isInteger(v) || v < 2) p.push(`CHUNK_CHARS.${k} 必须是 ≥ 2 的整数：${v}`);
  }

  // LIMITS / BODY_LIMITS / LLM_FIELD_MAX：正整数
  for (const [group, obj] of Object.entries({ LIMITS: c.LIMITS, BODY_LIMITS: c.BODY_LIMITS, LLM_FIELD_MAX: c.LLM_FIELD_MAX })) {
    for (const [k, v] of Object.entries(obj)) if (!isPosInt(v)) p.push(`${group}.${k} 必须是正整数：${v}`);
  }
  const L = c.LIMITS;
  const B = c.BODY_LIMITS;
  if ((L.typoLengthDeltaMax ?? 0) >= (L.typoTargetMaxChars ?? 0)) {
    p.push(`LIMITS.typoLengthDeltaMax（${L.typoLengthDeltaMax}）必须小于 typoTargetMaxChars（${L.typoTargetMaxChars}）`);
  }

  // 请求体上限必须容得下业务层允许的最大内容，否则用户会先撞上 413 而不是友好的业务提示
  const needChapter = utf8JsonBytesFor(L.chapterBodyMaxChars ?? 0);
  if ((B.chapterBody ?? 0) < needChapter) {
    p.push(`BODY_LIMITS.chapterBody（${B.chapterBody}）容不下 ${L.chapterBodyMaxChars} 字的正文，至少需要 ${needChapter}`);
  }
  const needImport = Math.max((L.skillZipMaxBytes ?? 0) + 64 * KB, folderImportBytesFor(L.skillUnpackedMaxBytes ?? 0, L.skillMaxFiles ?? 0));
  if ((B.skillImport ?? 0) < needImport) {
    p.push(`BODY_LIMITS.skillImport（${B.skillImport}）容不下最大的技能包（zip ${L.skillZipMaxBytes} 字节或 base64 编码的文件夹），至少需要 ${needImport}`);
  }
  for (const k of ['chapterBody', 'skillImport']) {
    if ((B[k] ?? 0) < (B.default ?? 0)) p.push(`BODY_LIMITS.${k} 不能小于 BODY_LIMITS.default`);
  }

  // 句末标点：非空、逐码点不重复、不含空白
  const ends = [...c.SENTENCE_END_CHARS];
  if (ends.length === 0) p.push('SENTENCE_END_CHARS 不能为空');
  if (new Set(ends).size !== ends.length) p.push('SENTENCE_END_CHARS 有重复字符');
  if (ends.some((ch) => /\s/u.test(ch))) p.push('SENTENCE_END_CHARS 不能包含空白字符');

  // 模型配置：范围合法、默认值在范围内、默认值满足跨字段规则
  const D = c.LLM_PROFILE_DEFAULTS;
  for (const [k, range] of Object.entries(c.LLM_PROFILE_RANGES)) {
    const [min, max] = range;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) p.push(`LLM_PROFILE_RANGES.${k} 不是合法区间：[${min}, ${max}]`);
    if (k !== 'temperature' && (!Number.isInteger(min) || !Number.isInteger(max))) p.push(`LLM_PROFILE_RANGES.${k} 的上下限必须是整数`);
    const dv = (D as Record<string, unknown>)[k];
    if (typeof dv !== 'number' || dv < min || dv > max) p.push(`LLM_PROFILE_DEFAULTS.${k}（${String(dv)}）不在 LLM_PROFILE_RANGES [${min}, ${max}] 内`);
  }
  for (const k of ['maxConcurrency', 'timeoutMs', 'maxOutputTokens', 'contextTokens', 'temperature']) {
    if (!(k in c.LLM_PROFILE_RANGES)) p.push(`LLM_PROFILE_RANGES 缺少「${k}」`);
  }
  if (!c.JSON_MODES.includes(D.jsonMode)) p.push(`LLM_PROFILE_DEFAULTS.jsonMode「${D.jsonMode}」不属于 JSON_MODES`);
  if (!isPosInt(c.LLM_PROMPT_HEADROOM)) p.push(`LLM_PROMPT_HEADROOM 必须是正整数：${c.LLM_PROMPT_HEADROOM}`);
  if (D.contextTokens < D.maxOutputTokens + c.LLM_PROMPT_HEADROOM) {
    p.push(`LLM_PROFILE_DEFAULTS 不满足 contextTokens ≥ maxOutputTokens + ${c.LLM_PROMPT_HEADROOM}`);
  }
  const ctxMin = c.LLM_PROFILE_RANGES.contextTokens?.[0] ?? 0;
  const outMin = c.LLM_PROFILE_RANGES.maxOutputTokens?.[0] ?? 0;
  if (ctxMin < outMin + c.LLM_PROMPT_HEADROOM) {
    p.push(`LLM_PROFILE_RANGES.contextTokens 的下限（${ctxMin}）必须 ≥ maxOutputTokens 下限 + LLM_PROMPT_HEADROOM（${outMin + c.LLM_PROMPT_HEADROOM}）`);
  }

  // extraBody 保留字段
  if (c.LLM_EXTRA_BODY_RESERVED.length === 0) p.push('LLM_EXTRA_BODY_RESERVED 不能为空');
  if (new Set(c.LLM_EXTRA_BODY_RESERVED).size !== c.LLM_EXTRA_BODY_RESERVED.length) p.push('LLM_EXTRA_BODY_RESERVED 有重复值');
  for (const k of ['model', 'messages', 'stream', 'response_format']) {
    if (!c.LLM_EXTRA_BODY_RESERVED.includes(k)) p.push(`LLM_EXTRA_BODY_RESERVED 必须包含「${k}」`);
  }

  // 重试：非空、正整数、不递减；Retry-After 上限不小于最长退避
  const delays = c.LLM_RETRY_DELAYS_MS;
  if (delays.length === 0) p.push('LLM_RETRY_DELAYS_MS 不能为空');
  delays.forEach((d, i) => {
    if (!isPosInt(d)) p.push(`LLM_RETRY_DELAYS_MS[${i}] 必须是正整数：${d}`);
    if (i > 0 && d < (delays[i - 1] ?? 0)) p.push(`LLM_RETRY_DELAYS_MS 必须不递减（第 ${i} 项 ${d} < ${delays[i - 1]}）`);
  });
  if (!isPosInt(c.LLM_RETRY_AFTER_MAX_MS) || c.LLM_RETRY_AFTER_MAX_MS < Math.max(0, ...delays)) {
    p.push(`LLM_RETRY_AFTER_MAX_MS（${c.LLM_RETRY_AFTER_MAX_MS}）必须是正整数且不小于最长退避间隔`);
  }
  if (!Number.isInteger(c.LLM_TIMEOUT_RETRIES) || c.LLM_TIMEOUT_RETRIES < 0 || c.LLM_TIMEOUT_RETRIES > delays.length) {
    p.push(`LLM_TIMEOUT_RETRIES（${c.LLM_TIMEOUT_RETRIES}）必须是 0～${delays.length}（LLM_RETRY_DELAYS_MS 的长度）之间的整数`);
  }

  // 测试连接的时限：单次请求不短于 10 s，整个探测至少容得下一次请求
  if (!isPosInt(c.LLM_PROBE_REQUEST_TIMEOUT_MS) || c.LLM_PROBE_REQUEST_TIMEOUT_MS < 10_000) {
    p.push(`LLM_PROBE_REQUEST_TIMEOUT_MS（${c.LLM_PROBE_REQUEST_TIMEOUT_MS}）必须是不小于 10000 的整数`);
  }
  if (!isPosInt(c.LLM_PROBE_DEADLINE_MS) || c.LLM_PROBE_DEADLINE_MS < c.LLM_PROBE_REQUEST_TIMEOUT_MS) {
    p.push(`LLM_PROBE_DEADLINE_MS（${c.LLM_PROBE_DEADLINE_MS}）必须是整数且不小于 LLM_PROBE_REQUEST_TIMEOUT_MS`);
  }

  // 提示词预算（§7.4.1）：①②⑥ 不裁剪，最长的块 + 技能规则 + 协议必须放得进默认模型配置的预算
  if (!isPosInt(c.PROMPT_BUDGET_MARGIN_TOKENS)) p.push(`PROMPT_BUDGET_MARGIN_TOKENS 必须是正整数：${c.PROMPT_BUDGET_MARGIN_TOKENS}`);
  if (!isPosInt(c.PROMPT_PROTOCOL_MAX_CHARS)) p.push(`PROMPT_PROTOCOL_MAX_CHARS 必须是正整数：${c.PROMPT_PROTOCOL_MAX_CHARS}`);
  const maxChunk = Math.max(0, ...Object.values(c.CHUNK_CHARS));
  const fixed = maxChunk + (L.skillPromptMaxChars ?? 0) + c.PROMPT_PROTOCOL_MAX_CHARS;
  const budget = D.contextTokens - D.maxOutputTokens - c.PROMPT_BUDGET_MARGIN_TOKENS;
  if (fixed > budget) {
    p.push(
      `提示词不可裁剪部分 ${fixed}（最长分块 ${maxChunk} + skillPromptMaxChars ${L.skillPromptMaxChars} + 协议 ${c.PROMPT_PROTOCOL_MAX_CHARS}）超过默认预算 ${budget}（contextTokens − maxOutputTokens − ${c.PROMPT_BUDGET_MARGIN_TOKENS}）`,
    );
  }
  return p;
}

// ---------------------------------------------------------------------------
// 配置文件：默认值本身必须能通过校验（§6.5「配置文件」）
// ---------------------------------------------------------------------------

export interface ConfigSanitizers {
  app: (raw: unknown) => Sanitized<unknown>;
  llm: (raw: unknown) => Sanitized<unknown>;
  registry: (raw: unknown) => Sanitized<unknown>;
}

const SANITIZERS: ConfigSanitizers = { app: sanitizeAppConfig, llm: sanitizeLlmConfig, registry: sanitizeRegistry };

/** 每个配置文件的默认值（以及用 LLM_PROFILE_DEFAULTS 填出的模型配置）再校验一次必须没有任何修复。 */
export function findConfigDefaultProblems(s: ConfigSanitizers = SANITIZERS, profileDefaults: object = C.LLM_PROFILE_DEFAULTS): string[] {
  const p: string[] = [];
  const selfCheck = (file: string, sanitize: (raw: unknown) => Sanitized<unknown>, raw: unknown): void => {
    const first = sanitize(raw);
    const again = sanitize(JSON.parse(JSON.stringify(first.value)) as unknown).repaired;
    if (again.length > 0) p.push(`${file} 的默认值无法通过自身校验：${again.join(', ')}`);
  };
  selfCheck('config.json', s.app, {});
  selfCheck('llm.json', s.llm, {});
  selfCheck('skills/registry.json', s.registry, {});
  const profile = { id: 'default', name: '默认', baseUrl: 'https://example.invalid/v1', apiKey: '', model: 'm', extraBody: {}, ...profileDefaults };
  const repaired = s.llm({ version: 1, profiles: [profile], defaults: {} }).repaired;
  if (repaired.length > 0) p.push(`用 LLM_PROFILE_DEFAULTS 填出的模型配置无法通过 llm.json 校验：${repaired.join(', ')}`);
  return p;
}

// ---------------------------------------------------------------------------
// shared/schemas/api.ts：严格模式能编译；带 properties 的对象一律禁止额外字段
// ---------------------------------------------------------------------------

function walkObjectsWithoutClosedProps(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkObjectsWithoutClosedProps(v, `${path}[${i}]`, out));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const obj = node as Record<string, unknown>;
  if ('properties' in obj && obj.additionalProperties !== false) out.push(`${path} 声明了 properties 但没有 additionalProperties: false`);
  for (const [k, v] of Object.entries(obj)) walkObjectsWithoutClosedProps(v, `${path}.${k}`, out);
}

export function findSchemaProblems(schemas: Readonly<Record<string, unknown>> = API_SCHEMAS): string[] {
  const p: string[] = [];
  const strict = new Ajv(AJV_OPTIONS);
  for (const [name, schema] of Object.entries(schemas)) {
    try {
      strict.compile(schema as object);
    } catch (err) {
      p.push(`${name} 无法在严格模式下编译：${err instanceof Error ? err.message : String(err)}`);
    }
    walkObjectsWithoutClosedProps(schema, name, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// shared/schemas/outputs.ts：发给模型的 Schema 必须兼容 json_schema strict 模式
// ---------------------------------------------------------------------------

const OUTPUT_SCHEMA_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum']);

function walkOutputSchema(node: unknown, path: string, out: string[]): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    out.push(`${path} 不是 Schema 对象`);
    return;
  }
  const s = node as Record<string, unknown>;
  for (const k of Object.keys(s)) if (!OUTPUT_SCHEMA_KEYWORDS.has(k)) out.push(`${path} 使用了 strict 模式不保证支持的关键字 ${k}`);
  if (!('type' in s)) out.push(`${path} 缺少 type`);
  if ('properties' in s) {
    const props = s.properties as Record<string, unknown>;
    if (s.additionalProperties !== false) out.push(`${path} 缺少 additionalProperties: false`);
    const required = Array.isArray(s.required) ? [...(s.required as string[])].sort() : [];
    if (JSON.stringify(required) !== JSON.stringify(Object.keys(props).sort())) out.push(`${path} 的 required 必须列出全部属性`);
    for (const [k, v] of Object.entries(props)) walkOutputSchema(v, `${path}.${k}`, out);
  }
  if ('items' in s) walkOutputSchema(s.items, `${path}[]`, out);
}

export function findOutputSchemaProblems(schemas: Readonly<Record<string, unknown>> = OUTPUT_SCHEMAS): string[] {
  const p: string[] = [];
  const strict = new Ajv(AJV_OPTIONS);
  for (const [name, schema] of Object.entries(schemas)) {
    try {
      strict.compile(schema as object);
    } catch (err) {
      p.push(`${name} 无法在严格模式下编译：${err instanceof Error ? err.message : String(err)}`);
    }
    walkOutputSchema(schema, name, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// checks/handlers.ts：处理器注册表与 ENABLED_JOB_TYPES 一致，协议放得进预算
// ---------------------------------------------------------------------------

const SCHEMA_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 标题最长时 ⑥ 片段标题的长度（卷名、章名各 100 字，序号取 5 位）。 */
export const MAX_TARGET_HEADER_CHARS = targetHeader({ seq: 99_998, title: '字'.repeat(100) }, { seq: 99_998, title: '字'.repeat(100) }, 99_998, 99_999).length;

export function findHandlerProblems(
  handlers: Readonly<Partial<Record<string, JobHandler>>> = JOB_HANDLERS,
  enabled: readonly string[] = C.ENABLED_JOB_TYPES,
  maxProtocolChars: number = C.PROMPT_PROTOCOL_MAX_CHARS,
): string[] {
  const p: string[] = [];
  const schemas = new Set<unknown>(Object.values(OUTPUT_SCHEMAS));
  for (const type of enabled) {
    const h = handlers[type];
    if (h === undefined) {
      p.push(`ENABLED_JOB_TYPES 中的「${type}」没有处理器`);
      continue;
    }
    if (h.main === undefined) p.push(`「${type}」缺少 main 阶段处理器`);
    if (NEEDS_SUMMARY.has(type as never) && h.summary === undefined) p.push(`「${type}」需要 summary 阶段处理器`);
    if (NEEDS_REDUCE.has(type as never) && h.reduce === undefined) p.push(`「${type}」需要 reduce 阶段处理器`);
  }
  for (const [type, h] of Object.entries(handlers)) {
    if (!enabled.includes(type)) p.push(`「${type}」已有处理器但不在 ENABLED_JOB_TYPES 中`);
    for (const [phase, ph] of Object.entries(h ?? {})) {
      if (ph === undefined) continue;
      const where = `${type}.${phase}`;
      if (!SCHEMA_NAME_RE.test(ph.schemaName)) p.push(`${where} 的 schemaName 不合法：${ph.schemaName}`);
      if (!schemas.has(ph.schema)) p.push(`${where} 的 schema 必须取自 OUTPUT_SCHEMAS`);
      if (!/JSON/.test(ph.protocol)) p.push(`${where} 的协议必须出现「JSON」（json_object 档要求）`);
      const len = ph.protocol.length + MAX_TARGET_HEADER_CHARS;
      if (len > maxProtocolChars) p.push(`${where} 的协议 + 片段标题 ${len} 字，超过 PROMPT_PROTOCOL_MAX_CHARS（${maxProtocolChars}）`);
      if (ph.skill !== 'job' && !ph.skill.startsWith('builtin:')) p.push(`${where} 的固定技能必须是内置技能：${ph.skill}`);
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// checks/fix.ts：AI 修复的协议与 Schema
// ---------------------------------------------------------------------------

export function findFixProblems(
  protocol: string = FIX_PROTOCOL,
  schema: unknown = OUTPUT_SCHEMAS.fix,
  maxProtocolChars: number = C.PROMPT_PROTOCOL_MAX_CHARS,
): string[] {
  const p: string[] = [];
  if (!Object.values(OUTPUT_SCHEMAS).includes(schema as never)) p.push('修复的 schema 必须取自 OUTPUT_SCHEMAS');
  if (!/JSON/.test(protocol)) p.push('FIX_PROTOCOL 必须出现「JSON」（json_object 档要求）');
  if (protocol.length > maxProtocolChars) p.push(`FIX_PROTOCOL ${protocol.length} 字，超过 PROMPT_PROTOCOL_MAX_CHARS（${maxProtocolChars}）`);
  return p;
}

// ---------------------------------------------------------------------------
// 汇总：加载期一次性列出全部问题
// ---------------------------------------------------------------------------

export class StaticDataError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`静态数据不合法（共 ${problems.length} 项），程序无法启动：\n${problems.map((x) => `  - ${x}`).join('\n')}`);
    this.name = 'StaticDataError';
    this.problems = problems;
  }
}

/** 按 §6.5 静态数据表逐项校验，返回带来源前缀的全部问题；某项校验本身出错也记为问题，不中断其余各项。 */
export function findStaticDataProblems(builtinAssets: AssetReader): string[] {
  const checks: [string, () => string[]][] = [
    ['builtin-skills', () => findBuiltinProblems(builtinAssets)],
    ['llm/presets', () => findPresetProblems(LLM_PRESETS)],
    ['storage/migrations', () => findMigrationProblems()],
    ['shared/constants', () => findConstantProblems()],
    ['配置默认值', () => findConfigDefaultProblems()],
    ['shared/schemas/api', () => findSchemaProblems()],
    ['shared/schemas/outputs', () => findOutputSchemaProblems()],
    ['checks/handlers', () => findHandlerProblems()],
    ['checks/fix', () => findFixProblems()],
  ];
  return checks.flatMap(([label, run]) => {
    try {
      return run().map((x) => `[${label}] ${x}`);
    } catch (err) {
      return [`[${label}] 校验时出错：${err instanceof Error ? err.message : String(err)}`];
    }
  });
}

/** 加载期校验（§6.5）：组合根第一步执行，任何一项不合法都抛 StaticDataError，此时尚未打开或写入任何数据文件。 */
export function validateStaticData(builtinAssets: AssetReader): void {
  const problems = findStaticDataProblems(builtinAssets);
  if (problems.length > 0) throw new StaticDataError(problems);
  compileAllApiSchemas();
}
