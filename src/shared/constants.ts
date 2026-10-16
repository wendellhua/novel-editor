import type { CheckType, EntryKind, JobType, JsonMode, TaskKind, ThemeMode } from './types';

export const APP_NAME = 'NovelEditor';
export const DEFAULT_PORT = 17321;

export const CHECK_TYPES: readonly CheckType[] = ['typo', 'review', 'setting', 'character', 'ai_flavor', 'inspiration', 'expand'];
export const JOB_TYPES: readonly JobType[] = [...CHECK_TYPES, 'bible_extract', 'memory'];
export const TASK_KINDS: readonly TaskKind[] = [...JOB_TYPES, 'summary'];

/**
 * 已经可以创建任务的类型（服务端有对应的单元处理器；§6.5 校验两者一致）。随 T14～T17 逐步扩充；
 * 前端检查面板只列出这些类型，服务端对其余类型返回 400。
 */
export const ENABLED_JOB_TYPES: readonly JobType[] = ['typo', 'review', 'setting', 'character', 'ai_flavor', 'inspiration', 'expand', 'bible_extract', 'memory'];

/** 只由系统创建的任务类型（剧情记忆满字数自动更新）：检查面板不列出，POST W/jobs 返回 400。 */
export const AUTO_JOB_TYPES: readonly JobType[] = ['memory'];

/** 范围只能是「当前章节」的任务类型：灵感胶囊针对当前剧情位置，智能扩写一次只完成当前一章。 */
export const CHAPTER_SCOPE_JOB_TYPES: readonly JobType[] = ['inspiration', 'expand'];

/**
 * 创作辅助的数值约定（ADR-011）：
 * - memoryThresholdChars：尚未纳入剧情记忆的正文满这么多字时自动更新；
 * - memoryAutoMaxChars：尚未纳入的字数超过这个值（如给已有的长篇第一次建立记忆）时不自动更新，由作者手动开始，避免意外的大额用量；
 * - inspirationRoutes：灵感胶囊给出的路线数；
 * - expand*Chars：智能扩写的目标字数范围与默认值（输出必须放得进默认模型配置的最大输出，§6.5 校验）。
 */
export const CREATIVE_LIMITS = {
  memoryThresholdChars: 3000,
  memoryAutoMaxChars: 30_000,
  inspirationRoutes: 5,
  expandMinChars: 500,
  expandDefaultChars: 2000,
  expandMaxChars: 3000,
} as const;

/**
 * 没有单独设置默认模型时，依次沿用哪些任务类型的默认模型（只用于后加的任务类型）：
 * 升级后的旧配置不用逐项设置，剧情记忆也能自动更新。设置页「默认模型」中显示为「同 xx」。
 */
export const LLM_DEFAULT_FALLBACKS: Readonly<Partial<Record<TaskKind, readonly TaskKind[]>>> = {
  ai_flavor: ['review', 'typo'],
  inspiration: ['review'],
  expand: ['review'],
  memory: ['summary', 'review'],
};

/** 扩写输出按每字多少 token 估算（中文在主流模型上约 0.6～1 token/字，取保守值）；JSON 外壳另留 200 token。 */
export const EXPAND_TOKENS_PER_CHAR = 1.2;

/** 一致性检查与审稿的 ④ 前情提要取前几章的摘要（§7.4.1）。 */
export const RECAP_CHAPTERS = 3;

/** 单个单元最多处理模型返回的多少条问题，防止失控输出拖垮写入。 */
export const MAX_ISSUES_PER_UNIT = 200;
export const JSON_MODES: readonly JsonMode[] = ['json_schema', 'json_object', 'prompt'];
export const ENTRY_KINDS: readonly EntryKind[] = ['character', 'location', 'faction', 'item', 'rule', 'other'];
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

/** 各任务类型的分块上限（UTF-16 码元数），见 §6.4。 */
export const CHUNK_CHARS: Readonly<Record<TaskKind, number>> = {
  typo: 2500,
  review: 8000,
  setting: 6000,
  character: 6000,
  ai_flavor: 3000,
  // 灵感胶囊与智能扩写只取当前章节结尾的这么多字作为 ⑥（更早的内容由前情提要与剧情记忆提供）
  inspiration: 6000,
  expand: 8000,
  bible_extract: 8000,
  // 剧情记忆每个批次最多纳入的新正文
  memory: 6000,
  summary: 12000,
};

