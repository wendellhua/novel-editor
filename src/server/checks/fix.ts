import { OUTPUT_SCHEMAS, type FixOutput } from '../../shared/schemas/outputs';
import { normalizeNewlines } from '../../shared/text';
import type { Issue, IssueCategory, JobType, LlmProfileRecord } from '../../shared/types';
import { invalid, missing } from '../errors';
import type { Llm } from '../llm';
import type { ChatMessage } from '../llm/client';
import type { WorkDbPool } from '../storage/db-pool';
import type { SqliteDatabase } from '../storage/sqlite';
import { tx } from '../storage/tx';
import type { Logger } from '../system/logger';
import { alignChapter, liveChapter } from './issues';
import { promptBudget } from './prompt';
import { FIX_PROTOCOL } from './protocol';
import { findJobRow } from './repo';
import { toIssue, type IssueRow } from './rows';

/** 提供给模型的前文、后文长度（字）；所选模型的上下文放不下时按比例缩短。 */
export const FIX_CONTEXT_BEFORE_CHARS = 400;
export const FIX_CONTEXT_AFTER_CHARS = 200;
/** 小节标题、类别等固定开销（字）。 */
const FIX_FRAME_CHARS = 200;
/** 去掉与前文结尾 / 后文开头重复的部分时，至少重复多少字才算（单个标点另行处理）。 */
export const FIX_ECHO_MIN_CHARS = 2;
/** 改写结果的长度上限：防止模型改写整段、把前后文一起输出。 */
export const fixMaxChars = (target: string): number => Math.max(200, target.length * 4);

/** 问题类别 → 发现它的检查类型（任务的模型配置已删除时，用该类型的默认模型）。 */
const JOB_TYPE_OF: Record<IssueCategory, JobType> = {
  typo: 'typo',
  punctuation: 'typo',
  grammar: 'typo',
  review: 'review',
  setting: 'setting',
  character: 'character',
  ai_flavor: 'ai_flavor',
};

const CATEGORY_TEXT: Record<IssueCategory, string> = {
  typo: '错别字',
  punctuation: '标点',
  grammar: '语病',
  review: '编辑审稿意见',
  setting: '设定矛盾',
  character: '角色矛盾',
  ai_flavor: 'AI 味（模板化、空泛、不自然的表达）',
};

const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['"', '"'],
];

const PUNCT_RE = /^\p{P}$/u;

/** s 的开头与 tail 的结尾重复的最长长度（≥ min），没有时为 0。 */
export function echoAtStart(s: string, tail: string, min: number): number {
  for (let k = Math.min(s.length, tail.length); k >= min; k--) if (s.startsWith(tail.slice(tail.length - k))) return k;
  return 0;
}

/** s 的结尾与 head 的开头重复的最长长度（≥ min），没有时为 0。 */
function echoAtEnd(s: string, head: string, min: number): number {
  for (let k = Math.min(s.length, head.length); k >= min; k--) if (s.endsWith(head.slice(0, k))) return k;
  return 0;
}

/**
 * 整理模型给出的改写，返回放回 target 位置的文字；与 target 相同时返回 null。
 * - 统一换行；target 两端没有空白时去掉两端空白；
 * - 去掉模型自己加上的成对引号（target 本身以该引号开头时保留）；
 * - 去掉与前文结尾、后文开头重复的部分（模型常把前后文一起输出）：重复 ≥ 2 字，或是单个相同的标点
 *   （如后文以「。」开头而改写也以「。」结尾）；target 自身就以这些字开头或结尾时不去掉。
 */
export function cleanReplacement(raw: string, target: string, before: string, after: string): string | null {
  let s = normalizeNewlines(raw);
  if (!/^\s/u.test(target)) s = s.trimStart();
  if (!/\s$/u.test(target)) s = s.trimEnd();
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.length >= open.length + close.length && s.startsWith(open) && s.endsWith(close) && !target.startsWith(open)) {
      s = s.slice(open.length, s.length - close.length);
      break;
    }
  }
  const head = echoAtStart(s, before, FIX_ECHO_MIN_CHARS);
  if (head > 0 && !target.startsWith(before.slice(before.length - head))) s = s.slice(head);
  else if (before !== '' && PUNCT_RE.test(before.at(-1) ?? '') && s.startsWith(before.at(-1) ?? '') && !target.startsWith(before.at(-1) ?? '')) s = s.slice(1);
  const tail = echoAtEnd(s, after, FIX_ECHO_MIN_CHARS);
  if (tail > 0 && !target.endsWith(after.slice(0, tail))) s = s.slice(0, s.length - tail);
  else if (after !== '' && PUNCT_RE.test(after[0] ?? '') && s.endsWith(after[0] ?? '') && !target.endsWith(after[0] ?? '')) s = s.slice(0, -1);
  return s === target ? null : s;
}

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** 前文 / 后文：不从代理对中间截断。 */
function contextAround(body: string, start: number, end: number, beforeChars: number, afterChars: number): { before: string; after: string } {
  let from = Math.max(0, start - beforeChars);
  if (from > 0 && isLowSurrogate(body.charCodeAt(from))) from++;
  let to = Math.min(body.length, end + afterChars);
  if (to < body.length && isLowSurrogate(body.charCodeAt(to))) to--;
  return { before: body.slice(from, start), after: body.slice(end, to) };
}

