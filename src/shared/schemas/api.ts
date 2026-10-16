/**
 * API 请求体 JSON Schema（§7.2）。纯数据对象，服务端用 Ajv 编译校验；前端可复用做表单预校验。
 * 所有对象都禁止额外字段（additionalProperties: false），属性名与 shared/types.ts 逐字一致。
 */
import { CREATIVE_LIMITS, ENTRY_KINDS, JOB_TYPES, JSON_MODES, LIMITS, LLM_FIELD_MAX, LLM_PROFILE_RANGES, TASK_KINDS } from '../constants';

const str = { type: 'string' } as const;
const id = { type: 'string', minLength: 1, maxLength: 64 } as const;
const nullableId = { type: ['string', 'null'], minLength: 1, maxLength: 64 } as const;
const title = { type: 'string', minLength: 1, maxLength: 1000 } as const;
const nonNegInt = { type: 'integer', minimum: 0 } as const;
/** SkillHub namespace / slug：会拼进目录名，只允许安全字符（与 skills/hub-client HUB_NAME_RE 一致）。 */
const hubName = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' } as const;

function object(properties: Record<string, object>, required: string[] = [], extra: Record<string, unknown> = {}): object {
  return { type: 'object', properties, required, additionalProperties: false, ...extra };
}

const rangeOf = (key: keyof typeof LLM_PROFILE_RANGES, type: 'integer' | 'number' = 'integer'): object => ({
  type,
  minimum: LLM_PROFILE_RANGES[key][0],
  maximum: LLM_PROFILE_RANGES[key][1],
});

/** 模型配置字段（§6.2 LlmProfileRecord 去掉 id）。apiKey 允许空串：新建时表示无 Key，修改时表示不修改。 */
const llmProfileProps = {
  name: { type: 'string', minLength: 1, maxLength: LLM_FIELD_MAX.name },
  baseUrl: { type: 'string', minLength: 1, maxLength: LLM_FIELD_MAX.baseUrl, pattern: '^\\s*https?://' },
  apiKey: { type: 'string', maxLength: LLM_FIELD_MAX.apiKey },
  model: { type: 'string', minLength: 1, maxLength: LLM_FIELD_MAX.model },
  jsonMode: { enum: [...JSON_MODES] },
  maxConcurrency: rangeOf('maxConcurrency'),
  timeoutMs: rangeOf('timeoutMs'),
  maxOutputTokens: rangeOf('maxOutputTokens'),
  contextTokens: rangeOf('contextTokens'),
  temperature: rangeOf('temperature', 'number'),
  extraBody: { type: 'object' },
};

/** 设定条目字段（§6.3 BibleEntry 去掉 id 与时间戳）。长度上限与 server/bible 的清洗一致。 */
const entryProps = {
  kind: { enum: [...ENTRY_KINDS] },
  name: { type: 'string', minLength: 1, maxLength: 100 },
  aliases: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 100 } },
  summary: { type: 'string', maxLength: 2000 },
  firstChapterId: nullableId,
};

/** 设定事实字段（§6.3 BibleFact 去掉 id、entryId 与时间戳）。 */
const factProps = {
  attribute: { type: 'string', minLength: 1, maxLength: 100 },
  value: { type: 'string', minLength: 1, maxLength: 2000 },
  mutable: { type: 'boolean' },
  chapterId: nullableId,
  quote: { type: 'string', maxLength: 500 },
};

export const API_SCHEMAS = {
  createWork: object({ title, author: str, genre: str, synopsis: str }, ['title']),
  updateWork: object({ title, author: str, genre: str, synopsis: str }, [], { minProperties: 1 }),
  restoreWork: object({ file: { type: 'string', minLength: 1, maxLength: 200 } }, ['file']),
  createVolume: object({ title, afterVolumeId: nullableId }, ['title']),
  renameVolume: object({ title }, ['title']),
  volumeOrder: object({ volumeIds: { type: 'array', items: id, maxItems: 10000 } }, ['volumeIds']),
  createChapter: object({ volumeId: id, title, afterChapterId: nullableId }, ['volumeId', 'title']),
  renameChapter: object({ title }, ['title']),
  saveBody: object({ body: str, baseRev: nonNegInt }, ['body', 'baseRev']),
  moveChapter: object({ volumeId: id, index: nonNegInt }, ['volumeId', 'index']),
  chapterOrder: object({ chapterIds: { type: 'array', items: id, maxItems: 100000 } }, ['chapterIds']),
  empty: object({}),
  restoreRevision: object({ baseRev: nonNegInt }, ['baseRev']),
  trashRef: object({ kind: { enum: ['volume', 'chapter'] }, id }, ['kind', 'id']),
  trashPurge: {
    oneOf: [object({ kind: { enum: ['volume', 'chapter'] }, id }, ['kind', 'id']), object({ all: { const: true } }, ['all'])],
  },
  updateSkill: object(
    { enabled: { type: 'boolean' }, appliesTo: { type: 'array', items: { enum: [...JOB_TYPES] }, minItems: 1, uniqueItems: true } },
    [],
    { minProperties: 1 },
  ),
  importSkillFiles: object(
    {
      files: {
        type: 'array',
        minItems: 1,
        maxItems: LIMITS.skillMaxFiles,
        items: object({ path: { type: 'string', minLength: 1, maxLength: 500 }, contentBase64: str }, ['path', 'contentBase64']),
      },
    },
    ['files'],
  ),
  hubInstall: object({ namespace: hubName, slug: hubName, version: { type: 'string', maxLength: 50 } }, ['namespace', 'slug']),
  createJob: object(
    {
      type: { enum: [...JOB_TYPES] },
      skillId: { type: 'string', minLength: 1, maxLength: 300 },
      scope: object({ kind: { enum: ['work', 'volume', 'chapter'] }, id }, ['kind', 'id']),
      profileId: id,
      onlyChanged: { type: 'boolean' },
      options: object({ targetChars: { type: 'integer', minimum: CREATIVE_LIMITS.expandMinChars, maximum: CREATIVE_LIMITS.expandMaxChars } }),
    },
    ['type', 'scope'],
  ),
  applyExpansion: object({ force: { type: 'boolean' } }),
  issueIds: object({ issueIds: { type: 'array', items: id, minItems: 1, maxItems: 10_000 } }, ['issueIds']),
  createEntry: object(entryProps, ['kind', 'name']),
  updateEntry: object(entryProps, [], { minProperties: 1 }),
  createFact: object(factProps, ['attribute', 'value']),
  updateFact: object(factProps, [], { minProperties: 1 }),
  decideCandidates: object(
    {
      decisions: {
        type: 'array',
        minItems: 1,
        maxItems: 10_000,
        items: object({ id, action: { enum: ['accept', 'reject', 'merge'] }, mergeIntoEntryId: id, payload: { type: 'object' } }, ['id', 'action']),
      },
    },
    ['decisions'],
  ),
  createLlmProfile: object(llmProfileProps, ['name', 'baseUrl', 'model']),
  updateLlmProfile: object(llmProfileProps, [], { minProperties: 1 }),
  llmDefaults: object(Object.fromEntries(TASK_KINDS.map((k) => [k, nullableId])), [...TASK_KINDS]),
} as const;

export type ApiSchemaName = keyof typeof API_SCHEMAS;
