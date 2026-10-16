import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listFilesRecursive } from '../../scripts/lib/fs-utils.ts';
import { ROOT } from '../../scripts/lib/project.ts';
import { ALLOWED_URL_PREFIXES, scanDirForExternalUrls } from '../../scripts/lib/url-scan.ts';
import * as SHARED from '../../src/shared/constants';
import { ENABLED_JOB_TYPES, JSON_MODES, LIMITS, TASK_KINDS } from '../../src/shared/constants';
import { startApp } from '../../src/server/app';
import { createAssetReader, type AssetReader } from '../../src/server/assets';
import { LLM_PRESETS, findPresetProblems } from '../../src/server/llm/presets';
import { findBuiltinProblems } from '../../src/server/skills/builtin';
import { HUB_BASE_URL } from '../../src/server/skills/hub-client';
import { sanitizeRegistry } from '../../src/server/skills/registry';
import {
  MAX_TARGET_HEADER_CHARS,
  SHARED_CONSTANTS,
  StaticDataError,
  findConfigDefaultProblems,
  findConstantProblems,
  findFixProblems,
  findHandlerProblems,
  findOutputSchemaProblems,
  findSchemaProblems,
  findStaticDataProblems,
  validateStaticData,
} from '../../src/server/static-data';
import { OUTPUT_SCHEMAS } from '../../src/shared/schemas/outputs';
import { JOB_HANDLERS } from '../../src/server/checks/handlers';
import { FIX_PROTOCOL } from '../../src/server/checks/protocol';
import { MIGRATIONS, SCHEMA_VERSION, findMigrationProblems, type Migration } from '../../src/server/storage/migrations';
import { loadJsonConfig, sanitizeAppConfig, sanitizeLlmConfig } from '../../src/server/system/config';
import { createSilentLogger } from '../../src/server/system/logger';
import { dataPaths, ensureDataDirs } from '../../src/server/system/paths';
import { makeTempDir } from '../helpers/tmp';

const tmp = makeTempDir('ne-static-');
afterAll(() => tmp.cleanup());

/** 记录每个 describe 覆盖了 §6.5 静态数据表的哪一行，最后与文档逐行核对。 */
const covered = new Set<string>();
function row(name: string, fn: () => void): void {
  covered.add(name);
  describe(`§6.5 静态数据：${name}`, fn);
}

const clone = <T>(v: T): T => structuredClone(v);
const DELETE = Symbol('delete');

/** 按 'A.b.c' 路径修改深拷贝中的一个值；DELETE 表示删除该键。 */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let obj = target;
  for (const k of keys.slice(0, -1)) obj = obj[k] as Record<string, unknown>;
  const last = keys.at(-1) ?? '';
  if (value === DELETE) delete obj[last];
  else obj[last] = value;
}

function memoryAssets(files: Record<string, string>): AssetReader {
  return {
    mode: 'disk',
    read: (p) => (Object.hasOwn(files, p) ? Buffer.from(files[p] ?? '', 'utf8') : null),
    list: (prefix) => Object.keys(files).filter((k) => k.startsWith(prefix)).sort(),
  };
}

function realBuiltinFiles(): Record<string, string> {
  const dir = join(ROOT, 'builtin-skills');
  return Object.fromEntries(listFilesRecursive(dir).map((rel) => [`builtin-skills/${rel}`, readFileSync(join(dir, ...rel.split('/')), 'utf8')]));
}

// ===========================================================================

row('builtin-skills/manifest.json', () => {
  it('仓库中的内置技能全部合法；每个规则段都不会被截断', () => {
    expect(findBuiltinProblems(createAssetReader(ROOT))).toEqual([]);
    expect(findBuiltinProblems(memoryAssets(realBuiltinFiles())), '内存副本与磁盘一致').toEqual([]);
  });

  const M = 'builtin-skills/manifest.json';
  const S = 'builtin-skills/chapter-summary/SKILL.md';
  const cases: [string, (f: Record<string, string>) => void, RegExp][] = [
    ['缺少 manifest.json', (f) => delete f[M], /缺少 builtin-skills\/manifest\.json/],
    ['manifest 不是 JSON', (f) => (f[M] = '[{'), /不是合法 JSON/],
    ['少一种 TaskKind', (f) => (f[M] = JSON.stringify((JSON.parse(f[M] ?? '[]') as unknown[]).slice(0, 5))), /「summary」应恰好有 1 个内置技能/],
    ['jobType 写错', (f) => (f[M] = (f[M] ?? '').replace('"summary"', '"summery"')), /不属于 TaskKind/],
    ['SKILL.md 缺失', (f) => delete f[S], /缺少 builtin-skills\/chapter-summary\/SKILL\.md/],
    ['SKILL.md 缺 name', (f) => (f[S] = (f[S] ?? '').replace(/^name:.*$/m, '')), /缺少 name/],
    ['正文超过 skillPromptMaxChars', (f) => (f[S] = `${f[S] ?? ''}\n${'字'.repeat(LIMITS.skillPromptMaxChars)}`), /会被截断/],
    ['references 超过 skillPromptMaxChars', (f) => (f['builtin-skills/chapter-summary/references/big.md'] = '字'.repeat(LIMITS.skillPromptMaxChars)), /会被截断/],
  ];
  it.each(cases)('故意改坏：%s → 被发现', (_label, corrupt, re) => {
    const files = realBuiltinFiles();
    corrupt(files);
    expect(findBuiltinProblems(memoryAssets(files)).join('\n')).toMatch(re);
  });
});

