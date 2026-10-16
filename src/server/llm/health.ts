import type { Id, LlmProfileStatus } from '../../shared/types';
import type { LlmError } from './errors';

type ErrorLike = Pick<LlmError, 'kind' | 'status'>;

/**
 * 这次失败是否说明模型服务当前不可用（连接、鉴权、额度、地址、超时、限流、服务端故障）。
 * 与请求内容有关的失败（输出不合格、截断、空内容、HTTP 400 / 413 / 422）和取消返回 false：服务本身是通的。
 */
export function meansUnavailable(err: ErrorLike): boolean {
  switch (err.kind) {
    case 'config':
    case 'timeout':
    case 'network':
    case 'bad_response':
      return true;
    case 'http':
      return err.status === null || ![400, 413, 422].includes(err.status);
    default:
      return false;
  }
}

/** 按错误类型给出的处理建议（界面显示在错误原因下方）。 */
export function llmErrorHint(err: ErrorLike): string {
  switch (err.kind) {
    case 'config':
      return '在模型配置中补全服务地址和模型名';
    case 'timeout':
      return '模型在规定时间内没有响应：检查网络或代理是否正常；服务端繁忙时稍后再试；长篇任务可在模型配置的高级参数中调大「超时」';
    case 'network':
      return '连不上服务地址：检查网络、代理和服务地址是否正确；本机模型（Ollama、LM Studio）请确认服务已启动';
    case 'bad_response':
      return '服务地址可能不是 OpenAI 兼容接口：检查地址是否完整（通常以 /v1 结尾）';
    case 'http':
      break;
    default:
      return '稍后再试';
  }
  const s = err.status ?? 0;
  if (s >= 300 && s < 400) return '服务地址发生了跳转：请填写跳转后的最终地址';
  if (s === 401) return '检查 API Key 是否填写正确、是否已过期或被删除';
  if (s === 402) return '账户余额不足：充值后重试';
  if (s === 403) return '检查 API Key 的权限与账户状态（是否开通了该模型）';
  if (s === 404) return '检查服务地址（通常以 /v1 结尾）和模型名是否正确';
  if (s === 429) return '请求过于频繁或额度用尽：稍后再试，或在模型配置中调小并发数';
  if (s >= 500) return '模型服务端暂时故障：稍后再试';
  return '检查模型名与高级参数是否被服务端接受';
}

/** 三档结构化输出都没有通过时的建议（连通正常，但模型名不对或模型不能按要求输出 JSON）。 */
export const ALL_MODES_FAILED_HINT = '服务能连通，但请求没有被接受：先检查模型名是否正确；模型名无误时，说明这个模型无法按要求输出 JSON，建议换用对话类模型';

interface Entry {
  state: LlmProfileStatus['state'];
  at: number | null;
  source: LlmProfileStatus['source'];
  latencyMs: number | null;
  error: string | null;
  hint: string | null;
  retrying: number;
}

const blank = (): Entry => ({ state: 'unknown', at: null, source: null, latencyMs: null, error: null, hint: null, retrying: 0 });

export interface LlmHealthOptions {
  now: () => number;
  /** 某个模型配置的信号量占用情况。 */
  activity: (profileId: Id) => { active: number; waiting: number };
  /** 状态变化后（合并 throttleMs 内的多次变化）调用。 */
  publish?: (profileId: Id, status: LlmProfileStatus) => void;
  throttleMs: number;
}

/**
 * 模型运行状态（§7.3「运行状态」）：每个模型配置最近一次请求的结果、失败原因与处理建议，以及正在重试的请求数。
 * 只在内存中；状态有变化时合并推送（进行中、排队数会随每个请求变化）。
 */
export class LlmHealth {
  private readonly map = new Map<Id, Entry>();
  private readonly timers = new Map<Id, ReturnType<typeof setTimeout>>();
  private readonly o: LlmHealthOptions;

  constructor(options: LlmHealthOptions) {
    this.o = options;
  }

  get(id: Id): LlmProfileStatus {
    const e = this.map.get(id) ?? blank();
    const { retrying, ...rest } = e;
    return { ...rest, ...this.o.activity(id), retrying };
  }

  success(id: Id, source: 'test' | 'task', latencyMs: number): void {
    this.set(id, { state: 'ok', at: this.o.now(), source, latencyMs, error: null, hint: null });
  }

  failure(id: Id, source: 'test' | 'task', error: string, hint: string): void {
    const prev = this.map.get(id);
    this.set(id, { state: 'error', at: this.o.now(), source, latencyMs: prev?.latencyMs ?? null, error, hint });
  }

  /** 失败后开始重试（+1）或这次调用结束（−1）。 */
  retrying(id: Id, delta: 1 | -1): void {
    const e = this.entry(id);
    e.retrying = Math.max(0, e.retrying + delta);
    this.changed(id);
  }

  /** 连接配置修改后：之前的结果不再适用。正在重试的计数由各自的调用结束时归还。 */
  reset(id: Id): void {
    const e = this.entry(id);
    Object.assign(e, { ...blank(), retrying: e.retrying });
    this.changed(id);
  }

  delete(id: Id): void {
    this.map.delete(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  /** 合并推送：throttleMs 内的多次变化只推送一次最新状态。 */
  changed(id: Id): void {
    const publish = this.o.publish;
    if (publish === undefined || this.timers.has(id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      publish(id, this.get(id));
    }, this.o.throttleMs);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private entry(id: Id): Entry {
    let e = this.map.get(id);
    if (e === undefined) {
      e = blank();
      this.map.set(id, e);
    }
    return e;
  }

  private set(id: Id, next: Omit<Entry, 'retrying'>): void {
    Object.assign(this.entry(id), next);
    this.changed(id);
  }
}
