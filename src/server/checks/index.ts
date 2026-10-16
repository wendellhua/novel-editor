import { randomUUID } from 'node:crypto';
import {
  AUTO_JOB_TYPES,
  CHAPTER_SCOPE_JOB_TYPES,
  CHUNK_CHARS,
  CREATIVE_LIMITS,
  ENABLED_JOB_TYPES,
  EXPAND_TOKENS_PER_CHAR,
  RECAP_CHAPTERS,
} from '../../shared/constants';
import type { ApplyExpansionResponse, CreateJobRequest, Expansion, Job, JobEstimate, JobOptions, JobReport, JobType, LlmProfileRecord, ServerEvent } from '../../shared/types';
import { invalid } from '../errors';
import type { Llm } from '../llm';
import type { Manuscript } from '../manuscript';
import type { Skills } from '../skills';
import type { WorkDbPool } from '../storage/db-pool';
import type { SqliteDatabase } from '../storage/sqlite';
import { tx } from '../storage/tx';
import type { Logger } from '../system/logger';
import {
  CONSISTENCY_CONTEXT_ESTIMATE_CHARS,
  CREATIVE_CONTEXT_ESTIMATE_CHARS,
  MEMORY_ESTIMATE_CHARS,
  PROMPT_FRAME_CHARS,
  RECAP_ESTIMATE_CHARS,
  REDUCE_ESTIMATE_CHARS_PER_CHAPTER,
  estimateJob,
} from './estimate';
import { applyExpansion, readExpansion } from './expansion';
import { JOB_HANDLERS } from './handlers';
import { JobRunner } from './job-runner';
import { promptBudget } from './prompt';
import { readReport } from './report';
import { deleteJob, getJobRow, insertJob, insertUnits, listJobRows, pauseOrphanedJobs, resetFailedUnits, updateJob } from './repo';
import { toJob, type JobRow, type UnitPhase } from './rows';
import { NEEDS_SUMMARY, memoryUnits, planUnits, type Plan } from './units';

export interface ChecksOptions {
  pool: WorkDbPool;
  llm: Llm;
  skills: Skills;
  log: Logger;
  publish: (event: ServerEvent) => void;
  /** 插入智能扩写时写正文（Manuscript.fixChapterBody）。 */
  manuscript?: Manuscript;
  now?: () => number;
  newId?: () => string;
  progressThrottleMs?: number;
}

interface Resolved {
  type: JobType;
  skillId: string;
  profile: LlmProfileRecord;
  overhead: Partial<Record<UnitPhase, number>>;
  plan: Plan;
  options: JobOptions;
}

export const TYPE_LABELS: Record<JobType, string> = {
  typo: '错别字与标点',
  review: '编辑审稿',
  setting: '设定一致性',
  character: '角色一致性',
  ai_flavor: 'AI 味检测',
  inspiration: '灵感胶囊',
  expand: '智能扩写',
  bible_extract: '设定抽取',
  memory: '剧情记忆',
};

/** 扩写输出约需多少 token（按 EXPAND_TOKENS_PER_CHAR 估算，JSON 外壳另留 200）。 */
export const expandOutputTokens = (targetChars: number): number => Math.ceil(targetChars * EXPAND_TOKENS_PER_CHAR) + 200;

/**
 * checks 模块门面（F3、ADR-006）：校验并规划任务、预估用量、创建任务，以及暂停 / 恢复 / 取消 / 删除。
 * 任务数据存在各作品库里；进程重启后第一次访问某作品的任务时，把上一个进程留下的 queued / running 改为 paused。
 */
export class Checks {
  readonly runner: JobRunner;
  private readonly o: ChecksOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly reconciled = new Set<string>();

  constructor(options: ChecksOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.runner = new JobRunner({
      pool: options.pool,
      llm: options.llm,
      skills: options.skills,
      log: options.log,
      publish: options.publish,
      now: this.now,
      newId: this.newId,
      progressThrottleMs: options.progressThrottleMs ?? 250,
    });
  }

