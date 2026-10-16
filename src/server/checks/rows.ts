import type { Issue, IssueCategory, IssueStatus, Job, JobOptions, JobStatus, JobType, Scope, Severity } from '../../shared/types';

export type UnitPhase = 'summary' | 'main' | 'reduce';
export type UnitStatus = 'pending' | 'done' | 'failed';

/** 数据库行（snake_case），只在本模块与 camelCase DTO 互相转换。 */
export interface JobRow {
  id: string;
  type: JobType;
  skill_id: string;
  scope_kind: Scope['kind'];
  scope_id: string;
  profile_id: string;
  only_changed: number;
  /** JSON：JobOptions。 */
  options: string;
  status: JobStatus;
  total_units: number;
  done_units: number;
  failed_units: number;
  prompt_tokens: number;
  completion_tokens: number;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface UnitRow {
  job_id: string;
  phase: UnitPhase;
  chapter_id: string;
  chunk_index: number;
  range_start: number;
  range_end: number;
  body_hash: string;
  status: UnitStatus;
  attempts: number;
  error: string | null;
}

export interface IssueRow {
  id: string;
  job_id: string;
  chapter_id: string;
  category: IssueCategory;
  severity: Severity;
  excerpt: string;
  target: string;
  start_offset: number;
  end_offset: number;
  replacement: string | null;
  message: string;
  evidence: string;
  body_hash: string;
  status: IssueStatus;
  created_at: number;
  updated_at: number;
}

/** 单元在任务内的唯一键（与主键一致）。 */
export interface UnitKey {
  phase: UnitPhase;
  chapterId: string;
  chunkIndex: number;
}

export const unitKeyOf = (u: Pick<UnitRow, 'phase' | 'chapter_id' | 'chunk_index'>): UnitKey => ({
  phase: u.phase,
  chapterId: u.chapter_id,
  chunkIndex: u.chunk_index,
});

export const unitKeyString = (k: UnitKey): string => `${k.phase}|${k.chapterId}|${k.chunkIndex}`;

export const ACTIVE_STATUSES: readonly JobStatus[] = ['queued', 'running'];
export const TERMINAL_STATUSES: readonly JobStatus[] = ['done', 'cancelled'];

/** 解析 job.options（损坏或缺字段时按空选项处理）。 */
export function parseJobOptions(raw: string): JobOptions {
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null) return {};
    const t = (v as Record<string, unknown>).targetChars;
    return Number.isInteger(t) ? { targetChars: t as number } : {};
  } catch {
    return {};
  }
}

export function toJob(r: JobRow): Job {
  return {
    id: r.id,
    type: r.type,
    skillId: r.skill_id,
    scope: { kind: r.scope_kind, id: r.scope_id },
    profileId: r.profile_id,
    onlyChanged: r.only_changed === 1,
    options: parseJobOptions(r.options),
    status: r.status,
    totalUnits: r.total_units,
    doneUnits: r.done_units,
    failedUnits: r.failed_units,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function toIssue(r: IssueRow): Issue {
  return {
    id: r.id,
    jobId: r.job_id,
    chapterId: r.chapter_id,
    category: r.category,
    severity: r.severity,
    excerpt: r.excerpt,
    target: r.target,
    start: r.start_offset,
    end: r.end_offset,
    replacement: r.replacement,
    message: r.message,
    evidence: r.evidence,
    status: r.status,
    createdAt: r.created_at,
  };
}