row('skills/registry.json', () => {
  const record = {
    id: 'local:a-123456',
    source: 'local',
    dir: 'local__a-123456',
    name: 'A',
    description: '',
    version: '1.0.0',
    enabled: true,
    appliesTo: ['review'],
    hub: null,
    installedAt: 1,
  };

  it('默认值能通过自身校验；合法记录原样保留', () => {
    const def = sanitizeRegistry({}).value;
    expect(sanitizeRegistry(def).repaired).toEqual([]);
    const hubRecord = { ...record, id: 'hub:ns/slug', source: 'skillhub', dir: 'ns__slug', hub: { namespace: 'ns', slug: 'slug' } };
    expect(sanitizeRegistry({ version: 1, skills: [record, hubRecord] })).toEqual({ value: { version: 1, skills: [record, hubRecord] }, repaired: [] });
  });

  const bad: [string, Record<string, unknown>][] = [
    ['dir 含 ..', { dir: '../escape' }],
    ['dir 含反斜杠', { dir: 'local__a\\b' }],
    ['dir 不是 {ns}__{slug}', { dir: 'local-a' }],
    ['source 非法', { source: 'builtin' }],
    ['冒充内置技能', { id: 'builtin:typo-check' }],
    ['appliesTo 为空', { appliesTo: [] }],
    ['appliesTo 含 summary', { appliesTo: ['summary'] }],
    ['appliesTo 重复', { appliesTo: ['review', 'review'] }],
    ['enabled 不是布尔', { enabled: 'yes' }],
    ['installedAt 为负', { installedAt: -1 }],
    ['hub 缺 slug', { hub: { namespace: 'ns' } }],
    ['name 为空', { name: '' }],
    ['多余字段', { extra: 1 }],
    ['缺少字段', { name: DELETE }],
  ];
  it.each(bad)('故意改坏：%s → 整条丢弃并记入修复', (_label, patch) => {
    const r = clone(record) as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) setPath(r, k, v);
    expect(sanitizeRegistry({ version: 1, skills: [r] })).toEqual({ value: { version: 1, skills: [] }, repaired: ['skills[0]'] });
  });

  it('id 或目录重复时保留第一条；version 不对记入修复', () => {
    const r = sanitizeRegistry({ version: 2, skills: [record, { ...record, dir: 'local__b' }, { ...record, id: 'local:c' }] });
    expect(r.value.skills).toEqual([record]);
    expect(r.repaired).toEqual(['version', 'skills[1]', 'skills[2]']);
  });

  it('有修复时先备份原文件，再写回修复后的内容', () => {
    const dir = join(tmp.dir, 'registry');
    mkdirSync(dir);
    const file = join(dir, 'registry.json');
    writeFileSync(file, JSON.stringify({ version: 1, skills: [record, { ...record, id: 'local:x', dir: '../x' }] }));
    const value = loadJsonConfig(file, sanitizeRegistry, createSilentLogger(), '技能注册表');
    expect(value.skills).toEqual([record]);
    expect(readdirSync(dir).some((n) => n.startsWith('registry.json.broken-'))).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(value);
  });
});

row('llm/presets.ts', () => {
  it('内置预设全部合法', () => {
    expect(findPresetProblems(LLM_PRESETS)).toEqual([]);
  });

  const ok = { name: 'OK', baseUrl: 'https://api.example.com/v1', modelHint: 'm' };
  it.each([
    ['非本机 http', { baseUrl: 'http://api.example.com/v1' }],
    ['冒充本机的域名', { baseUrl: 'http://localhost.evil.com/v1' }],
    ['内网 http', { baseUrl: 'http://192.168.1.2:8000/v1' }],
    ['末尾带 /', { baseUrl: 'https://api.example.com/v1/' }],
    ['name 为空', { name: '  ' }],
    ['modelHint 为空', { modelHint: '' }],
  ])('故意改坏：%s → 恰好 1 个问题', (_label, patch) => {
    expect(findPresetProblems([{ ...ok, ...patch }])).toHaveLength(1);
  });

  it('name 重复 → 被发现；本机 http（带端口、路径）合法', () => {
    expect(findPresetProblems([ok, { ...ok }]).join()).toMatch(/name 重复/);
    for (const baseUrl of ['http://127.0.0.1:11434/v1', 'http://localhost:1234', 'http://localhost']) {
      expect(findPresetProblems([{ ...ok, baseUrl }]), baseUrl).toEqual([]);
    }
  });
});