  /** 取作品库连接；本进程第一次访问该作品时修正上一个进程遗留的任务状态。 */
  private db(workId: string): SqliteDatabase {
    const db = this.o.pool.get(workId);
    if (!this.reconciled.has(workId)) {
      const n = tx(db, () => pauseOrphanedJobs(db, this.runner.activeIds(workId)));
      if (n > 0) this.o.log.info(`作品 ${workId}：${n} 个上次未完成的任务已转为暂停，可在检查面板中恢复`);
      this.reconciled.add(workId);
    }
    return db;
  }

  private profileFor(type: JobType, profileId: string | undefined): LlmProfileRecord {
    let profile: LlmProfileRecord;
    if (profileId !== undefined) {
      const found = this.o.llm.profiles.find(profileId);
      if (found === null) throw invalid('所选模型配置不存在');
      profile = found;
    } else {
      profile = this.o.llm.profiles.resolve(type);
    }
    if (profile.baseUrl === '' || profile.model.trim() === '') throw invalid(`模型配置「${profile.name}」缺少服务地址或模型名`);
    return profile;
  }

  /** 每个阶段的固定开销（① 协议 + ② 技能规则）；最长的片段也必须放进所选模型的预算（§7.4.1 ①②⑥ 不裁剪）。 */
  private overheadFor(type: JobType, skillId: string, profile: LlmProfileRecord): Partial<Record<UnitPhase, number>> {
    const handler = JOB_HANDLERS[type];
    const overhead: Partial<Record<UnitPhase, number>> = {};
    if (handler === undefined) return overhead;
    const budget = promptBudget(profile);
    for (const [phase, ph] of Object.entries(handler) as [UnitPhase, NonNullable<(typeof handler)[UnitPhase]>][]) {
      overhead[phase] = ph.protocol.length + this.o.skills.rulesFor(ph.skill === 'job' ? skillId : ph.skill).length;
      const maxChunk = phase === 'summary' ? CHUNK_CHARS.summary : phase === 'main' ? CHUNK_CHARS[type] : 0;
      const need = (overhead[phase] ?? 0) + PROMPT_FRAME_CHARS + maxChunk;
      if (need > budget) {
        throw invalid(
          `模型「${profile.name}」的上下文长度不足：单个片段约需 ${need} token，可用 ${budget}（上下文 − 最大输出 − 余量）。请在模型配置中调大上下文长度或调小最大输出`,
        );
      }
    }
    return overhead;
  }

  private resolve(workId: string, req: CreateJobRequest): Resolved {
    const handler = JOB_HANDLERS[req.type];
    if (AUTO_JOB_TYPES.includes(req.type)) throw invalid(`「${TYPE_LABELS[req.type]}」由系统在写作过程中自动更新，可以在「剧情记忆」中手动更新`);
    if (!ENABLED_JOB_TYPES.includes(req.type) || handler === undefined) throw invalid(`「${TYPE_LABELS[req.type]}」检查将在后续版本提供`);
    if (CHAPTER_SCOPE_JOB_TYPES.includes(req.type) && req.scope.kind !== 'chapter') {
      throw invalid(`「${TYPE_LABELS[req.type]}」只能针对当前章节${req.type === 'expand' ? '：每次只根据前文完成当前这一章' : ''}`);
    }
    if (req.options?.targetChars !== undefined && req.type !== 'expand') throw invalid('只有智能扩写可以设置目标字数');

    const skillId = req.skillId ?? this.o.skills.builtinFor(req.type);
    const skill = this.o.skills.find(skillId);
    if (skill === null) throw invalid('所选技能不存在');
    if (!skill.enabled) throw invalid(`技能「${skill.name}」已停用`);
    if (!skill.appliesTo.includes(req.type)) throw invalid(`技能「${skill.name}」不适用于「${TYPE_LABELS[req.type]}」检查`);

    const profile = this.profileFor(req.type, req.profileId);
    const options: JobOptions = req.type === 'expand' ? { targetChars: req.options?.targetChars ?? CREATIVE_LIMITS.expandDefaultChars } : {};
    if (options.targetChars !== undefined && profile.maxOutputTokens < expandOutputTokens(options.targetChars)) {
      throw invalid(
        `模型「${profile.name}」的最大输出（${profile.maxOutputTokens} token）不够写约 ${options.targetChars} 字，至少需要 ${expandOutputTokens(options.targetChars)}。请调小扩写字数，或在模型配置中调大最大输出`,
      );
    }
    const overhead = this.overheadFor(req.type, skillId, profile);

    const plan = planUnits(this.db(workId), {
      workId,
      type: req.type,
      skillId,
      scope: req.scope,
      onlyChanged: req.onlyChanged === true,
    });
    return { type: req.type, skillId, profile, overhead, plan, options };
  }

