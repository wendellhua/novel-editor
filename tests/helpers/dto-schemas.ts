import type { ValidateFunction } from 'ajv';
import { ajv } from '../../src/server/system/ajv';
import { JOB_TYPES, JSON_MODES, TASK_KINDS } from '../../src/shared/constants';

/**
 * 响应 DTO 的 JSON Schema（测试专用）：required 列出全部字段且禁止额外字段，
 * 用来逐字核对接口响应与 shared/types.ts（§6.3）是否一致，防止属性名漂移（编码铁律 1）。
 */
const S = { type: 'string' } as const;
const N = { type: 'integer' } as const;
const NS = { type: ['string', 'null'] } as const;
const JSON_MODE = { enum: [...JSON_MODES] } as const;
const skillInfoProps = {
  id: S,
  name: S,
  description: S,
  source: { enum: ['builtin', 'skillhub', 'local'] },
  version: S,
  enabled: { type: 'boolean' },
  appliesTo: { type: 'array', items: { enum: [...TASK_KINDS] } },
  installedAt: { type: ['integer', 'null'] },
};
const hubSkillProps = { namespace: S, slug: S, name: S, summary: S, version: S };

function obj(properties: Record<string, object>): object {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

const chapterNode = obj({ id: S, volumeId: S, title: S, seq: N, wordCount: N, updatedAt: N });
const volumeNode = obj({ id: S, title: S, seq: N, chapters: { type: 'array', items: chapterNode } });
const work = obj({ id: S, title: S, author: S, genre: S, synopsis: S, createdAt: N, updatedAt: N });
const revisionMetaProps = {
  id: N,
  chapterId: S,
  rev: N,
  reason: { enum: ['auto', 'manual', 'before_fix', 'before_restore'] },
  wordCount: N,
  createdAt: N,
};

export const DTO_SCHEMAS = {
  WorkSummary: obj({ id: S, title: S, author: S, wordCount: N, chapterCount: N, updatedAt: N }),
  Work: work,
  WorkTree: obj({ work, volumes: { type: 'array', items: volumeNode } }),
  VolumeNode: volumeNode,
  ChapterNode: chapterNode,
  Chapter: obj({ id: S, volumeId: S, title: S, seq: N, body: S, rev: N, wordCount: N, updatedAt: N }),
  SaveBodyResponse: obj({ rev: N, wordCount: N, updatedAt: N }),
  RevisionMeta: obj(revisionMetaProps),
  RevisionDetail: obj({ ...revisionMetaProps, title: S, body: S }),
  TrashList: obj({
    volumes: { type: 'array', items: obj({ id: S, title: S, deletedAt: N }) },
    chapters: { type: 'array', items: obj({ id: S, volumeId: S, title: S, deletedAt: N }) },
  }),
  TrashedWork: obj({ file: S, workId: S, title: S, deletedAt: N }),
  LlmProfile: obj({
    id: S,
    name: S,
    baseUrl: S,
    apiKeyMasked: S,
    model: S,
    jsonMode: JSON_MODE,
    maxConcurrency: N,
    timeoutMs: N,
    maxOutputTokens: N,
    contextTokens: N,
    temperature: { type: 'number' },
    extraBody: { type: 'object' },
  }),
  ProbeResult: obj({ ok: { type: 'boolean' }, latencyMs: N, jsonMode: JSON_MODE, error: NS, hint: NS }),
  LlmProfileStatus: obj({
    state: { enum: ['unknown', 'ok', 'error'] },
    at: { type: ['integer', 'null'] },
    source: { enum: ['test', 'task', null] },
    latencyMs: { type: ['integer', 'null'] },
    error: NS,
    hint: NS,
    active: N,
    waiting: N,
    retrying: N,
  }),
  LlmPreset: obj({ name: S, baseUrl: S, modelHint: S }),
  LlmDefaults: obj(Object.fromEntries(TASK_KINDS.map((k) => [k, NS]))),
  Job: obj({
    id: S,
    type: { enum: [...JOB_TYPES] },
    skillId: S,
    scope: obj({ kind: { enum: ['work', 'volume', 'chapter'] }, id: S }),
    profileId: S,
    onlyChanged: { type: 'boolean' },
    options: { type: 'object', properties: { targetChars: N }, additionalProperties: false },
    status: { enum: ['queued', 'running', 'paused', 'done', 'failed', 'cancelled'] },
    totalUnits: N,
    doneUnits: N,
    failedUnits: N,
    promptTokens: N,
    completionTokens: N,
    error: NS,
    createdAt: N,
    startedAt: { type: ['integer', 'null'] },
    finishedAt: { type: ['integer', 'null'] },
  }),
  JobEstimate: obj({ chapters: N, chars: N, units: N, skippedChapters: N, estimatedInputTokens: N }),
  Issue: obj({
    id: S,
    jobId: S,
    chapterId: S,
    category: { enum: ['typo', 'punctuation', 'grammar', 'review', 'setting', 'character', 'ai_flavor'] },
    severity: { enum: ['error', 'warning', 'info'] },
    excerpt: S,
    target: S,
    start: N,
    end: N,
    replacement: NS,
    message: S,
    evidence: S,
    status: { enum: ['open', 'applied', 'ignored', 'stale'] },
    createdAt: N,
  }),
  BibleEntry: obj({
    id: S,
    kind: { enum: ['character', 'location', 'faction', 'item', 'rule', 'other'] },
    name: S,
    aliases: { type: 'array', items: S },
    summary: S,
    firstChapterId: NS,
    createdAt: N,
    updatedAt: N,
  }),
  BibleFact: obj({ id: S, entryId: S, attribute: S, value: S, mutable: { type: 'boolean' }, chapterId: NS, quote: S, createdAt: N, updatedAt: N }),
  BibleCandidate: obj({
    id: S,
    jobId: S,
    op: { enum: ['new_entry', 'new_fact', 'new_alias'] },
    targetEntryId: NS,
    payload: { type: 'object' },
    chapterId: S,
    quote: S,
    status: { enum: ['pending', 'accepted', 'rejected'] },
    createdAt: N,
  }),
  JobReport: obj({
    overall: NS,
    chapters: { type: 'array', items: obj({ chapterId: S, markdown: S }) },
  }),
  ApplyIssuesResponse: obj({
    applied: { type: 'array', items: S },
    stale: { type: 'array', items: S },
    chapters: { type: 'array', items: obj({ id: S, rev: N }) },
  }),
  Expansion: obj({
    jobId: S,
    chapterId: S,
    text: S,
    status: { enum: ['ready', 'applied'] },
    stale: { type: 'boolean' },
    createdAt: N,
    appliedAt: { type: ['integer', 'null'] },
  }),
  ApplyExpansionResponse: obj({ chapterId: S, rev: N, inserted: S }),
  PlotMemory: obj({
    state: {
      anyOf: [
        { type: 'null' },
        obj({ mainline: S, characters: { type: 'array', items: obj({ name: S, status: S }) }, threads: { type: 'array', items: S }, emotion: S }),
      ],
    },
    entries: { type: 'array', items: obj({ id: S, seq: N, label: S, chars: N, events: { type: 'array', items: S }, createdAt: N }) },
    coveredChars: N,
    pendingChars: N,
    thresholdChars: N,
    autoMaxChars: N,
    updatedAt: { type: ['integer', 'null'] },
    // 非空时另用 Job 校验
    job: { type: ['object', 'null'] },
    hasModel: { type: 'boolean' },
  }),
  SkillInfo: obj(skillInfoProps),
  SkillDetail: obj({
    ...skillInfoProps,
    body: S,
    references: { type: 'array', items: obj({ path: S, size: N }) },
  }),
  HubSkill: obj(hubSkillProps),
  HubSkillDetail: obj({
    ...hubSkillProps,
    securityReports: { type: 'array', items: obj({ provider: S, status: S, statusText: S, reportUrl: S }) },
  }),
  RevConflict: obj({
    error: obj({ code: { const: 'REV_CONFLICT' }, message: S, rev: N, body: S, title: S }),
  }),
  Error: {
    type: 'object',
    properties: { error: { type: 'object', properties: { code: S, message: S }, required: ['code', 'message'] } },
    required: ['error'],
    additionalProperties: false,
  },
  NullableString: NS,
} as const;

const cache = new Map<string, ValidateFunction>();

export function assertDto(name: keyof typeof DTO_SCHEMAS, value: unknown, many = false): void {
  const key = `${name}:${many}`;
  let fn = cache.get(key);
  if (fn === undefined) {
    fn = ajv.compile(many ? { type: 'array', items: DTO_SCHEMAS[name] } : DTO_SCHEMAS[name]);
    cache.set(key, fn);
  }
  if (!fn(value)) {
    throw new Error(`响应不符合 ${name}${many ? '[]' : ''}：${ajv.errorsText(fn.errors)}\n${JSON.stringify(value).slice(0, 500)}`);
  }
}
