import { CHUNK_CHARS } from '../../shared/constants';
import type { LlmProfileRecord, ServerEvent } from '../../shared/types';
import { pendingCount } from '../bible/candidates';
import type { Llm } from '../llm';
import { LlmError } from '../llm/errors';
import type { Skills } from '../skills';
import type { Lease, WorkDbPool } from '../storage/db-pool';
import type { SqliteDatabase } from '../storage/sqlite';
import { tx } from '../storage/tx';
import type { Logger } from '../system/logger';
import { PROMPT_FRAME_CHARS } from './estimate';
import { JOB_HANDLERS, type ChapterSnapshot, type PhaseHandler, type UnitContext } from './handlers';
import { assemblePrompt, promptBudget } from './prompt';
import {
  addJobUsage,
  assertJobCounts,
  chunkPosition,
  dropPendingUnits,
  findJobRow,
  findUnit,
  finishUnit,
  getJobRow,
  insertUnits,
  maxChunkIndex,
  pendingUnits,
  pendingUnitsOfChapter,
  updateJob,
} from './repo';
import { toJob, unitKeyOf, unitKeyString, type JobRow, type UnitPhase, type UnitRow } from './rows';
import { chunkUnits, mainUnitsFor } from './units';

export const PHASES: readonly UnitPhase[] = ['summary', 'main', 'reduce'];

/** 一次运行中没有任何成功、却连续失败这么多个单元时，判定为整体性问题（如模型名错误），停止任务。 */
export const FATAL_AFTER_CONSECUTIVE_FAILURES = 3;

/**
 * 单元级失败（只影响这一个单元，任务继续）：两次输出都不合格、截断、空内容（均已按 §7.3 重试），以及与内容相关的
 * 400 / 413 / 422。其余错误（鉴权、额度、限流与 5xx 重试耗尽、超时、网络、配置）与单元无关，让整个任务失败并保留进度，
 * 修好后可以恢复（T18「拔网线后可恢复」）。
 */
export function isUnitLevelError(err: LlmError): boolean {
  if (err.kind === 'invalid_output' || err.kind === 'length' || err.kind === 'empty') return true;
  return err.kind === 'http' && (err.status === 400 || err.status === 413 || err.status === 422);
}

export interface JobRunnerOptions {
  pool: WorkDbPool;
  llm: Llm;
  skills: Skills;
  log: Logger;
  publish: (event: ServerEvent) => void;
  now: () => number;
  newId: () => string;
  /** job.updated 进度推送的最小间隔；状态变化立即推送。 */
  progressThrottleMs: number;
}

interface QueueEntry {
  workId: string;
  jobId: string;
}

type StopReason = 'pause' | 'cancel' | 'shutdown';

interface ActiveRun extends QueueEntry {
  controller: AbortController;
  stop: StopReason | null;
  fatal: Error | null;
  inFlight: Set<string>;
  settled: Promise<void>;
  stats: {
    written: number;
    unanchored: number;
    filtered: number;
    duplicates: number;
    successes: number;
    failures: number;
    consecutiveFailures: number;
  };
}

/** 有限并发地处理 items；shouldStop 为真后不再取新的。worker 自己处理全部异常。 */
async function runPool<T>(items: readonly T[], size: number, worker: (item: T) => Promise<void>, shouldStop: () => boolean): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (!shouldStop() && next < items.length) {
      const item = items[next++] as T;
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, lane));
}

