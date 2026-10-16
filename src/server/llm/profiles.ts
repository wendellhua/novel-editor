import { randomUUID } from 'node:crypto';
import {
  LLM_DEFAULT_FALLBACKS,
  LLM_EXTRA_BODY_RESERVED,
  LLM_FIELD_MAX,
  LLM_PROFILE_DEFAULTS,
  LLM_PROMPT_HEADROOM,
  TASK_KINDS,
} from '../../shared/constants';
import type {
  CreateLlmProfileRequest,
  Id,
  JsonMode,
  LlmConfig,
  LlmDefaults,
  LlmProfile,
  LlmProfileRecord,
  TaskKind,
  UpdateLlmProfileRequest,
} from '../../shared/types';
import { invalid, missing } from '../errors';
import { maskSecret, type Logger } from '../system/logger';

export interface LlmProfilesOptions {
  config: LlmConfig;
  /** 持久化（原子写 llm.json，INV-16）；抛错时内存状态不变。 */
  save: (config: LlmConfig) => void;
  log: Logger;
  newId?: () => Id;
}

/** 响应 DTO：永远不含明文 Key（INV-17）。 */
export function toLlmProfile(record: LlmProfileRecord): LlmProfile {
  const { apiKey, ...rest } = record;
  return { ...rest, apiKeyMasked: apiKey === '' ? '' : maskSecret(apiKey) };
}

/** 去首尾空白与末尾的 `/`；粘贴了完整接口地址（…/chat/completions）时去掉该后缀。 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid('服务地址不是合法的网址');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw invalid('服务地址必须以 http:// 或 https:// 开头');
  if (parsed.username !== '' || parsed.password !== '') throw invalid('服务地址中不能包含用户名或密码');
  if (parsed.search !== '' || parsed.hash !== '') throw invalid('服务地址中不能包含 ? 或 # 参数');
  return url;
}

const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

function cleanText(value: string, label: string, max: number): string {
  const v = value.trim();
  if (v === '') throw invalid(`${label}不能为空`);
  if (v.length > max) throw invalid(`${label}不能超过 ${max} 个字符`);
  return v;
}

function checkExtraBody(extraBody: Record<string, unknown>): void {
  const reserved: readonly string[] = LLM_EXTRA_BODY_RESERVED;
  const bad = Object.keys(extraBody).filter((k) => reserved.includes(k));
  if (bad.length > 0) throw invalid(`附加参数不能包含 ${bad.join('、')}（由程序控制）`);
  if (JSON.stringify(extraBody).length > LLM_FIELD_MAX.extraBodyJson) {
    throw invalid(`附加参数过长（不超过 ${LLM_FIELD_MAX.extraBodyJson} 个字符）`);
  }
}

function checkBudget(p: LlmProfileRecord): void {
  if (p.contextTokens < p.maxOutputTokens + LLM_PROMPT_HEADROOM) {
    throw invalid(`上下文长度至少要比最大输出多 ${LLM_PROMPT_HEADROOM} token（当前 ${p.contextTokens} < ${p.maxOutputTokens} + ${LLM_PROMPT_HEADROOM}）`);
  }
}

/**
 * 模型配置与默认模型映射（§6.2 LlmConfig）。数值范围与字段格式由 http 层 Schema 校验，这里负责
 * 规范化、跨字段规则与 Key 保护：更换服务域名而未提供新 Key 时清空旧 Key，防止把 Key 发给新的服务方（INV-17）。
 */
export class LlmProfiles {
  private config: LlmConfig;
  private readonly save: (config: LlmConfig) => void;
  private readonly log: Logger;
  private readonly newId: () => Id;

  constructor(options: LlmProfilesOptions) {
    this.config = structuredClone(options.config);
    this.save = options.save;
    this.log = options.log;
    this.newId = options.newId ?? randomUUID;
    for (const p of this.config.profiles) this.log.registerSecret(p.apiKey);
  }

  list(): LlmProfile[] {
    return this.config.profiles.map(toLlmProfile);
  }

  find(id: Id): LlmProfileRecord | null {
    return this.config.profiles.find((p) => p.id === id) ?? null;
  }

  /** 内部使用（含明文 Key），不得直接作为响应返回。 */
  get(id: Id): LlmProfileRecord {
    const p = this.find(id);
    if (p === null) throw missing('模型配置不存在');
    return p;
  }

