import type { HubSecurityReport, HubSkill, HubSkillDetail } from '../../shared/types';
import { missing } from '../errors';
import { HubError } from './errors';

export const HUB_BASE_URL = 'https://api.skillhub.cn';

export interface HubClientOptions {
  clientId: string;
  userAgent: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
  maxZipBytes: number;
}

/** 与官方 CLI 一致的安全报告来源映射（SECURITY_REPORT_SOURCES）。 */
const REPORT_PROVIDERS: Record<string, string> = { keen: '科恩实验室', 'keen-xti': '科恩实验室', sanbu: '云鼎实验室' };

/** namespace / slug 只允许安全字符：会被拼进目录名 `{namespace}__{slug}`。 */
export const HUB_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * SkillHub 匿名接口适配（§7.5，契约依据本机 CLI 源码并经实测）。浏览器从不直连外部域名，全部由服务端转发（INV-17）。
 * 任何失败都抛 HubError（502），不影响编辑与本地导入。
 */
export class HubClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly maxZipBytes: number;

  constructor(options: HubClientOptions) {
    this.base = (options.baseUrl ?? HUB_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 60_000;
    this.maxZipBytes = options.maxZipBytes;
    this.headers = { 'User-Agent': options.userAgent, 'X-SkillHub-Client-Id': options.clientId };
  }

  async search(q: string, limit = 20): Promise<HubSkill[]> {
    const n = Math.min(50, Math.max(1, Math.floor(limit)));
    const data = obj(await this.getJson(`/api/v1/search?q=${encodeURIComponent(q)}&limit=${n}`));
    if (!Array.isArray(data.results)) throw new HubError('SkillHub 搜索结果格式不正确');
    const out: HubSkill[] = [];
    for (const raw of data.results) {
      const item = obj(raw);
      const slug = str(item.slug);
      const namespace = str(obj(item.namespace).handle);
      if (slug === '' || !HUB_NAME_RE.test(slug) || !HUB_NAME_RE.test(namespace)) continue;
      out.push({
        namespace,
        slug,
        name: str(item.displayName) || str(item.name) || slug,
        summary: str(item.summary) || str(item.description),
        version: str(item.version),
      });
    }
    return out;
  }

  async detail(namespace: string, slug: string): Promise<HubSkillDetail> {
    assertHubName(namespace, slug);
    const data = obj(await this.getJson(`/api/v1/skills/${encodeURIComponent(slug)}?namespace=${encodeURIComponent(namespace)}`));
    const skill = obj(data.skill);
    const reports: HubSecurityReport[] = [];
    const seen = new Set<string>();
    for (const [key, raw] of Object.entries(obj(data.securityReports))) {
      const r = obj(raw);
      const reportUrl = str(r.reportUrl) || str(r.report_url);
      const provider = REPORT_PROVIDERS[key] ?? key;
      // 只接受 https 链接：界面会把它渲染成 <a href>，防止 javascript: 等协议
      if (!reportUrl.startsWith('https://') || seen.has(provider)) continue;
      seen.add(provider);
      reports.push({ provider, status: str(r.status), statusText: str(r.statusText), reportUrl });
    }
    return {
      namespace: str(obj(data.namespace).handle) || namespace,
      slug,
      name: str(skill.displayName) || str(skill.name) || slug,
      summary: str(skill.summary) || str(skill.description),
      version: str(obj(data.latestVersion).version) || str(skill.version),
      securityReports: reports,
    };
  }

  /** 下载技能 zip（接口会 302 到对象存储，跟随重定向；不带任何凭据）。大小超过上限立即中止。 */
  async download(namespace: string, slug: string, version = ''): Promise<Buffer> {
    assertHubName(namespace, slug);
    const path = `/api/v1/download?slug=${encodeURIComponent(slug)}&namespace=${encodeURIComponent(namespace)}&version=${encodeURIComponent(version)}`;
    const res = await this.request(path, 'application/zip, application/octet-stream', this.downloadTimeoutMs);
    if (res.status === 404) throw missing('SkillHub 上找不到该技能或版本');
    if (!res.ok) throw new HubError(`SkillHub 下载失败（HTTP ${res.status}）`);
    const declared = Number(res.headers.get('content-length'));
    const tooLarge = (): HubError => new HubError(`技能包超过 ${Math.round(this.maxZipBytes / 1048576)} MB，已拒绝下载`);
    if (Number.isFinite(declared) && declared > this.maxZipBytes) {
      await res.body?.cancel();
      throw tooLarge();
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of res.body ?? []) {
        size += chunk.length;
        if (size > this.maxZipBytes) throw tooLarge();
        chunks.push(Buffer.from(chunk));
      }
    } catch (err) {
      if (err instanceof HubError) throw err;
      throw new HubError(`下载技能包中断：${err instanceof Error ? err.message : String(err)}`);
    }
    return Buffer.concat(chunks, size);
  }

  private async getJson(path: string): Promise<unknown> {
    const res = await this.request(path, 'application/json', this.timeoutMs);
    if (res.status === 404) throw missing('SkillHub 上找不到该技能');
    if (!res.ok) throw new HubError(`SkillHub 返回 HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new HubError('SkillHub 响应格式不正确');
    }
  }

  private async request(path: string, accept: string, timeoutMs: number): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.base}${path}`, {
        headers: { ...this.headers, Accept: accept },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : err instanceof Error ? err.message : String(err);
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new HubError('连接 SkillHub 超时');
      throw new HubError(`无法连接 SkillHub：${cause}`);
    }
  }
}

function assertHubName(namespace: string, slug: string): void {
  if (!HUB_NAME_RE.test(namespace) || !HUB_NAME_RE.test(slug)) throw missing('技能坐标不合法');
}
