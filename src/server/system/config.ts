import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync } from 'node:fs';
import type { ValidateFunction } from 'ajv';
import {
  DEFAULT_PORT,
  JSON_MODES,
  LLM_FIELD_MAX,
  LLM_PROFILE_DEFAULTS,
  LLM_PROFILE_RANGES,
  LLM_PROMPT_HEADROOM,
  TASK_KINDS,
  THEME_MODES,
} from '../../shared/constants';
import type { AppConfig, JsonMode, LlmConfig, LlmProfileRecord, TaskKind } from '../../shared/types';
import { ajv } from './ajv';
import { readTextIfExists, writeJsonAtomic } from './atomic';
import type { Logger } from './logger';
import type { DataPaths } from './paths';

interface FieldSpec<T> {
  check: ValidateFunction;
  fallback: () => T;
}

function field<T>(schema: object, fallback: () => T): FieldSpec<T> {
  return { check: ajv.compile(schema), fallback };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function take<T>(obj: Record<string, unknown>, key: string, spec: FieldSpec<T>, path: string, repaired: string[]): T {
  const value = obj[key];
  if (spec.check(value)) return value as T;
  repaired.push(path);
  return spec.fallback();
}

export interface Sanitized<T> {
  value: T;
  repaired: string[];
}

// ---------------- AppConfig（§6.2 / §6.5） ----------------

const APP_FIELDS = {
  port: field({ type: 'integer', minimum: 1024, maximum: 65535 }, () => DEFAULT_PORT),
  authSecret: field({ type: 'string', pattern: '^[0-9a-f]{64}$' }, () => randomBytes(32).toString('hex')),
  hubClientId: field(
    { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
    () => randomUUID(),
  ),
  fontSize: field({ type: 'integer', minimum: 12, maximum: 32 }, () => 18),
  theme: field({ enum: [...THEME_MODES] }, () => 'system' as const),
};

export function defaultAppConfig(): AppConfig {
  return sanitizeAppConfig({}).value;
}

export function sanitizeAppConfig(raw: unknown): Sanitized<AppConfig> {
  const repaired: string[] = [];
  const obj = isPlainObject(raw) ? raw : {};
  if (obj.version !== 1) repaired.push('version');
  const uiRaw = isPlainObject(obj.ui) ? obj.ui : {};
  if (!isPlainObject(obj.ui)) repaired.push('ui');
  const value: AppConfig = {
    version: 1,
    port: take(obj, 'port', APP_FIELDS.port, 'port', repaired),
    authSecret: take(obj, 'authSecret', APP_FIELDS.authSecret, 'authSecret', repaired),
    hubClientId: take(obj, 'hubClientId', APP_FIELDS.hubClientId, 'hubClientId', repaired),
    ui: {
      fontSize: take(uiRaw, 'fontSize', APP_FIELDS.fontSize, 'ui.fontSize', repaired),
      theme: take(uiRaw, 'theme', APP_FIELDS.theme, 'ui.theme', repaired),
    },
  };
  return { value, repaired };
}

// ---------------- LlmConfig（§6.2 / §6.5） ----------------

const range = (key: keyof typeof LLM_PROFILE_RANGES, type: 'integer' | 'number' = 'integer'): object => ({
  type,
  minimum: LLM_PROFILE_RANGES[key][0],
  maximum: LLM_PROFILE_RANGES[key][1],
});

const D = LLM_PROFILE_DEFAULTS;
const PROFILE_FIELDS = {
  id: field({ type: 'string', minLength: 1, maxLength: 64 }, () => ''),
  name: field({ type: 'string', minLength: 1, maxLength: LLM_FIELD_MAX.name }, () => '未命名模型'),
  baseUrl: field({ type: 'string', pattern: '^(https?://.+)?$', maxLength: LLM_FIELD_MAX.baseUrl }, () => ''),
  apiKey: field({ type: 'string', maxLength: LLM_FIELD_MAX.apiKey }, () => ''),
  model: field({ type: 'string', maxLength: LLM_FIELD_MAX.model }, () => ''),
  jsonMode: field({ enum: [...JSON_MODES] }, (): JsonMode => D.jsonMode),
  maxConcurrency: field(range('maxConcurrency'), () => D.maxConcurrency),
  timeoutMs: field(range('timeoutMs'), () => D.timeoutMs),
  maxOutputTokens: field(range('maxOutputTokens'), () => D.maxOutputTokens),
  contextTokens: field(range('contextTokens'), () => D.contextTokens),
  temperature: field(range('temperature', 'number'), () => D.temperature),
  extraBody: field({ type: 'object' }, () => ({})),
};

function sanitizeLlmProfile(raw: unknown, path: string): Sanitized<LlmProfileRecord | null> {
  const repaired: string[] = [];
  if (!isPlainObject(raw) || !PROFILE_FIELDS.id.check(raw.id)) {
    return { value: null, repaired: [path] };
  }
  const t = <T>(key: keyof typeof PROFILE_FIELDS, spec: FieldSpec<T>): T => take(raw, key, spec, `${path}.${key}`, repaired);
  const profile: LlmProfileRecord = {
    id: raw.id as string,
    name: t('name', PROFILE_FIELDS.name),
    baseUrl: t('baseUrl', PROFILE_FIELDS.baseUrl),
    apiKey: t('apiKey', PROFILE_FIELDS.apiKey),
    model: t('model', PROFILE_FIELDS.model),
    jsonMode: t('jsonMode', PROFILE_FIELDS.jsonMode),
    maxConcurrency: t('maxConcurrency', PROFILE_FIELDS.maxConcurrency),
    timeoutMs: t('timeoutMs', PROFILE_FIELDS.timeoutMs),
    maxOutputTokens: t('maxOutputTokens', PROFILE_FIELDS.maxOutputTokens),
    contextTokens: t('contextTokens', PROFILE_FIELDS.contextTokens),
    temperature: t('temperature', PROFILE_FIELDS.temperature),
    extraBody: t('extraBody', PROFILE_FIELDS.extraBody),
  };
  if (profile.contextTokens < profile.maxOutputTokens + LLM_PROMPT_HEADROOM) {
    profile.maxOutputTokens = PROFILE_FIELDS.maxOutputTokens.fallback();
    profile.contextTokens = PROFILE_FIELDS.contextTokens.fallback();
    repaired.push(`${path}.contextTokens`);
  }
  return { value: profile, repaired };
}

export function defaultLlmConfig(): LlmConfig {
  return sanitizeLlmConfig({}).value;
}

export function sanitizeLlmConfig(raw: unknown): Sanitized<LlmConfig> {
  const repaired: string[] = [];
  const obj = isPlainObject(raw) ? raw : {};
  if (obj.version !== 1) repaired.push('version');

  const profiles: LlmProfileRecord[] = [];
  const seen = new Set<string>();
  const rawProfiles = Array.isArray(obj.profiles) ? obj.profiles : [];
  if (!Array.isArray(obj.profiles)) repaired.push('profiles');
  rawProfiles.forEach((p, i) => {
    const r = sanitizeLlmProfile(p, `profiles[${i}]`);
    repaired.push(...r.repaired);
    if (r.value === null) return;
    if (seen.has(r.value.id)) {
      repaired.push(`profiles[${i}].id`);
      return;
    }
    seen.add(r.value.id);
    profiles.push(r.value);
  });

  const defaultsRaw = isPlainObject(obj.defaults) ? obj.defaults : {};
  if (!isPlainObject(obj.defaults)) repaired.push('defaults');
  const defaults = {} as Record<TaskKind, string | null>;
  for (const kind of TASK_KINDS) {
    const v = defaultsRaw[kind];
    if (v === null || (typeof v === 'string' && seen.has(v))) {
      defaults[kind] = v;
    } else {
      defaults[kind] = null;
      if (v !== undefined) repaired.push(`defaults.${kind}`);
    }
  }
  return { value: { version: 1, profiles, defaults }, repaired };
}

// ---------------- 文件读写 ----------------

function backupBroken(file: string, log: Logger, reason: string): void {
  const backup = `${file}.broken-${Date.now()}`;
  try {
    copyFileSync(file, backup);
    log.warn(`${reason}，原文件已备份为 ${backup}`);
  } catch (err) {
    log.warn(`${reason}，备份原文件失败`, err);
  }
}

/**
 * 读取并修复 JSON 文件（§6.5「配置文件」）：不存在时写入默认值；不是 JSON 或有字段被修复时，先备份原文件为
 * `<文件名>.broken-<时间戳>` 再原子写回修复后的内容。llm.json、config.json、skills/registry.json 共用。
 */
export function loadJsonConfig<T>(file: string, sanitize: (raw: unknown) => Sanitized<T>, log: Logger, label: string): T {
  const text = readTextIfExists(file);
  if (text === null) {
    const { value } = sanitize({});
    writeJsonAtomic(file, value);
    log.info(`已生成默认${label}：${file}`);
    return value;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    backupBroken(file, log, `${label}不是合法 JSON，已重置为默认值`);
    const { value } = sanitize({});
    writeJsonAtomic(file, value);
    return value;
  }
  const { value, repaired } = sanitize(raw);
  if (repaired.length > 0) {
    backupBroken(file, log, `${label}中以下字段不合法，已重置为默认值：${repaired.join(', ')}`);
    writeJsonAtomic(file, value);
  }
  return value;
}

export function loadAppConfig(paths: DataPaths, log: Logger): AppConfig {
  return loadJsonConfig(paths.config, sanitizeAppConfig, log, '应用配置');
}

export function saveAppConfig(paths: DataPaths, config: AppConfig): void {
  writeJsonAtomic(paths.config, config);
}

export function loadLlmConfig(paths: DataPaths, log: Logger): LlmConfig {
  return loadJsonConfig(paths.llm, sanitizeLlmConfig, log, '模型配置');
}

export function saveLlmConfig(paths: DataPaths, config: LlmConfig): void {
  writeJsonAtomic(paths.llm, config);
}