/** 修复请求的 user 消息：修改意见（类别、意见、依据）→ 前文 → 待修改的原文 → 后文。 */
export function fixMessages(issue: Pick<IssueRow, 'category' | 'message' | 'evidence' | 'target'>, before: string, after: string): ChatMessage[] {
  const opinion = [`类别：${CATEGORY_TEXT[issue.category]}`, `意见：${issue.message}`];
  if (issue.evidence.trim() !== '') opinion.push(`依据：${issue.evidence}`);
  const user = [
    `## 修改意见\n${opinion.join('\n')}`,
    `## 前文\n${before === '' ? '（无：这处文字在章节开头）' : before}`,
    `## 待修改的原文\n${issue.target}`,
    `## 后文\n${after === '' ? '（无：这处文字在章节结尾）' : after}`,
  ].join('\n\n');
  return [
    { role: 'system', content: FIX_PROTOCOL },
    { role: 'user', content: user },
  ];
}

export interface IssueFixerOptions {
  pool: WorkDbPool;
  llm: Llm;
  log: Logger;
  now?: () => number;
}

const issueRow = (db: SqliteDatabase, id: string): IssueRow | null => (db.prepare('SELECT * FROM issue WHERE id = ?').get(id) as IssueRow | undefined) ?? null;

type Prepared = { kind: 'ready'; row: IssueRow } | { kind: 'ask'; row: IssueRow; body: string } | { kind: 'stale' };

/**
 * AI 修复（F4 补充）：为没有修改建议的「待处理」问题，按其意见让模型改写 target，写入 replacement。
 * 只生成建议、不改正文——正文仍只经一键修正（Issues.apply → Manuscript.fixChapterBody）写入，带 before_fix 版本、可撤销。
 * 使用发现该问题的任务所用的模型；该模型配置已删除时用这类检查的默认模型。
 */
export class IssueFixer {
  private readonly o: IssueFixerOptions;
  private readonly now: () => number;

  constructor(options: IssueFixerOptions) {
    this.o = options;
    this.now = options.now ?? Date.now;
  }

  async suggest(workId: string, issueId: string, signal?: AbortSignal): Promise<Issue> {
    const db = this.o.pool.get(workId);
    // 先按当前正文对齐（INV-7），提示词里的前后文与 target 一定逐字对应当前正文；失效的标为 stale 并提交
    const prepared = tx(db, (): Prepared => {
      const row = issueRow(db, issueId);
      if (row === null) throw missing('问题不存在或已被删除，请刷新问题列表');
      if (row.status === 'stale') return { kind: 'stale' };
      if (row.status !== 'open') throw invalid('这条问题已经处理过了');
      if (row.replacement !== null) return { kind: 'ready', row };
      const chapter = liveChapter(db, row.chapter_id);
      if (chapter === null) throw missing('问题所在的章节已删除');
      const current = alignChapter(db, chapter, this.now(), this.o.log).find((r) => r.id === issueId);
      return current === undefined ? { kind: 'stale' } : { kind: 'ask', row: current, body: chapter.body };
    });
    if (prepared.kind === 'stale') throw invalid('原文已改动，这条问题已失效');
    if (prepared.kind === 'ready') return toIssue(prepared.row);
    const { row, body } = prepared;

    const profile = this.profileFor(db, row);
    const fixed = FIX_PROTOCOL.length + row.message.length + row.evidence.length + row.target.length + FIX_FRAME_CHARS;
    const room = promptBudget(profile) - fixed;
    if (room < 0) throw invalid(`模型「${profile.name}」的上下文长度不足，无法修复这条问题。请在模型配置中调大上下文长度或调小最大输出`);
    const total = FIX_CONTEXT_BEFORE_CHARS + FIX_CONTEXT_AFTER_CHARS;
    const scale = Math.min(1, room / total);
    const { before, after } = contextAround(
      body,
      row.start_offset,
      row.end_offset,
      Math.floor(FIX_CONTEXT_BEFORE_CHARS * scale),
      Math.floor(FIX_CONTEXT_AFTER_CHARS * scale),
    );

    const result = await this.o.llm.client.chatJson<FixOutput>({
      profile,
      messages: fixMessages(row, before, after),
      schema: OUTPUT_SCHEMAS.fix,
      schemaName: 'issue_fix',
      signal,
    });
    this.o.log.info(
      `作品 ${workId}：AI 修复问题 ${issueId}（${row.category}），模型「${profile.name}」，用量 ${result.usage.promptTokens} + ${result.usage.completionTokens} token`,
    );
    const replacement = cleanReplacement(result.value.replacement, row.target, before, after);
    if (replacement === null) throw invalid('AI 认为这处不需要修改，没有给出改写');
    if (replacement.length > fixMaxChars(row.target)) throw invalid('AI 给出的改写过长（可能连同前后文一起改写了），没有采用');

    // 只写建议；模型调用期间问题被处理（采纳、忽略）或已有建议时以库中为准
    const saved = tx(db, () => {
      db.prepare("UPDATE issue SET replacement = ?, updated_at = ? WHERE id = ? AND status = 'open' AND replacement IS NULL").run(replacement, this.now(), issueId);
      return issueRow(db, issueId);
    });
    if (saved === null) throw missing('问题不存在或已被删除，请刷新问题列表');
    if (saved.status !== 'open') throw invalid('这条问题在修复期间已被处理');
    return toIssue(saved);
  }

  private profileFor(db: SqliteDatabase, row: IssueRow): LlmProfileRecord {
    const job = findJobRow(db, row.job_id);
    const profile = (job === null ? null : this.o.llm.profiles.find(job.profile_id)) ?? this.o.llm.profiles.resolve(job?.type ?? JOB_TYPE_OF[row.category]);
    if (profile.baseUrl === '' || profile.model.trim() === '') throw invalid(`模型配置「${profile.name}」缺少服务地址或模型名`);
    return profile;
  }
}
