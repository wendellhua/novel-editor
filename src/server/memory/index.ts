import { CHUNK_CHARS, CREATIVE_LIMITS } from '../../shared/constants';
import type { Job, PlotMemory, ServerEvent } from '../../shared/types';
import type { Checks } from '../checks';
import { DomainError, invalid } from '../errors';
import type { Llm } from '../llm';
import { tocChapters } from '../manuscript/toc';
import type { WorkDbPool } from '../storage/db-pool';
import { tx } from '../storage/tx';
import type { Logger } from '../system/logger';
import { measurePending } from './coverage';
import { clearMemory, listEntries, toEntryDto } from './repo';

export interface PlotMemoryOptions {
  pool: WorkDbPool;
  checks: Checks;
  llm: Llm;
  log: Logger;
  publish: (event: ServerEvent) => void;
  now?: () => number;
  /** 保存后多久检查一次是否需要更新（防抖，默认 3 s）。 */
  debounceMs?: number;
  /** 失败的剧情记忆任务至少隔多久才自动重试（默认 10 分钟）。 */
  retryAfterMs?: number;
}

/** 本次需要的批次数：每批最多 CHUNK_CHARS.memory 字。 */
const batchesFor = (pendingChars: number): number => Math.max(1, Math.ceil(pendingChars / CHUNK_CHARS.memory));
const isActive = (j: Job | null): boolean => j !== null && (j.status === 'queued' || j.status === 'running');

/**
 * 剧情记忆（ADR-011）：为每部作品维护一份随写作增量更新的剧情记忆，供审稿、一致性检查、灵感胶囊、智能扩写参考。
 * - 自动更新：正文保存后（防抖）检查尚未纳入的字数，满 CREATIVE_LIMITS.memoryThresholdChars 字时创建剧情记忆任务；
 *   超过 memoryAutoMaxChars（如第一次给已有的长篇建立记忆）时不自动开始，由作者在「剧情记忆」中手动开始；
 * - 增量：每章记录已纳入的位置，只把新写的正文发给模型，已纳入的部分不会重复发送；
 * - 任务走统一的任务引擎（进度、暂停、失败后恢复、用量统计），批次之间串行。
 */
export class PlotMemoryService {
  private readonly o: PlotMemoryOptions;
  private readonly now: () => number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private closed = false;

  constructor(options: PlotMemoryOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
  }

  private hasModel(): boolean {
    try {
      this.o.llm.profiles.resolve('memory');
      return true;
    } catch {
      return false;
    }
  }

  /** GET W/memory：当前状态、全部更新记录（新的在前）、覆盖进度与最近的任务。 */
  get(workId: string): PlotMemory {
    const db = this.o.pool.get(workId);
    const entries = listEntries(db);
    const latest = entries.at(-1) ?? null;
    const m = measurePending(db, tocChapters(db));
    return {
      state: latest?.state ?? null,
      entries: entries.map(toEntryDto).reverse(),
      coveredChars: m.coveredChars,
      pendingChars: m.pendingChars,
      thresholdChars: CREATIVE_LIMITS.memoryThresholdChars,
      autoMaxChars: CREATIVE_LIMITS.memoryAutoMaxChars,
      updatedAt: latest?.createdAt ?? null,
      job: this.o.checks.latestOfType(workId, 'memory'),
      hasModel: this.hasModel(),
    };
  }

  /** 正文保存后调用：防抖后检查是否需要自动更新。 */
  schedule(workId: string): void {
    if (this.closed) return;
    const prev = this.timers.get(workId);
    if (prev !== undefined) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.timers.delete(workId);
      try {
        this.autoUpdate(workId);
      } catch (err) {
        this.o.log.warn(`作品 ${workId}：检查剧情记忆是否需要更新时出错`, err);
      }
    }, this.o.debounceMs ?? 3000);
    timer.unref();
    this.timers.set(workId, timer);
  }

  /** 立即执行所有等待中的检查（测试用）。 */
  flushScheduled(): void {
    for (const [workId, t] of [...this.timers]) {
      clearTimeout(t);
      this.timers.delete(workId);
      this.autoUpdate(workId);
    }
  }

  /**
   * 自动更新的判定（返回创建或恢复的任务；不需要更新时返回 null）：
   * - 已有排队或运行中的剧情记忆任务：不重复创建（它的批次在执行时会纳入最新的正文）；
   * - 暂停的（如退出程序时被暂停）：恢复；失败的：距失败超过 retryAfterMs 才恢复，避免断网时反复失败；
   * - 尚未纳入的字数 < 阈值、> 自动上限，或没有可用的模型：不更新。
   */
  autoUpdate(workId: string): Job | null {
    if (this.closed) return null;
    const last = this.o.checks.latestOfType(workId, 'memory');
    if (isActive(last)) return null;
    const db = this.o.pool.get(workId);
    const { pendingChars } = measurePending(db, tocChapters(db));
    if (pendingChars < CREATIVE_LIMITS.memoryThresholdChars || pendingChars > CREATIVE_LIMITS.memoryAutoMaxChars || !this.hasModel()) return null;
    if (last !== null && (last.status === 'paused' || last.status === 'failed')) {
      if (last.status === 'failed' && this.now() - (last.finishedAt ?? 0) < (this.o.retryAfterMs ?? 10 * 60_000)) return null;
      this.o.log.info(`作品 ${workId}：恢复上次未完成的剧情记忆任务 ${last.id}`);
      return this.o.checks.resume(workId, last.id);
    }
    this.o.log.info(`作品 ${workId}：尚未纳入剧情记忆的正文有 ${pendingChars} 字，自动更新`);
    return this.o.checks.createMemoryJob(workId, batchesFor(pendingChars));
  }

  /** POST W/memory/update：作者手动更新（不受阈值与自动上限限制）。未完成的旧任务先删除，按当前正文重新规划。 */
  async update(workId: string): Promise<Job> {
    const last = this.o.checks.latestOfType(workId, 'memory');
    if (isActive(last)) throw invalid('剧情记忆正在更新，请稍候');
    const db = this.o.pool.get(workId);
    const { pendingChars } = measurePending(db, tocChapters(db));
    if (pendingChars === 0) throw invalid('没有新的正文需要纳入剧情记忆');
    if (last !== null && (last.status === 'paused' || last.status === 'failed')) await this.o.checks.remove(workId, last.id);
    return this.o.checks.createMemoryJob(workId, batchesFor(pendingChars));
  }

  /** POST W/memory/rebuild：清空剧情记忆与进度，从头重新建立（正文改动很大时）。进行中的任务先停止并删除。 */
  async rebuild(workId: string): Promise<Job> {
    const db = this.o.pool.get(workId);
    const total = (db.prepare("SELECT coalesce(sum(length(trim(body)) > 0), 0) AS n FROM chapter WHERE deleted_at IS NULL").get() as { n: number }).n;
    if (total === 0) throw invalid('作品还没有正文');
    // 先确认有可用模型，免得清空之后建不起来
    if (!this.hasModel()) throw new DomainError('VALIDATION', '尚未为「剧情记忆」选择模型，请先在「设置 → 模型」中配置');
    const last = this.o.checks.latestOfType(workId, 'memory');
    if (last !== null && last.status !== 'done' && last.status !== 'cancelled') await this.o.checks.remove(workId, last.id);
    tx(db, () => clearMemory(db));
    this.o.publish({ type: 'memory.updated', workId });
    const { pendingChars } = measurePending(db, tocChapters(db));
    this.o.log.info(`作品 ${workId}：重建剧情记忆（${pendingChars} 字）`);
    return this.o.checks.createMemoryJob(workId, batchesFor(pendingChars));
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