row('storage/migrations', () => {
  const m = (version: number, extra: Partial<Migration> = {}): Migration => ({ version, name: `m${version}`, up: () => undefined, ...extra });

  it('内置迁移列表合法，最新版本等于 SCHEMA_VERSION', () => {
    expect(findMigrationProblems()).toEqual([]);
    expect(MIGRATIONS.at(-1)?.version).toBe(SCHEMA_VERSION);
  });

  it.each([
    ['版本号跳号', [m(1), m(3)], 3, /连续递增/],
    ['不从 1 开始', [m(2)], 2, /连续递增/],
    ['最新版本与 SCHEMA_VERSION 不符', [m(1), m(2)], 3, /不一致/],
    ['重复版本号', [m(1), m(1)], 1, /连续递增/],
    ['name 为空', [m(1, { name: ' ' })], 1, /缺少 name/],
    ['缺少 up()', [m(1, { up: undefined as unknown as Migration['up'] })], 1, /缺少 up/],
    ['SCHEMA_VERSION 为 0', [], 0, /SCHEMA_VERSION 必须是 ≥ 1/],
  ] as const)('故意改坏：%s → 被发现', (_label, list, latest, re) => {
    expect(findMigrationProblems(list, latest).join('\n')).toMatch(re);
  });
});

row('shared/constants.ts', () => {
  it('当前全部共享常量合法', () => {
    expect(findConstantProblems().join('\n')).toBe('');
  });

  it('SHARED_CONSTANTS 登记了 shared/constants.ts 的每一个导出（新增常量必须纳入校验）', () => {
    const exported = Object.keys(SHARED).filter((k) => k !== 'APP_NAME').sort();
    expect(Object.keys(SHARED_CONSTANTS).sort()).toEqual(exported);
    expect(SHARED.APP_NAME, 'APP_NAME 用作数据目录名，只允许字母数字').toMatch(/^[A-Za-z0-9]+$/);
  });

  const MB = 1024 * 1024;
  const cases: [string, unknown, RegExp][] = [
    ['DEFAULT_PORT', 80, /DEFAULT_PORT/],
    ['CHECK_TYPES', ['typo', 'typo', 'review', 'setting', 'character'], /CHECK_TYPES 有重复值/],
    ['JOB_TYPES', ['typo', 'setting', 'character', 'bible_extract'], /CHECK_TYPES 的「review」不在 JOB_TYPES/],
    ['TASK_KINDS', ['typo', 'review', 'setting', 'character', 'summary'], /JOB_TYPES 的「bible_extract」不在 TASK_KINDS/],
    ['JSON_MODES', [], /JSON_MODES 不能为空/],
    ['ENTRY_KINDS', ['character', 'character'], /ENTRY_KINDS 有重复值/],
    ['THEME_MODES', ['light', ''], /THEME_MODES 含空值/],
    ['CHUNK_CHARS.typo', 0, /CHUNK_CHARS\.typo 必须是 ≥ 2 的整数/],
    ['CHUNK_CHARS.review', 1.5, /CHUNK_CHARS\.review 必须是 ≥ 2 的整数/],
    ['CHUNK_CHARS.summary', DELETE, /CHUNK_CHARS 缺少「summary」/],
    ['CHUNK_CHARS.outline', 100, /多余的键「outline」/],
    ['CHUNK_CHARS.summary', 60_000, /超过默认预算/],
    ['LIMITS.skillMaxFiles', 0, /LIMITS\.skillMaxFiles 必须是正整数/],
    ['LIMITS.autoRevisionKeep', -1, /LIMITS\.autoRevisionKeep 必须是正整数/],
    ['LIMITS.dailyBackupKeep', 2.5, /LIMITS\.dailyBackupKeep 必须是正整数/],
    ['LIMITS.typoLengthDeltaMax', 8, /typoLengthDeltaMax/],
    ['LIMITS.skillPromptMaxChars', 60_000, /超过默认预算/],
    ['LIMITS.chapterBodyMaxChars', 1_000_000, /容不下 1000000 字的正文/],
    ['LIMITS.skillUnpackedMaxBytes', 40 * MB, /skillImport.*容不下最大的技能包/],
    ['LIMITS.skillZipMaxBytes', 30 * MB, /skillImport.*容不下最大的技能包/],
    ['BODY_LIMITS.chapterBody', 512 * 1024, /BODY_LIMITS\.chapterBody/],
    ['BODY_LIMITS.skillImport', 10 * MB, /BODY_LIMITS\.skillImport/],
    ['BODY_LIMITS.default', 64 * MB, /不能小于 BODY_LIMITS\.default/],
    ['SENTENCE_END_CHARS', '', /SENTENCE_END_CHARS 不能为空/],
    ['SENTENCE_END_CHARS', '。。！', /SENTENCE_END_CHARS 有重复字符/],
    ['SENTENCE_END_CHARS', '。 ！', /SENTENCE_END_CHARS 不能包含空白/],
    ['LLM_PROFILE_DEFAULTS.maxConcurrency', 32, /LLM_PROFILE_DEFAULTS\.maxConcurrency（32）不在/],
    ['LLM_PROFILE_DEFAULTS.jsonMode', 'xml', /jsonMode「xml」不属于 JSON_MODES/],
    ['LLM_PROFILE_DEFAULTS.contextTokens', 5000, /contextTokens ≥ maxOutputTokens/],
    ['LLM_PROFILE_DEFAULTS.maxOutputTokens', 60_000, /超过默认预算|contextTokens ≥ maxOutputTokens/],
    ['LLM_PROFILE_RANGES.temperature', [2, 0], /temperature 不是合法区间/],
    ['LLM_PROFILE_RANGES.timeoutMs', [10_000.5, 600_000], /timeoutMs 的上下限必须是整数/],
    ['LLM_PROFILE_RANGES.contextTokens', [1000, 2_000_000], /contextTokens 的下限/],
    ['LLM_PROFILE_RANGES.maxConcurrency', DELETE, /缺少「maxConcurrency」/],
    ['LLM_FIELD_MAX.apiKey', 0, /LLM_FIELD_MAX\.apiKey 必须是正整数/],
    ['LLM_PROMPT_HEADROOM', 0, /LLM_PROMPT_HEADROOM 必须是正整数/],
    ['LLM_EXTRA_BODY_RESERVED', ['messages', 'stream', 'response_format'], /必须包含「model」/],
    ['LLM_EXTRA_BODY_RESERVED', ['model', 'model', 'messages', 'stream', 'response_format'], /LLM_EXTRA_BODY_RESERVED 有重复值/],
    ['LLM_RETRY_DELAYS_MS', [], /LLM_RETRY_DELAYS_MS 不能为空/],
    ['LLM_RETRY_DELAYS_MS', [4000, 2000], /必须不递减/],
    ['LLM_RETRY_DELAYS_MS', [0, 2000], /LLM_RETRY_DELAYS_MS\[0\] 必须是正整数/],
    ['LLM_RETRY_AFTER_MAX_MS', 1000, /LLM_RETRY_AFTER_MAX_MS/],
    ['LLM_TIMEOUT_RETRIES', 4, /LLM_TIMEOUT_RETRIES（4）必须是 0～3/],
    ['LLM_TIMEOUT_RETRIES', -1, /LLM_TIMEOUT_RETRIES/],
    ['LLM_PROBE_REQUEST_TIMEOUT_MS', 5000, /LLM_PROBE_REQUEST_TIMEOUT_MS（5000）必须是不小于 10000/],
    ['LLM_PROBE_DEADLINE_MS', 30_000, /LLM_PROBE_DEADLINE_MS（30000）必须是整数且不小于/],
    ['PROMPT_BUDGET_MARGIN_TOKENS', 0, /PROMPT_BUDGET_MARGIN_TOKENS 必须是正整数/],
    ['PROMPT_PROTOCOL_MAX_CHARS', 30_000, /超过默认预算/],
    ['ENABLED_JOB_TYPES', [], /ENABLED_JOB_TYPES 不能为空/],
    ['ENABLED_JOB_TYPES', ['typo', 'typo'], /ENABLED_JOB_TYPES 有重复值/],
    ['ENABLED_JOB_TYPES', ['summary'], /ENABLED_JOB_TYPES 的「summary」不在 JOB_TYPES/],
    ['AUTO_JOB_TYPES', ['memory', 'memory'], /AUTO_JOB_TYPES 有重复值/],
    ['AUTO_JOB_TYPES', ['typo'], /AUTO_JOB_TYPES 的「typo」不能出现在 CHECK_TYPES 中/],
    ['AUTO_JOB_TYPES', ['outline'], /AUTO_JOB_TYPES 的「outline」不在 ENABLED_JOB_TYPES 中/],
    ['CHAPTER_SCOPE_JOB_TYPES', ['expand', 'memory'], /不能同时属于 AUTO_JOB_TYPES 与 CHAPTER_SCOPE_JOB_TYPES/],
    ['CHAPTER_SCOPE_JOB_TYPES', ['outline'], /CHAPTER_SCOPE_JOB_TYPES 的「outline」不在 ENABLED_JOB_TYPES 中/],
    ['CREATIVE_LIMITS.memoryThresholdChars', 0, /CREATIVE_LIMITS\.memoryThresholdChars 必须是正整数/],
    ['CREATIVE_LIMITS.memoryAutoMaxChars', 1000, /memoryAutoMaxChars 不能小于 memoryThresholdChars/],
    ['CREATIVE_LIMITS.expandDefaultChars', 5000, /expandMinChars ≤ expandDefaultChars ≤ expandMaxChars/],
    ['CREATIVE_LIMITS.expandMaxChars', 4000, /最长扩写约需 \d+ token 输出，超过默认最大输出/],
    ['EXPAND_TOKENS_PER_CHAR', 0, /EXPAND_TOKENS_PER_CHAR 必须大于 0/],
    ['EXPAND_TOKENS_PER_CHAR', 3, /最长扩写约需/],
    ['LLM_DEFAULT_FALLBACKS.outline', ['review'], /LLM_DEFAULT_FALLBACKS 的键「outline」不在 TASK_KINDS 中/],
    ['LLM_DEFAULT_FALLBACKS.memory', ['memory'], /LLM_DEFAULT_FALLBACKS\.memory 不能沿用自己/],
    ['LLM_DEFAULT_FALLBACKS.expand', ['outline'], /LLM_DEFAULT_FALLBACKS\.expand 的「outline」不在 TASK_KINDS 中/],
    ['RECAP_CHAPTERS', 0, /RECAP_CHAPTERS 必须是 1～10 的整数/],
    ['RECAP_CHAPTERS', 50, /RECAP_CHAPTERS 必须是 1～10 的整数/],
    ['MAX_ISSUES_PER_UNIT', -1, /MAX_ISSUES_PER_UNIT 必须是正整数/],
  ];

  it.each(cases)('故意改坏：%s = %j → 被发现', (path, value, re) => {
    const c = clone(SHARED_CONSTANTS) as unknown as Record<string, unknown>;
    setPath(c, path, value);
    expect(findConstantProblems(c as unknown as typeof SHARED_CONSTANTS).join('\n')).toMatch(re);
  });

  it('每一个共享常量都至少有一个「改坏」用例', () => {
    const touched = new Set(cases.map(([path]) => path.split('.')[0]));
    expect(Object.keys(SHARED_CONSTANTS).filter((k) => !touched.has(k))).toEqual([]);
  });
});