function loadSnapshot(db: SqliteDatabase, chapterId: string): ChapterSnapshot | null {
  const r = db
    .prepare(
      `SELECT c.id, c.title, c.seq, c.body, c.body_hash, c.deleted_at, v.seq AS vseq, v.title AS vtitle, v.deleted_at AS vdel
       FROM chapter c JOIN volume v ON v.id = c.volume_id WHERE c.id = ?`,
    )
    .get(chapterId) as
    | { id: string; title: string; seq: number; body: string; body_hash: string; deleted_at: number | null; vseq: number; vtitle: string; vdel: number | null }
    | undefined;
  if (r === undefined || r.deleted_at !== null || r.vdel !== null) return null;
  return { id: r.id, title: r.title, seq: r.seq, body: r.body, bodyHash: r.body_hash, volume: { seq: r.vseq, title: r.vtitle } };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * 任务引擎（F3 第 3～5 步、ADR-006）：全局 FIFO 队列，一次只运行一个任务；任务内的单元按模型配置的
 * maxConcurrency 并发。每个单元的结果写入、单元状态与任务计数在同一事务里提交（INV-11、INV-18），
 * 所以无论何时暂停、取消或进程被杀，已完成的单元都不会重复执行，未提交的单元下次会重新执行。
 */
export class JobRunner {
  private readonly o: JobRunnerOptions;
  private readonly queue: QueueEntry[] = [];
  private current: ActiveRun | null = null;
  private stopped = false;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private idleWaiters: (() => void)[] = [];

  constructor(options: JobRunnerOptions) {
    this.o = options;
  }

  // ---------------- 队列 ----------------

  enqueue(workId: string, jobId: string): void {
    if (this.stopped) return;
    if (this.queue.some((e) => e.jobId === jobId) || this.current?.jobId === jobId) return;
    this.queue.push({ workId, jobId });
    this.pump();
  }

  /** 从队列中移除（尚未开始运行的任务）。 */
  dequeue(jobId: string): boolean {
    const i = this.queue.findIndex((e) => e.jobId === jobId);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    this.notifyIdle();
    return true;
  }

  /** 本进程中排队或运行中的任务 id（重启修正时不受影响）。 */
  activeIds(workId: string): string[] {
    const ids = this.queue.filter((e) => e.workId === workId).map((e) => e.jobId);
    if (this.current?.workId === workId) ids.push(this.current.jobId);
    return ids;
  }

  isRunning(jobId: string): boolean {
    return this.current?.jobId === jobId;
  }

  /** 让正在运行的任务停下：中止进行中的模型请求，等待收尾完成。不是当前任务时返回 false。 */
  async requestStop(jobId: string, reason: StopReason): Promise<boolean> {
    const run = this.current;
    if (run === null || run.jobId !== jobId) return false;
    if (run.stop !== 'cancel') run.stop = reason;
    run.controller.abort();
    await run.settled;
    return true;
  }

  /** 把排队中的任务改为 paused（不在运行中）。 */
  markPaused(db: SqliteDatabase, workId: string, jobId: string): void {
    tx(db, () => updateJob(db, jobId, { status: 'paused' }));
    this.publishNow(workId, jobId);
  }

  /** 删除作品前：该作品排队中的任务转为 paused，运行中的任务暂停并释放连接。 */
  async releaseWork(workId: string): Promise<void> {
    for (const e of this.queue.filter((x) => x.workId === workId)) {
      this.dequeue(e.jobId);
      this.markPaused(this.o.pool.get(workId), workId, e.jobId);
    }
    if (this.current?.workId === workId) await this.requestStop(this.current.jobId, 'pause');
  }

  /** 退出程序：不再启动新任务；排队中的转为 paused，运行中的暂停（恢复时跳过已完成的单元）。 */
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const e of this.queue.splice(0)) {
      try {
        this.markPaused(this.o.pool.get(e.workId), e.workId, e.jobId);
      } catch (err) {
        this.o.log.warn(`退出时无法更新任务 ${e.jobId} 的状态`, err);
      }
    }
    if (this.current !== null) await this.requestStop(this.current.jobId, 'shutdown');
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.notifyIdle();
  }

  /** 队列为空且没有任务在运行时 resolve（测试与退出流程使用）。 */
  whenIdle(): Promise<void> {
    if (this.current === null && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private notifyIdle(): void {
    if (this.current !== null || this.queue.length > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private pump(): void {
    if (this.current !== null || this.stopped) return;
    const next = this.queue.shift();
    if (next === undefined) {
      this.notifyIdle();
      return;
    }
    const run: ActiveRun = {
      ...next,
      controller: new AbortController(),
      stop: null,
      fatal: null,
      inFlight: new Set(),
      settled: Promise.resolve(),
      stats: { written: 0, unanchored: 0, filtered: 0, duplicates: 0, successes: 0, failures: 0, consecutiveFailures: 0 },
    };
    this.current = run;
    run.settled = this.execute(run)
      .catch((err: unknown) => this.o.log.error(`任务 ${run.jobId} 执行出错`, err))
      .finally(() => {
        this.current = null;
        this.pump();
      });
  }

  // ---------------- 推送 ----------------

  publishNow(workId: string, jobId: string): void {
    const t = this.timers.get(jobId);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(jobId);
    try {
      const row = findJobRow(this.o.pool.get(workId), jobId);
      if (row !== null) this.o.publish({ type: 'job.updated', workId, job: toJob(row) });
    } catch (err) {
      this.o.log.warn(`推送任务状态失败：${jobId}`, err);
    }
  }

  private progress(run: ActiveRun): void {
    if (this.timers.has(run.jobId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(run.jobId);
      this.publishNow(run.workId, run.jobId);
    }, this.o.progressThrottleMs);
    timer.unref();
    this.timers.set(run.jobId, timer);
  }

  // ---------------- 执行 ----------------

  private async execute(run: ActiveRun): Promise<void> {
    let lease: Lease;
    try {
      lease = this.o.pool.pin(run.workId);
    } catch (err) {
      this.o.log.warn(`任务 ${run.jobId} 所在的作品无法打开，已跳过`, err);
      return;
    }
    const db = lease.db;
    const fail = (error: string): void => {
      tx(db, () => updateJob(db, run.jobId, { status: 'failed', error: error.slice(0, 1000), finished_at: this.o.now() }));
      this.o.log.warn(`任务 ${run.jobId} 失败：${error}`);
    };
    try {
      const job = findJobRow(db, run.jobId);
      if (job === null || job.status !== 'queued') return;
      const handler = JOB_HANDLERS[job.type];
      const profile = this.o.llm.profiles.find(job.profile_id);
      if (handler === undefined) return fail(`暂不支持「${job.type}」类型的任务`);
      if (profile === null) return fail('任务使用的模型配置已被删除，请重新创建任务');
      const rules = new Map<PhaseHandler, string>();
      try {
        for (const ph of Object.values(handler)) {
          if (ph !== undefined) rules.set(ph, this.o.skills.rulesFor(ph.skill === 'job' ? job.skill_id : ph.skill));
        }
      } catch (err) {
        return fail(`任务使用的技能无法读取：${message(err)}`);
      }

      tx(db, () => updateJob(db, job.id, { status: 'running', started_at: job.started_at ?? this.o.now(), error: null, finished_at: null }));
      this.publishNow(run.workId, job.id);

      const halted = (): boolean => run.stop !== null || run.fatal !== null;
      for (const phase of PHASES) {
        while (!halted()) {
          const pending = pendingUnits(db, job.id, phase);
          if (pending.length === 0) break;
          const ph = handler[phase];
          if (ph === undefined) {
            run.fatal = new Error(`内部错误：缺少「${phase}」阶段的处理器`);
            break;
          }
          const lanes = ph.serial === true ? 1 : (this.o.llm.profiles.find(job.profile_id) ?? profile).maxConcurrency;
          await runPool(pending, lanes, (u) => this.runUnit(run, db, job, ph, rules.get(ph) ?? '', u), halted);
        }
        if (halted()) break;
      }
      this.finalize(run, db);
    } catch (err) {
      this.o.log.error(`任务 ${run.jobId} 执行出错`, err);
      fail(`内部错误：${message(err)}`);
    } finally {
      try {
        this.publishNow(run.workId, run.jobId);
      } finally {
        lease.release();
      }
    }
  }

  private finalize(run: ActiveRun, db: SqliteDatabase): void {
    const now = this.o.now();
    const { stats } = run;
    tx(db, () => {
      if (run.fatal !== null) updateJob(db, run.jobId, { status: 'failed', error: run.fatal.message.slice(0, 1000), finished_at: now });
      else if (run.stop === 'cancel') updateJob(db, run.jobId, { status: 'cancelled', finished_at: now });
      else if (run.stop !== null) updateJob(db, run.jobId, { status: 'paused' });
      else updateJob(db, run.jobId, { status: 'done', error: null, finished_at: now });
      assertJobCounts(getJobRow(db, run.jobId));
    });
    const row = getJobRow(db, run.jobId);
    const detail = `本次完成 ${stats.successes} 个单元、失败 ${stats.failures} 个，写入 ${stats.written} 条结果，${stats.unanchored} 条无法在原文中定位、${stats.filtered} 条被本地规则过滤、${stats.duplicates} 条与已有问题重复；累计用量 ${row.prompt_tokens} + ${row.completion_tokens} token`;
    if (row.status === 'failed') this.o.log.warn(`任务 ${run.jobId}（${row.type}）失败：${row.error ?? ''}。${detail}`);
    else this.o.log.info(`任务 ${run.jobId}（${row.type}）${row.status}：${row.done_units + row.failed_units}/${row.total_units}。${detail}`);
    if (row.type === 'bible_extract') this.o.publish({ type: 'candidates.changed', workId: run.workId, pending: pendingCount(db) });
    if (row.type === 'memory') this.o.publish({ type: 'memory.updated', workId: run.workId });
  }

  private async runUnit(
    run: ActiveRun,
    db: SqliteDatabase,
    job: JobRow,
    ph: PhaseHandler,
    skillRules: string,
    planned: UnitRow,
  ): Promise<void> {
    const key = unitKeyOf(planned);
    const ks = unitKeyString(key);
    try {
      const unit = findUnit(db, job.id, key);
      if (unit === null || unit.status !== 'pending') return;
      // 每个单元都读取最新的模型配置：运行中修改了配置（Key、地址、超时……）时，被中止的单元按新配置重新发送（§7.3「运行状态」）
      const profile = this.o.llm.profiles.find(job.profile_id);
      if (profile === null) {
        run.fatal ??= new Error('任务使用的模型配置已被删除，请重新创建任务');
        run.controller.abort();
        return;
      }

      let chapter: ChapterSnapshot | null = null;
      let chunk = { index: 0, count: 1 };
      // 不绑定章节的单元：审稿汇总、剧情记忆批次
      if (unit.chapter_id !== '') {
        chapter = loadSnapshot(db, unit.chapter_id);
        if (chapter === null) {
          tx(db, () => dropPendingUnits(db, job.id, [key]));
          return;
        }
        if (chapter.bodyHash !== unit.body_hash) {
          this.replanChapter(run, db, job, unit.phase, chapter);
          return;
        }
        chunk = chunkPosition(db, job.id, key, unit.body_hash);
      }

      const budget = promptBudget(profile);
      const ctx: UnitContext = {
        db,
        job,
        unit,
        chapter,
        chunk,
        now: this.o.now(),
        newId: this.o.newId,
        model: profile.model,
        targetBudget: budget - ph.protocol.length - skillRules.length - PROMPT_FRAME_CHARS,
        scratch: {},
      };
      if (ph.skip?.(ctx) === true) {
        tx(db, () => finishUnit(db, job.id, key, { ok: true }));
        run.stats.successes++;
        return;
      }
      const prompt = assemblePrompt({ protocol: ph.protocol, skillRules, ...ph.parts(ctx) }, budget);
      run.inFlight.add(ks);
      const result = await this.o.llm.client.chatJson<unknown>({
        profile,
        messages: prompt.messages,
        schema: ph.schema,
        schemaName: ph.schemaName,
        signal: run.controller.signal,
      });
      // 即使此时已请求暂停或取消，也提交这个已经拿到的合格结果
      const commit = tx(db, () => {
        const r = ph.commit({ ...ctx, now: this.o.now() }, result.value);
        finishUnit(db, job.id, key, { ok: true });
        addJobUsage(db, job.id, result.usage);
        return r;
      });
      run.stats.written += commit.written;
      run.stats.unanchored += commit.unanchored;
      run.stats.filtered += commit.filtered;
      run.stats.duplicates += commit.duplicates;
      run.stats.successes++;
      run.stats.consecutiveFailures = 0;
    } catch (err) {
      this.handleUnitError(run, db, job, key, err);
    } finally {
      run.inFlight.delete(ks);
      this.progress(run);
    }
  }

  private handleUnitError(run: ActiveRun, db: SqliteDatabase, job: JobRow, key: ReturnType<typeof unitKeyOf>, err: unknown): void {
    if (!(err instanceof LlmError)) {
      this.o.log.error(`任务 ${job.id} 执行单元出错`, err);
      run.fatal ??= new Error(`内部错误：${message(err)}`);
      run.controller.abort();
      return;
    }
    if (err.usage !== null) tx(db, () => addJobUsage(db, job.id, err.usage ?? { promptTokens: 0, completionTokens: 0 }));
    // 被暂停、取消或其他单元的致命错误中止：单元保持待执行，下次恢复时重新执行
    if (err.kind === 'aborted' || run.stop !== null || run.fatal !== null) return;
    if (isUnitLevelError(err)) {
      tx(db, () => finishUnit(db, job.id, key, { ok: false, error: err.message }));
      run.stats.failures++;
      run.stats.consecutiveFailures++;
      if (run.stats.successes === 0 && run.stats.consecutiveFailures >= FATAL_AFTER_CONSECUTIVE_FAILURES) {
        run.fatal = new Error(`连续 ${run.stats.consecutiveFailures} 个片段失败，已停止任务：${err.message}`);
        run.controller.abort();
      }
      return;
    }
    run.fatal = err;
    run.controller.abort();
  }

  /**
   * 章节在规划之后被修改（body_hash 变了）：丢弃该章本阶段尚未执行、也不在进行中的单元，按当前正文重新切块，
   * 新单元排到本阶段末尾（chunk_index 接着已有的最大值编号）。已完成单元写入的问题记录着旧哈希，读取时再重新锚定（INV-7）。
   */
  private replanChapter(run: ActiveRun, db: SqliteDatabase, job: JobRow, phase: UnitPhase, chapter: ChapterSnapshot): void {
    tx(db, () => {
      const stale = pendingUnitsOfChapter(db, job.id, phase, chapter.id)
        .map(unitKeyOf)
        .filter((k) => !run.inFlight.has(unitKeyString(k)));
      dropPendingUnits(db, job.id, stale);
      const first = maxChunkIndex(db, job.id, phase, chapter.id) + 1;
      const snapshot = { id: chapter.id, body: chapter.body, body_hash: chapter.bodyHash };
      insertUnits(db, job.id, phase === 'summary' ? chunkUnits(phase, snapshot, CHUNK_CHARS.summary, first) : mainUnitsFor(job.type, snapshot, first));
    });
    this.o.log.info(`任务 ${job.id}：章节「${chapter.title}」在检查期间被修改，已按当前正文重新切分`);
  }
}