  estimate(workId: string, req: CreateJobRequest): JobEstimate {
    const r = this.resolve(workId, req);
    const reduceCap = Math.max(0, promptBudget(r.profile) - (r.overhead.reduce ?? 0) - PROMPT_FRAME_CHARS);
    const t = r.type;
    return estimateJob(r.plan, r.overhead, {
      mainContextChars:
        (NEEDS_SUMMARY.has(t) ? RECAP_CHAPTERS * RECAP_ESTIMATE_CHARS + MEMORY_ESTIMATE_CHARS : 0) +
        (t === 'setting' || t === 'character' ? CONSISTENCY_CONTEXT_ESTIMATE_CHARS : 0) +
        (CHAPTER_SCOPE_JOB_TYPES.includes(t) ? CREATIVE_CONTEXT_ESTIMATE_CHARS : 0),
      reduceInputChars: Math.min(reduceCap, r.plan.chapters * REDUCE_ESTIMATE_CHARS_PER_CHAPTER),
    });
  }

  /** 审稿报告（整体 + 逐章）、灵感胶囊（整体报告）；其他类型的任务返回空报告。 */
  report(workId: string, jobId: string): JobReport {
    const db = this.db(workId);
    getJobRow(db, jobId);
    return readReport(db, jobId);
  }

  /** 智能扩写的结果（F7）。 */
  expansion(workId: string, jobId: string): Expansion {
    const db = this.db(workId);
    getJobRow(db, jobId);
    return readExpansion(db, jobId);
  }

  /** 把扩写插入章末（F7 第 4 步）。 */
  applyExpansion(workId: string, jobId: string, force: boolean): ApplyExpansionResponse {
    if (this.o.manuscript === undefined) throw new Error('内部错误：Checks 未配置 manuscript');
    getJobRow(this.db(workId), jobId);
    const res = applyExpansion(this.o.pool, this.o.manuscript, workId, jobId, force);
    this.o.log.info(`作品 ${workId}：扩写任务 ${jobId} 已插入章末（${res.inserted.length} 字）`);
    return res;
  }

  private insertJobWithUnits(workId: string, row: Omit<JobRow, 'id' | 'status' | 'total_units' | 'done_units' | 'failed_units' | 'prompt_tokens' | 'completion_tokens' | 'error' | 'created_at' | 'started_at' | 'finished_at'>, units: Plan['units']): Job {
    const db = this.db(workId);
    const id = this.newId();
    tx(db, () => {
      insertJob(db, {
        ...row,
        id,
        status: 'queued',
        total_units: 0,
        done_units: 0,
        failed_units: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        error: null,
        created_at: this.now(),
        started_at: null,
        finished_at: null,
      });
      insertUnits(db, id, units);
    });
    this.runner.publishNow(workId, id);
    this.runner.enqueue(workId, id);
    return toJob(getJobRow(this.o.pool.get(workId), id));
  }

  create(workId: string, req: CreateJobRequest): Job {
    const r = this.resolve(workId, req);
    if (r.plan.units.length === 0) {
      if (r.type === 'bible_extract' && r.plan.skippedChapters > 0) throw invalid('范围内的章节都已抽取过，且正文没有改动');
      if (CHAPTER_SCOPE_JOB_TYPES.includes(r.type)) throw invalid('本章和前面的章节都还没有正文，没有可以参考的前文');
      throw invalid(req.onlyChanged === true ? '范围内的章节自上次检查后都没有改动，或正文为空' : '范围内没有需要检查的正文');
    }
    const job = this.insertJobWithUnits(
      workId,
      {
        type: r.type,
        skill_id: r.skillId,
        scope_kind: req.scope.kind,
        scope_id: req.scope.id,
        profile_id: r.profile.id,
        only_changed: req.onlyChanged === true ? 1 : 0,
        options: JSON.stringify(r.options),
      },
      r.plan.units,
    );
    this.o.log.info(`已创建任务 ${job.id}（${r.type}，${r.plan.chapters} 章，${r.plan.units.length} 个单元，模型「${r.profile.name}」）`);
    return job;
  }