row('shared/schemas/api.ts', () => {
  it('全部请求 Schema 能在 Ajv 严格模式下编译，带 properties 的对象一律禁止额外字段', () => {
    expect(findSchemaProblems()).toEqual([]);
  });

  const closed = (properties: object, extra: object = {}): object => ({ type: 'object', properties, additionalProperties: false, ...extra });
  it.each([
    ['缺少 additionalProperties: false', { type: 'object', properties: { a: { type: 'string' } } }, /x 声明了 properties 但没有 additionalProperties/],
    ['嵌套对象漏写', closed({ files: { type: 'array', items: { type: 'object', properties: { p: { type: 'string' } } } } }), /x\.properties\.files\.items 声明了 properties/],
    ['关键字拼错', closed({ a: { type: 'string', minLenght: 1 } }), /严格模式/],
    ['类型拼错', closed({ a: { type: 'strng' } }), /严格模式/],
    ['required 中有未声明的属性', closed({ a: { type: 'string' } }, { required: ['b'] }), /严格模式/],
  ])('故意改坏：%s → 被发现', (_label, schema, re) => {
    expect(findSchemaProblems({ x: schema }).join('\n')).toMatch(re);
  });

  it('不带 properties 的自由对象（如 extraBody）允许任意字段', () => {
    expect(findSchemaProblems({ x: closed({ extraBody: { type: 'object' } }) })).toEqual([]);
  });
});