  create(req: CreateLlmProfileRequest): LlmProfile {
    const record: LlmProfileRecord = {
      id: this.newId(),
      name: cleanText(req.name, '名称', LLM_FIELD_MAX.name),
      baseUrl: normalizeBaseUrl(req.baseUrl),
      apiKey: (req.apiKey ?? '').trim(),
      model: cleanText(req.model, '模型名', LLM_FIELD_MAX.model),
      jsonMode: req.jsonMode ?? LLM_PROFILE_DEFAULTS.jsonMode,
      maxConcurrency: req.maxConcurrency ?? LLM_PROFILE_DEFAULTS.maxConcurrency,
      timeoutMs: req.timeoutMs ?? LLM_PROFILE_DEFAULTS.timeoutMs,
      maxOutputTokens: req.maxOutputTokens ?? LLM_PROFILE_DEFAULTS.maxOutputTokens,
      contextTokens: req.contextTokens ?? LLM_PROFILE_DEFAULTS.contextTokens,
      temperature: req.temperature ?? LLM_PROFILE_DEFAULTS.temperature,
      extraBody: req.extraBody ?? {},
    };
    checkExtraBody(record.extraBody);
    checkBudget(record);
    this.commit({ ...this.config, profiles: [...this.config.profiles, record] });
    this.log.registerSecret(record.apiKey);
    this.log.info(`已添加模型配置「${record.name}」（${record.model} @ ${record.baseUrl}）`);
    return toLlmProfile(record);
  }

  update(id: Id, req: UpdateLlmProfileRequest): LlmProfile {
    const old = this.get(id);
    const next: LlmProfileRecord = { ...old };
    if (req.name !== undefined) next.name = cleanText(req.name, '名称', LLM_FIELD_MAX.name);
    if (req.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(req.baseUrl);
    if (req.model !== undefined) next.model = cleanText(req.model, '模型名', LLM_FIELD_MAX.model);
    if (req.jsonMode !== undefined) next.jsonMode = req.jsonMode;
    if (req.maxConcurrency !== undefined) next.maxConcurrency = req.maxConcurrency;
    if (req.timeoutMs !== undefined) next.timeoutMs = req.timeoutMs;
    if (req.maxOutputTokens !== undefined) next.maxOutputTokens = req.maxOutputTokens;
    if (req.contextTokens !== undefined) next.contextTokens = req.contextTokens;
    if (req.temperature !== undefined) next.temperature = req.temperature;
    if (req.extraBody !== undefined) next.extraBody = req.extraBody;

    const newKey = (req.apiKey ?? '').trim();
    let keyCleared = false;
    if (newKey !== '') {
      next.apiKey = newKey;
    } else if (old.apiKey !== '' && originOf(next.baseUrl) !== originOf(old.baseUrl)) {
      next.apiKey = '';
      keyCleared = true;
    }
    checkExtraBody(next.extraBody);
    checkBudget(next);
    this.commit({ ...this.config, profiles: this.config.profiles.map((p) => (p.id === id ? next : p)) });
    this.log.registerSecret(next.apiKey);
    this.log.info(`已修改模型配置「${next.name}」${keyCleared ? '（服务域名已变更，旧 API Key 已清空）' : ''}`);
    return toLlmProfile(next);
  }

  /** 删除配置，并把指向它的默认模型改为 null。 */
  remove(id: Id): void {
    const old = this.get(id);
    const defaults = { ...this.config.defaults };
    for (const kind of TASK_KINDS) if (defaults[kind] === id) defaults[kind] = null;
    this.commit({ ...this.config, profiles: this.config.profiles.filter((p) => p.id !== id), defaults });
    this.log.info(`已删除模型配置「${old.name}」`);
  }

  /** 探测成功后写回能力档位；配置已被删除时忽略。 */
  setJsonMode(id: Id, mode: JsonMode): void {
    const old = this.find(id);
    if (old === null || old.jsonMode === mode) return;
    this.commit({ ...this.config, profiles: this.config.profiles.map((p) => (p.id === id ? { ...p, jsonMode: mode } : p)) });
  }

  getDefaults(): LlmDefaults {
    return { ...this.config.defaults };
  }

  setDefaults(map: LlmDefaults): LlmDefaults {
    for (const kind of TASK_KINDS) {
      const id = map[kind];
      if (id !== null && this.find(id) === null) throw invalid(`默认模型指向不存在的配置（${kind}）`);
    }
    const defaults = Object.fromEntries(TASK_KINDS.map((k) => [k, map[k]])) as LlmDefaults;
    this.commit({ ...this.config, defaults });
    return { ...defaults };
  }

  /**
   * 任务使用的模型：显式指定的优先，否则取该类任务的默认模型（T13 起使用）。
   * 创作辅助与剧情记忆（后加的任务类型）没有单独设置时沿用相近任务的默认模型（DEFAULT_FALLBACKS），
   * 升级后的旧配置不用再逐项设置，剧情记忆也能自动更新。
   */
  resolve(kind: TaskKind, profileId?: Id): LlmProfileRecord {
    const d = this.config.defaults;
    const id = profileId ?? d[kind] ?? (LLM_DEFAULT_FALLBACKS[kind] ?? []).map((k) => d[k]).find((v) => v !== null && v !== undefined) ?? null;
    if (id === null) throw invalid('尚未为这类任务选择模型，请先在「设置 → 模型」中配置');
    return this.get(id);
  }

  private commit(next: LlmConfig): void {
    this.save(next);
    this.config = next;
  }
}
