import type { CreateLlmProfileRequest, Id, LlmConfig, LlmPreset, LlmProfile, LlmProfileStatus, ProbeResult, UpdateLlmProfileRequest } from '../../shared/types';
import type { Logger } from '../system/logger';
import { LlmClient, type LlmClientOptions } from './client';
import { LLM_PRESETS } from './presets';
import { probeProfile, type ProbeOptions } from './probe';
import { LlmProfiles } from './profiles';

export interface LlmOptions extends Omit<LlmClientOptions, 'log'> {
  config: LlmConfig;
  save: (config: LlmConfig) => void;
  log: Logger;
  /** 测试用：缩短测试连接的时限。 */
  probe?: ProbeOptions;
}

/** 修改配置后中止进行中的请求时，被中止的调用拿到的原因（AI 修复会把它显示给作者；任务会自动按新配置重发）。 */
export const RESTART_MESSAGE = '模型配置已修改，进行中的请求已停止，请重试';

/** llm 模块门面：模型配置、客户端、运行状态与测试连接。http 层与 checks 只通过它使用大模型。 */
export class Llm {
  readonly profiles: LlmProfiles;
  readonly client: LlmClient;
  private readonly log: Logger;
  private readonly probe: ProbeOptions;

  constructor(options: LlmOptions) {
    const { config, save, log, probe, ...clientOptions } = options;
    this.log = log;
    this.probe = probe ?? {};
    this.profiles = new LlmProfiles({ config, save, log });
    this.client = new LlmClient({ ...clientOptions, log });
  }

  presets(): LlmPreset[] {
    return LLM_PRESETS.map((p) => ({ ...p }));
  }

  /** 全部模型配置的运行状态（§7.3「运行状态」）。 */
  statuses(): Record<Id, LlmProfileStatus> {
    return Object.fromEntries(this.profiles.list().map((p) => [p.id, this.client.health.get(p.id)]));
  }

  /**
   * 测试连接：逐档探测，成功后把探测到的 jsonMode 写回配置（§7.2），结果记入运行状态。
   * 调用方取消（signal）或配置在测试期间被修改时抛出 LlmError('aborted')，不记录结果。
   */
  async test(id: Id, signal?: AbortSignal): Promise<ProbeResult> {
    const profile = this.profiles.get(id);
    const result = await probeProfile(this.client, profile, signal, this.probe);
    if (result.ok) {
      this.profiles.setJsonMode(id, result.jsonMode);
      this.client.health.success(id, 'test', result.latencyMs);
      this.log.info(`模型「${profile.name}」测试连接成功：${result.jsonMode}，${result.latencyMs} ms`);
    } else {
      this.client.health.failure(id, 'test', result.error ?? '测试连接失败', result.hint ?? '');
      this.log.warn(`模型「${profile.name}」测试连接失败：${result.error ?? ''}`);
    }
    return result;
  }

  createProfile(req: CreateLlmProfileRequest): LlmProfile {
    return this.profiles.create(req);
  }

  /**
   * 修改配置（§7.3「运行状态」）：服务地址、Key 或模型名变了，旧的结果不再适用——状态回到 unknown，
   * 进行中、排队和等待重试的请求全部中止，任务把这些单元按新配置重新发送。
   * 只改了其他参数（如超时、并发）时，若模型正处于异常状态且有请求在进行（多半卡在超时重试），同样中止重发。
   */
  updateProfile(id: Id, req: UpdateLlmProfileRequest): LlmProfile {
    const before = this.profiles.get(id);
    const dto = this.profiles.update(id, req);
    const after = this.profiles.get(id);
    const connection = before.baseUrl !== after.baseUrl || before.apiKey !== after.apiKey || before.model !== after.model;
    const status = this.client.health.get(id);
    if (connection || (status.state === 'error' && status.active + status.waiting > 0)) {
      const stopped = this.client.restart(id, RESTART_MESSAGE);
      if (stopped > 0) this.log.info(`模型「${after.name}」的配置已修改：${stopped} 个进行中的请求已停止，AI 任务会按新配置重新发送`);
    }
    if (connection) this.client.health.reset(id);
    return dto;
  }

  removeProfile(id: Id): void {
    this.profiles.remove(id);
    this.client.restart(id, '模型配置已删除');
    this.client.limiters.delete(id);
    this.client.health.delete(id);
  }
}