row('shared/schemas/outputs.ts', () => {
  it('全部模型输出 Schema 能严格编译，且兼容 json_schema strict 模式（对象封闭、required 列全、只用基础关键字）', () => {
    expect(findOutputSchemaProblems().join('\n')).toBe('');
    expect(Object.keys(OUTPUT_SCHEMAS).sort()).toEqual(['ai_flavor', 'consistency', 'expand', 'extract', 'fix', 'inspiration', 'memory', 'review', 'review_reduce', 'summary', 'typo']);
  });

  const leaf = { type: 'string' };
  const closed = (properties: Record<string, object>, extra: object = {}): object => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
    ...extra,
  });
  it.each([
    ['漏写 additionalProperties', { type: 'object', properties: { a: leaf }, required: ['a'] }, /缺少 additionalProperties/],
    ['required 没有列全', { type: 'object', properties: { a: leaf, b: leaf }, required: ['a'], additionalProperties: false }, /required 必须列出全部属性/],
    ['嵌套对象没有封闭', closed({ list: { type: 'array', items: { type: 'object', properties: { a: leaf }, required: ['a'] } } }), /x\.list\[\] 缺少 additionalProperties/],
    ['使用 maxLength', closed({ a: { type: 'string', maxLength: 10 } }), /关键字 maxLength/],
    ['缺少 type', closed({ a: { enum: ['x'] } }), /x\.a 缺少 type/],
    ['类型拼错', closed({ a: { type: 'strng' } }), /严格模式/],
  ])('故意改坏：%s → 被发现', (_label, schema, re) => {
    expect(findOutputSchemaProblems({ x: schema }).join('\n')).toMatch(re);
  });
});