export const LIMITS = {
  chapterBodyMaxChars: 200_000,
  skillZipMaxBytes: 10 * 1024 * 1024,
  skillUnpackedMaxBytes: 20 * 1024 * 1024,
  skillMaxFiles: 500,
  skillPromptMaxChars: 24_000,
  autoRevisionKeep: 30,
  autoRevisionIntervalMs: 10 * 60 * 1000,
  dailyBackupKeep: 7,
  typoTargetMaxChars: 8,
  typoLengthDeltaMax: 2,
} as const;

/**
 * HTTP 请求体上限（字节），见 §7.1。必须容得下业务层允许的最大内容（§6.5 校验）：
 * chapterBody ≥ 20 万字正文的 UTF-8 JSON；skillImport ≥ 20 MB 文件夹经 base64 编码后的 JSON（约 26.7 MB）。
 */
export const BODY_LIMITS = {
  default: 1024 * 1024,
  chapterBody: 2 * 1024 * 1024,
  skillImport: 28 * 1024 * 1024,
} as const;

/** 句末标点：段落超长时只在这些字符（连续出现时取整段之后）处切分，见 §6.4。 */
export const SENTENCE_END_CHARS = '。！？!?…”」』';

/** 模型配置默认值（§6.2）。配置修复、请求校验与设置表单共用。 */
export const LLM_PROFILE_DEFAULTS = {
  jsonMode: 'json_object',
  maxConcurrency: 3,
  timeoutMs: 180_000,
  maxOutputTokens: 4096,
  contextTokens: 64_000,
  temperature: 0.2,
} as const satisfies { jsonMode: JsonMode; [k: string]: unknown };

/** 模型配置数值字段的取值范围 [min, max]（§6.5「配置文件」）。 */
export const LLM_PROFILE_RANGES = {
  maxConcurrency: [1, 16],
  timeoutMs: [10_000, 600_000],
  maxOutputTokens: [256, 131_072],
  contextTokens: [4096, 2_000_000],
  temperature: [0, 2],
} as const;

/** 模型配置字符串字段的长度上限；extraBody 按 JSON 序列化后的长度计。 */
export const LLM_FIELD_MAX = { name: 100, baseUrl: 500, apiKey: 1000, model: 200, extraBodyJson: 10_000 } as const;

/** 提示词预算至少留出的 token 数：contextTokens ≥ maxOutputTokens + LLM_PROMPT_HEADROOM。 */
export const LLM_PROMPT_HEADROOM = 2000;

/** extraBody 不得覆盖的请求字段（§7.3）：改了会破坏非流式解析或结构化输出档位。 */
export const LLM_EXTRA_BODY_RESERVED = ['model', 'messages', 'stream', 'response_format', 'n'] as const;

/** 可重试错误的退避间隔（§7.3）；次数 = 数组长度。 */
export const LLM_RETRY_DELAYS_MS = [2000, 4000, 8000] as const;

/** Retry-After 最多等待的时长，防止服务端给出过大的值让任务长时间挂起。 */
export const LLM_RETRY_AFTER_MAX_MS = 60_000;

/** 超时最多重试几次：每次超时都要等满 timeoutMs，按 LLM_RETRY_DELAYS_MS 重试 3 次会让任务卡住十几分钟。 */
export const LLM_TIMEOUT_RETRIES = 1;

/** 测试连接（§7.3 能力探测）：单次请求的超时（不超过配置的 timeoutMs）与整个探测的时限。 */
export const LLM_PROBE_REQUEST_TIMEOUT_MS = 60_000;
export const LLM_PROBE_DEADLINE_MS = 120_000;

/** §7.4.1 提示词预算的安全余量（token）：预算 = contextTokens − maxOutputTokens − PROMPT_BUDGET_MARGIN_TOKENS。 */
export const PROMPT_BUDGET_MARGIN_TOKENS = 1000;

/**
 * §7.4.1 ① 编辑器协议 + ⑥ 片段标题的长度上限（字）。①②⑥ 不裁剪，所以 §6.5 要求
 * max(CHUNK_CHARS) + skillPromptMaxChars + 本值 ≤ 默认模型配置的提示词预算（按 1 字 = 1 token，A5）。
 * T13 的协议文本必须不超过本值（由测试断言）。
 */
export const PROMPT_PROTOCOL_MAX_CHARS = 4000;