  /**
   * 系统任务：剧情记忆更新（ADR-011）。batches 个串行批次，每个批次执行时才选定内容；使用「剧情记忆」的默认模型与内置技能。
   * 没有可用的模型时抛 400（调用方据此不自动更新）。
   */
  createMemoryJob(workId: string, batches: number): Job {
    const profile = this.profileFor('memory', undefined);
    const skillId = this.o.skills.builtinFor('memory');
    this.overheadFor('memory', skillId, profile);
    const job = this.insertJobWithUnits(
      workId,
      { type: 'memory', skill_id: skillId, scope_kind: 'work', scope_id: workId, profile_id: profile.id, only_changed: 0, options: '{}' },
      memoryUnits(batches),
    );
    this.o.log.info(`已创建剧情记忆任务 ${job.id}（${batches} 个批次，模型「${profile.name}」）`);
    return job;
  }

  /** 某类任务中最近创建的一个（剧情记忆查阅与自动更新用）。 */
  latestOfType(workId: string, type: JobType): Job | null {
    const row = this.db(workId).prepare('SELECT * FROM job WHERE type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(type) as JobRow | undefined;
    return row === undefined ? null : toJob(row);
  }

  list(workId: string): Job[] {
    return listJobRows(this.db(workId)).map(toJob);
  }

  get(workId: string, jobId: string): Job {
    return toJob(getJobRow(this.db(workId), jobId));
  }

  async pause(workId: string, jobId: string): Promise<Job> {
    const db = this.db(workId);
    const row = getJobRow(db, jobId);
    if (row.status === 'queued') {
      this.runner.dequeue(jobId);
      this.runner.markPaused(db, workId, jobId);
    } else if (row.status === 'running') {
      if (!(await this.runner.requestStop(jobId, 'pause'))) this.runner.markPaused(this.o.pool.get(workId), workId, jobId);
    } else if (row.status !== 'paused') {
      throw invalid('任务已结束，无法暂停');
    }
    return this.get(workId, jobId);
  }

  /** 恢复暂停或失败的任务：失败的单元重新放回待执行，已完成的单元跳过。 */
  resume(workId: string, jobId: string): Job {
    const db = this.db(workId);
    const row = getJobRow(db, jobId);
    if (row.status === 'paused' || row.status === 'failed') {
      tx(db, () => {
        resetFailedUnits(db, jobId);
        updateJob(db, jobId, { status: 'queued', error: null, finished_at: null });
      });
      this.runner.publishNow(workId, jobId);
      this.runner.enqueue(workId, jobId);
    } else if (row.status === 'done' || row.status === 'cancelled') {
      throw invalid('任务已结束，无法恢复');
    }
    return this.get(workId, jobId);
  }

  async cancel(workId: string, jobId: string): Promise<Job> {
    const db = this.db(workId);
    const row = getJobRow(db, jobId);
    if (row.status === 'done') throw invalid('任务已完成，无法取消');
    if (row.status === 'running' && (await this.runner.requestStop(jobId, 'cancel'))) return this.get(workId, jobId);
    if (row.status !== 'cancelled') {
      this.runner.dequeue(jobId);
      const fresh = this.o.pool.get(workId);
      tx(fresh, () => updateJob(fresh, jobId, { status: 'cancelled', finished_at: this.now() }));
      this.runner.publishNow(workId, jobId);
    }
    return this.get(workId, jobId);
  }

  /** 删除任务及其问题、报告；运行中的先取消。 */
  async remove(workId: string, jobId: string): Promise<void> {
    const row = getJobRow(this.db(workId), jobId);
    if (row.status === 'running') await this.runner.requestStop(jobId, 'cancel');
    this.runner.dequeue(jobId);
    const db = this.o.pool.get(workId);
    tx(db, () => deleteJob(db, jobId));
  }

  /** 删除作品前调用：停下该作品的任务并释放连接；作品恢复后重新修正状态。 */
  async releaseWork(workId: string): Promise<void> {
    await this.runner.releaseWork(workId);
    this.reconciled.delete(workId);
  }

  shutdown(): Promise<void> {
    return this.runner.shutdown();
  }

  whenIdle(): Promise<void> {
    return this.runner.whenIdle();
  }
}