row('checks/handlers.ts', () => {
  it('处理器注册表与 ENABLED_JOB_TYPES 一致；每段协议加最长片段标题不超过 PROMPT_PROTOCOL_MAX_CHARS', () => {
    expect(findHandlerProblems().join('\n')).toBe('');
    expect(Object.keys(JOB_HANDLERS).sort()).toEqual([...ENABLED_JOB_TYPES].sort());
    expect(MAX_TARGET_HEADER_CHARS).toBeGreaterThan(200);
    for (const h of Object.values(JOB_HANDLERS)) {
      for (const ph of Object.values(h ?? {})) expect(ph.protocol.length + MAX_TARGET_HEADER_CHARS).toBeLessThanOrEqual(SHARED.PROMPT_PROTOCOL_MAX_CHARS);
    }
  });

  const typo = JOB_HANDLERS.typo ?? {};
  const main = typo.main as NonNullable<typeof typo.main>;
  it.each([
    ['启用了没有处理器的类型', {}, ['typo'], /「typo」没有处理器/],
    ['有处理器但未启用', { typo }, ['review'], /已有处理器但不在 ENABLED_JOB_TYPES/],
    ['缺少 main 阶段', { typo: {} }, ['typo'], /缺少 main 阶段/],
    ['审稿缺少 summary / reduce 阶段', { review: { main } }, ['review'], /需要 summary 阶段[\s\S]*需要 reduce 阶段/],
    ['schemaName 不合法', { typo: { main: { ...main, schemaName: 'a b' } } }, ['typo'], /schemaName 不合法/],
    ['schema 不是 OUTPUT_SCHEMAS 中的', { typo: { main: { ...main, schema: { type: 'object' } } } }, ['typo'], /必须取自 OUTPUT_SCHEMAS/],
    ['协议没有出现 JSON', { typo: { main: { ...main, protocol: '只输出对象' } } }, ['typo'], /必须出现「JSON」/],
    ['协议过长', { typo: { main: { ...main, protocol: `JSON${'字'.repeat(4000)}` } } }, ['typo'], /超过 PROMPT_PROTOCOL_MAX_CHARS/],
    ['固定技能不是内置技能', { typo: { main: { ...main, skill: 'local:x' } } }, ['typo'], /固定技能必须是内置技能/],
  ] as const)('故意改坏：%s → 被发现', (_label, handlers, enabled, re) => {
    expect(findHandlerProblems(handlers as never, enabled).join('\n')).toMatch(re);
  });
});

row('checks/fix.ts', () => {
  it('修复协议出现「JSON」、不超过 PROMPT_PROTOCOL_MAX_CHARS，Schema 取自 OUTPUT_SCHEMAS', () => {
    expect(findFixProblems()).toEqual([]);
  });

  it.each([
    ['协议没有出现 JSON', ['只输出对象'], /必须出现「JSON」/],
    ['协议过长', [`JSON${'字'.repeat(4000)}`], /超过 PROMPT_PROTOCOL_MAX_CHARS/],
    ['schema 不是 OUTPUT_SCHEMAS 中的', [FIX_PROTOCOL, { type: 'object' }], /必须取自 OUTPUT_SCHEMAS/],
  ] as const)('故意改坏：%s → 被发现', (_label, args, re) => {
    expect(findFixProblems(...(args as unknown as [string, unknown])).join('\n')).toMatch(re);
  });
});

row('配置文件', () => {
  it('每个配置文件的默认值、以及用 LLM_PROFILE_DEFAULTS 填出的模型配置都能通过自身校验', () => {
    expect(findConfigDefaultProblems()).toEqual([]);
  });

  it('故意改坏默认值 → 被发现', () => {
    const brokenApp = (raw: unknown) => {
      const r = sanitizeAppConfig(raw);
      return JSON.stringify(raw) === '{}' ? { value: { ...r.value, port: 80 }, repaired: r.repaired } : r;
    };
    const s = { app: brokenApp, llm: sanitizeLlmConfig, registry: sanitizeRegistry };
    expect(findConfigDefaultProblems(s).join('\n')).toMatch(/config\.json 的默认值无法通过自身校验：port/);
    expect(findConfigDefaultProblems(undefined, { ...SHARED.LLM_PROFILE_DEFAULTS, maxConcurrency: 99 }).join('\n')).toMatch(/LLM_PROFILE_DEFAULTS.*maxConcurrency/);
  });

  // ---------- config.json：逐字段遍历 ----------
  const appCases: [string, unknown[], unknown[]][] = [
    ['port', [1023, 65536, 3.5, '17321', null], [1024, 65535]],
    ['authSecret', ['abc', 'A'.repeat(64), 'g'.repeat(64), '0'.repeat(63)], ['0'.repeat(64), 'af'.repeat(32)]],
    ['hubClientId', ['not-a-uuid', randomUUID().toUpperCase(), ''], [randomUUID()]],
    ['ui.fontSize', [11, 33, 18.5, '18'], [12, 32]],
    ['ui.theme', ['blue', '', null], ['light', 'dark', 'system']],
  ];
  it.each(appCases)('config.json：%s 的非法值被重置、合法边界值保留', (path, bads, goods) => {
    const base = sanitizeAppConfig({}).value;
    const read = (v: unknown): unknown => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], v);
    for (const bad of bads) {
      const raw = clone(base) as unknown as Record<string, unknown>;
      setPath(raw, path, bad);
      const r = sanitizeAppConfig(raw);
      expect(r.repaired, `${path} = ${JSON.stringify(bad)}`).toEqual([path]);
      expect(read(r.value)).not.toEqual(bad);
      expect(sanitizeAppConfig(r.value).repaired, '修复后的值能通过校验').toEqual([]);
    }
    for (const good of goods) {
      const raw = clone(base) as unknown as Record<string, unknown>;
      setPath(raw, path, good);
      const r = sanitizeAppConfig(raw);
      expect(r.repaired, `${path} = ${JSON.stringify(good)}`).toEqual([]);
      expect(read(r.value)).toEqual(good);
    }
  });

  // ---------- llm.json：逐字段遍历 ----------
  const profile = {
    id: 'p1',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-abcdefghijklmn',
    model: 'deepseek-chat',
    ...SHARED.LLM_PROFILE_DEFAULTS,
    extraBody: {},
  };
  const profileCases: [string, unknown[], unknown[]][] = [
    ['name', ['', 'x'.repeat(101), 5], ['a', 'x'.repeat(100)]],
    ['baseUrl', ['ftp://x', 'api.deepseek.com', 'x'.repeat(10), `https://${'x'.repeat(500)}`], ['', 'http://127.0.0.1:1234/v1', 'https://api.deepseek.com']],
    ['apiKey', ['x'.repeat(1001), 3], ['', 'sk-x']],
    ['model', ['x'.repeat(201), null], ['', 'deepseek-chat']],
    ['jsonMode', ['xml', ''], [...JSON_MODES]],
    ['maxConcurrency', [0, 17, 2.5], [1, 16]],
    ['timeoutMs', [9999, 600_001], [10_000, 600_000]],
    ['maxOutputTokens', [255, 131_073, 1000.5], [256, 8192]],
    ['contextTokens', [4095, 2_000_001], [64_000, 2_000_000]],
    ['temperature', [-0.1, 2.1, '0.2'], [0, 2, 1.5]],
    ['extraBody', [[], 'x', null], [{}, { max_tokens: null, max_completion_tokens: 4096 }]],
  ];
  it.each(profileCases)('llm.json：%s 的非法值被重置、合法边界值保留', (field, bads, goods) => {
    for (const bad of bads) {
      const r = sanitizeLlmConfig({ version: 1, profiles: [{ ...profile, [field]: bad }], defaults: {} });
      expect(r.repaired, `${field} = ${JSON.stringify(bad)}`).toEqual([`profiles[0].${field}`]);
      expect((r.value.profiles[0] as unknown as Record<string, unknown>)[field]).not.toEqual(bad);
      const other = field === 'model' ? 'name' : 'model';
      expect(r.value.profiles[0]?.[other], '其余字段保留').toBe(profile[other]);
    }
    for (const good of goods) {
      const r = sanitizeLlmConfig({ version: 1, profiles: [{ ...profile, [field]: good }], defaults: {} });
      expect(r.repaired, `${field} = ${JSON.stringify(good)}`).toEqual([]);
      expect((r.value.profiles[0] as unknown as Record<string, unknown>)[field]).toEqual(good);
    }
  });

  it('llm.json：id 缺失或越界整条丢弃，重复 id 保留第一条；跨字段规则；defaults 指向不存在的配置改为 null', () => {
    for (const id of ['', 'x'.repeat(65), 5, undefined]) {
      const r = sanitizeLlmConfig({ version: 1, profiles: [{ ...profile, id }], defaults: {} });
      expect(r.value.profiles, `id = ${JSON.stringify(id)}`).toEqual([]);
      expect(r.repaired).toEqual(['profiles[0]']);
    }
    expect(sanitizeLlmConfig({ version: 1, profiles: [{ ...profile, id: 'x'.repeat(64) }], defaults: {} }).repaired).toEqual([]);
    const dup = sanitizeLlmConfig({ version: 1, profiles: [profile, { ...profile, name: '第二个' }], defaults: {} });
    expect(dup.value.profiles.map((p) => p.name)).toEqual(['DeepSeek']);
    const cross = sanitizeLlmConfig({ version: 1, profiles: [{ ...profile, contextTokens: 6000, maxOutputTokens: 4096 }], defaults: {} });
    expect(cross.repaired).toEqual(['profiles[0].contextTokens']);
    expect(cross.value.profiles[0]).toMatchObject({ contextTokens: SHARED.LLM_PROFILE_DEFAULTS.contextTokens, maxOutputTokens: SHARED.LLM_PROFILE_DEFAULTS.maxOutputTokens });
    const defaults = Object.fromEntries(TASK_KINDS.map((k, i) => [k, i === 0 ? 'ghost' : 'p1']));
    const d = sanitizeLlmConfig({ version: 1, profiles: [profile], defaults });
    expect(d.value.defaults.typo).toBeNull();
    expect(d.value.defaults.summary).toBe('p1');
    expect(d.repaired).toEqual(['defaults.typo']);
  });
});

row('前端构建产物', () => {
  it('白名单每一条都写明理由，且是以 / 结尾、互不重复的 URL 前缀', () => {
    const source = readFileSync(join(ROOT, 'scripts', 'lib', 'url-scan.ts'), 'utf8');
    expect(new Set(ALLOWED_URL_PREFIXES).size).toBe(ALLOWED_URL_PREFIXES.length);
    for (const prefix of ALLOWED_URL_PREFIXES) {
      expect(prefix, prefix).toMatch(/^https?:\/\/[^/]+\/.*\/$|^https?:\/\/[^/]+\/$/);
      const line = source.split('\n').find((l) => l.includes(`'${prefix}'`)) ?? '';
      expect(line, `${prefix} 必须在同一行用注释写明理由`).toMatch(/,\s*\/\/\s*\S.{5,}/);
    }
  });

  it('扫描目录：命中脚本、样式、HTML、source map 中的外部 URL，忽略二进制文件与白名单', () => {
    const dir = join(tmp.dir, 'web');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<script src="https://cdn.example.com/a.js"></script>');
    writeFileSync(join(dir, 'assets', 'a.js'), 'const ns = "http://www.w3.org/2000/svg";');
    writeFileSync(join(dir, 'assets', 'a.css'), '@import url(https://fonts.example.com/x.css);');
    writeFileSync(join(dir, 'assets', 'a.js.map'), '{"sources":["https://src.example.com/a.ts"]}');
    writeFileSync(join(dir, 'assets', 'logo.png'), 'https://ignored.example.com/');
    const files = scanDirForExternalUrls(dir).map((f) => `${f.file} ${f.url}`).sort();
    expect(files).toEqual([
      'assets/a.css https://fonts.example.com/x.css',
      'assets/a.js.map https://src.example.com/a.ts',
      'index.html https://cdn.example.com/a.js',
    ]);
  });

  it('前端源码中不内嵌任何外部服务地址（模型预设与 SkillHub 只在服务端，经接口下发）', () => {
    const hosts = [...LLM_PRESETS.map((p) => p.baseUrl), HUB_BASE_URL].filter((u) => u.startsWith('https://')).map((u) => new URL(u).host);
    expect(hosts.length).toBeGreaterThan(5);
    const webDir = join(ROOT, 'src', 'web');
    for (const rel of listFilesRecursive(webDir).filter((f) => /\.(ts|vue|html|css)$/.test(f))) {
      const text = readFileSync(join(webDir, ...rel.split('/')), 'utf8');
      for (const host of hosts) expect(text.includes(host), `src/web/${rel} 含有 ${host}`).toBe(false);
    }
  });
});

// ===========================================================================

describe('加载期汇总校验（validateStaticData）', () => {
  it('当前全部静态数据合法', () => {
    expect(findStaticDataProblems(createAssetReader(ROOT)).join('\n')).toBe('');
    expect(() => validateStaticData(createAssetReader(ROOT))).not.toThrow();
  });

  it('多处同时改坏时一次列出全部问题，并标明来源', () => {
    const files = realBuiltinFiles();
    delete files['builtin-skills/typo-check/SKILL.md'];
    files['builtin-skills/review-copy/SKILL.md'] = '# 无 frontmatter';
    const manifest = JSON.parse(files['builtin-skills/manifest.json'] ?? '[]') as { id: string; dir: string; jobType: string }[];
    manifest.push({ id: 'builtin:review-copy', dir: 'review-copy', jobType: 'review' });
    files['builtin-skills/manifest.json'] = JSON.stringify(manifest);
    let err: unknown;
    try {
      validateStaticData(memoryAssets(files));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StaticDataError);
    const problems = (err as StaticDataError).problems;
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.every((p) => p.startsWith('[builtin-skills] '))).toBe(true);
    expect((err as StaticDataError).message).toMatch(/^静态数据不合法（共 \d+ 项），程序无法启动：/);
  });

  it('组合根第一步就校验：内置技能被改坏时 startApp 失败，且没有写入任何数据文件', async () => {
    const root = join(tmp.dir, 'data-broken');
    const paths = dataPaths(root);
    ensureDataDirs(paths);
    const files = realBuiltinFiles();
    delete files['builtin-skills/manifest.json'];
    await expect(
      startApp({
        paths,
        config: { ...sanitizeAppConfig({}).value, port: 0 },
        log: createSilentLogger(),
        assets: createAssetReader(join(ROOT, 'tests', 'fixtures')),
        builtinAssets: memoryAssets(files),
        onShutdownRequested: () => undefined,
      }),
    ).rejects.toThrow(/\[builtin-skills\] 缺少 builtin-skills\/manifest\.json/);
    expect(existsSync(paths.llm)).toBe(false);
    expect(existsSync(join(paths.skills, 'registry.json'))).toBe(false);
  });
});

describe('文档追溯', () => {
  it('§6.5「静态数据合法性约束」表的每一行都有对应的测试（反之亦然）', () => {
    const md = readFileSync(join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');
    const start = md.indexOf('**静态数据合法性约束**');
    expect(start).toBeGreaterThan(0);
    const section = md.slice(start, md.indexOf('\n---', start));
    const rows = section
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| 数据 |'))
      .map((l) => (l.split('|')[1] ?? '').trim().replace(/`/g, ''));
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect([...covered].sort()).toEqual([...rows].sort());
  });
});
