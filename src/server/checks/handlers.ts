import { MAX_ISSUES_PER_UNIT } from '../../shared/constants';
import {
  OUTPUT_SCHEMAS,
  type ConsistencyOutput,
  type ExtractOutput,
  type ReviewOutput,
  type ReviewReduceOutput,
  type SummaryOutput,
  type TypoOutput,
} from '../../shared/schemas/outputs';
import { writeExtractCandidates } from '../bible/candidates';
import { entriesInText, knownEntryBlocks, mentionBlocks, nameWhitelistBlocks, settingBlocks } from '../bible/context';
import { normalizeNewlines } from '../../shared/text';
import type { JobType } from '../../shared/types';
import { locate } from '../../shared/anchor';
import { memoryBlocks } from '../memory/context';
import type { SqliteDatabase } from '../storage/sqlite';
import { markExtractChunk, readSummary, saveSummaryChunk } from './analysis';
import { chapterLabel, fitSections, recapBlocks, tocChapters, type ReduceSection, type TocChapter } from './context';
import { aiFlavorMain, expandMain, inspirationMain } from './creative';
import { confirmedNames, filterTypoIssue } from './filters';
import { memoryMain } from './memory-unit';
import type { PromptParts } from './prompt';
import { CHARACTER_PROTOCOL, EXTRACT_PROTOCOL, REVIEW_PROTOCOL, REVIEW_REDUCE_PROTOCOL, SETTING_PROTOCOL, SUMMARY_PROTOCOL, TYPO_PROTOCOL } from './protocol';
import { chapterComments, saveChapterComment, saveOverallReport } from './report';
import { existingIssueKeys, insertIssue, issueKey } from './repo';
import type { JobRow, UnitPhase, UnitRow } from './rows';
import { NOTHING, chunkTarget, requireChapter } from './unit-kit';

/** 执行单元时读取的章节快照：提示词与锚定都基于同一份正文，写入的问题记录它的 body_hash。 */
export interface ChapterSnapshot {
  id: string;
  title: string;
  seq: number;
  body: string;
  bodyHash: string;
  volume: { seq: number; title: string };
}

export interface UnitContext {
  db: SqliteDatabase;
  job: JobRow;
  unit: UnitRow;
  /** reduce 阶段为 null。 */
  chapter: ChapterSnapshot | null;
  /** 本单元是该章本阶段的第几个片段（从 0 起）、共几个（⑥ 标题中的 i/n）。 */
  chunk: { index: number; count: number };
  now: number;
  newId: () => string;
  /** 任务所用模型名（写入分析缓存）。 */
  model: string;
  /** ⑥ 正文最多可用的字符数：提示词预算 − ① − ② − 标题框架（reduce 阶段据此裁剪输入）。 */
  targetBudget: number;
  /** 同一个单元的 skip / parts / commit 之间传递数据（如剧情记忆在组装提示词时选定的批次，提交时按它更新进度）。 */
  scratch: Record<string, unknown>;
}

export interface CommitResult {
  written: number;
  /** 模型给出但在原文中找不到的条目数（§7.4.3 第 2 步）。 */
  unanchored: number;
  /** 被本地过滤丢弃的条目数（INV-10 ① ④）。 */
  filtered: number;
  /** 与已有问题重复而跳过的位置数（§7.4.3 第 5 步）。 */
  duplicates: number;
}

/** 某任务类型某阶段的处理器：输出 Schema、编辑器协议、③～⑥ 的内容来源，以及校验通过后的写入。 */
export interface PhaseHandler<T = unknown> {
  schemaName: string;
  schema: object;
  /** §7.4.1 ①。 */
  protocol: string;
  /** ② 用哪个技能：'job' 表示任务所选技能；否则为固定的技能 id（如 summary 阶段用内置章节摘要技能）。 */
  skill: 'job' | string;
  /** §7.4.1 ③④⑤⑥（①② 由引擎填入）。 */
  parts(ctx: UnitContext): Omit<PromptParts, 'protocol' | 'skillRules'>;
  /** 在单元完成的同一事务内写入结果（INV-11：只有通过 Schema 校验的输出才会走到这里）。 */
  commit(ctx: UnitContext, output: T): CommitResult;
  /** 返回 true 时不调用模型，直接把单元标为完成（如审稿汇总时没有任何逐章意见可汇总）。 */
  skip?(ctx: UnitContext): boolean;
  /** 本阶段的单元逐个执行、不并发（剧情记忆：每次更新都基于上一次的结果）。 */
  serial?: boolean;
}

export type JobHandler = Partial<Record<UnitPhase, PhaseHandler>>;

/** ④ 前情提要：剧情记忆（只取本章之前的快照）+ 前 3 章摘要（审稿、一致性检查）。 */
function pastRecap(ctx: UnitContext, chapterId: string, toc: readonly TocChapter[] = tocChapters(ctx.db)): PromptParts['recap'] {
  return [...memoryBlocks(ctx.db, chapterId, toc, false), ...recapBlocks(ctx.db, chapterId, toc)];
}

/** 错别字检查 main 阶段：③ 专名白名单（本片段中出现的设定库名称）→ 锚定 → INV-10 过滤 → 去重 → 写入问题。 */
export const typoMain: PhaseHandler<TypoOutput> = {
  schemaName: 'typo_issues',
  schema: OUTPUT_SCHEMAS.typo,
  protocol: TYPO_PROTOCOL,
  skill: 'job',
  parts(ctx) {
    const target = chunkTarget(ctx);
    return { setting: nameWhitelistBlocks(entriesInText(ctx.db, target.text)), recap: [], mentions: [], target };
  },
  commit(ctx, output) {
    const c = ctx.chapter;
    if (c === null) throw new Error('main 阶段的单元缺少章节');
    const seen = existingIssueKeys(ctx.db, ctx.job.id, c.id, c.body, c.bodyHash);
    const names = confirmedNames(ctx.db);
    const range = { start: ctx.unit.range_start, end: ctx.unit.range_end };
    const stats: CommitResult = { written: 0, unanchored: 0, filtered: 0, duplicates: 0 };
    for (const item of output.issues.slice(0, MAX_ISSUES_PER_UNIT)) {
      const hits = locate(c.body, range, item.excerpt, item.target, item.category);
      if (hits.length === 0) stats.unanchored++;
      const replacement = normalizeNewlines(item.replacement);
      for (const hit of hits) {
        const verdict = filterTypoIssue({ category: item.category, target: hit.target, replacement, start: hit.start, end: hit.end }, c.body, names);
        if (!verdict.keep) {
          stats.filtered++;
          continue;
        }
        const key = issueKey(hit.start, hit.end, verdict.category);
        if (seen.has(key)) {
          stats.duplicates++;
          continue;
        }
        seen.add(key);
        insertIssue(ctx.db, {
          id: ctx.newId(),
          job_id: ctx.job.id,
          chapter_id: c.id,
          category: verdict.category,
          severity: item.severity,
          excerpt: hit.excerpt,
          target: hit.target,
          start_offset: hit.start,
          end_offset: hit.end,
          replacement,
          message: item.message.trim().slice(0, 500),
          evidence: '',
          body_hash: c.bodyHash,
          status: 'open',
          created_at: ctx.now,
          updated_at: ctx.now,
        });
        stats.written++;
      }
    }
    return stats;
  },
};

/** summary 阶段（审稿、一致性检查共用）：写入 chapter_analysis 摘要缓存；长章节的多个片段凑齐后合并。 */
export const summaryPhase: PhaseHandler<SummaryOutput> = {
  schemaName: 'chapter_summary',
  schema: OUTPUT_SCHEMAS.summary,
  protocol: SUMMARY_PROTOCOL,
  skill: 'builtin:chapter-summary',
  parts: (ctx) => ({ setting: [], recap: [], mentions: [], target: chunkTarget(ctx) }),
  commit(ctx, output) {
    const c = requireChapter(ctx);
    saveSummaryChunk(ctx.db, { chapterId: c.id, bodyHash: c.bodyHash, index: ctx.chunk.index, count: ctx.chunk.count, text: output.summary, model: ctx.model, now: ctx.now });
    return { ...NOTHING, written: 1 };
  },
};

/** 审稿 main 阶段：④ 前情提要（剧情记忆 + 前 3 章摘要）+ 本片段；意见锚定后写入问题（category = 'review'），整体评语写入逐章报告。 */
export const reviewMain: PhaseHandler<ReviewOutput> = {
  schemaName: 'review_issues',
  schema: OUTPUT_SCHEMAS.review,
  protocol: REVIEW_PROTOCOL,
  skill: 'job',
  parts: (ctx) => ({ setting: [], recap: pastRecap(ctx, requireChapter(ctx).id), mentions: [], target: chunkTarget(ctx) }),
  commit(ctx, output) {
    const c = requireChapter(ctx);
    const seen = existingIssueKeys(ctx.db, ctx.job.id, c.id, c.body, c.bodyHash);
    const range = { start: ctx.unit.range_start, end: ctx.unit.range_end };
    const stats: CommitResult = { ...NOTHING };
    for (const item of output.issues.slice(0, MAX_ISSUES_PER_UNIT)) {
      const hits = locate(c.body, range, item.excerpt, item.target, 'review');
      if (hits.length === 0) stats.unanchored++;
      for (const hit of hits) {
        // 与原文相同的「改写」没有意义：保留意见，但不可一键修正
        const rewritten = item.replacement === null ? null : normalizeNewlines(item.replacement);
        const replacement = rewritten === hit.target ? null : rewritten;
        const key = issueKey(hit.start, hit.end, 'review');
        if (seen.has(key)) {
          stats.duplicates++;
          continue;
        }
        seen.add(key);
        insertIssue(ctx.db, {
          id: ctx.newId(),
          job_id: ctx.job.id,
          chapter_id: c.id,
          category: 'review',
          severity: item.severity,
          excerpt: hit.excerpt,
          target: hit.target,
          start_offset: hit.start,
          end_offset: hit.end,
          replacement,
          message: item.message.trim().slice(0, 1000),
          evidence: '',
          body_hash: c.bodyHash,
          status: 'open',
          created_at: ctx.now,
          updated_at: ctx.now,
        });
        stats.written++;
      }
    }
    saveChapterComment(ctx.db, ctx.job.id, c.id, ctx.chunk.index, ctx.chunk.count, output.comment.slice(0, 4000));
    return stats;
  },
};

/** reduce 输入中每章最多列出的问题条数，以及每条的长度。 */
const REDUCE_ISSUES_PER_CHAPTER = 5;
const clip = (s: string, n: number): string => ([...s].length <= n ? s : `${[...s].slice(0, n).join('')}…`);

interface ReduceIssue {
  chapter_id: string;
  target: string;
  message: string;
}

function reduceMaterial(ctx: UnitContext): ReduceSection[] {
  const comments = chapterComments(ctx.db, ctx.job.id);
  const issues = new Map<string, ReduceIssue[]>();
  const rows = ctx.db
    .prepare("SELECT chapter_id, target, message FROM issue WHERE job_id = ? AND category = 'review' ORDER BY chapter_id, start_offset")
    .all(ctx.job.id) as unknown as ReduceIssue[];
  for (const r of rows) {
    const list = issues.get(r.chapter_id);
    if (list === undefined) issues.set(r.chapter_id, [r]);
    else list.push(r);
  }
  const out: ReduceSection[] = [];
  for (const c of tocChapters(ctx.db)) {
    const comment = comments.get(c.id);
    const list = issues.get(c.id) ?? [];
    if (comment === undefined && list.length === 0) continue;
    const lines: string[] = [];
    if (comment !== undefined) lines.push(`评语：${comment}`);
    if (list.length > 0) {
      lines.push(`问题（${list.length} 处）：`);
      for (const i of list.slice(0, REDUCE_ISSUES_PER_CHAPTER)) lines.push(`- 「${clip(i.target, 20)}」${clip(i.message.replace(/\s+/gu, ' '), 80)}`);
      if (list.length > REDUCE_ISSUES_PER_CHAPTER) lines.push(`- （另有 ${list.length - REDUCE_ISSUES_PER_CHAPTER} 处）`);
    }
    const summary = readSummary(ctx.db, c.id);
    if (summary !== null) lines.push(`摘要：${summary.summary}`);
    out.push({ heading: `### ${chapterLabel(c)}`, body: lines.join('\n') });
  }
  return out;
}

/**
 * 审稿 reduce 阶段：把本任务各章的评语、问题与摘要汇总成整体报告（Markdown）。
 * 输入按 ⑥ 的预算裁剪（context.fitSections），所以章节再多也放得下；没有任何逐章意见时跳过，不调用模型。
 */
export const reviewReduce: PhaseHandler<ReviewReduceOutput> = {
  schemaName: 'review_report',
  schema: OUTPUT_SCHEMAS.review_reduce,
  protocol: REVIEW_REDUCE_PROTOCOL,
  skill: 'job',
  skip: (ctx) => reduceMaterial(ctx).length === 0,
  parts(ctx) {
    const sections = reduceMaterial(ctx);
    const header = `【审稿汇总 · 共 ${sections.length} 章】`;
    const fit = fitSections(sections, Math.max(0, ctx.targetBudget - header.length - 1));
    return { setting: [], recap: [], mentions: [], target: { header, text: fit.text } };
  },
  commit(ctx, output) {
    saveOverallReport(ctx.db, ctx.job.id, normalizeNewlines(output.report).slice(0, 50_000));
    return { ...NOTHING, written: 1 };
  },
};

/**
 * 设定抽取 main 阶段（F5）：③ 列出本片段中出现的已有条目（沿用设定库的叫法）；输出经 INV-8 校验、
 * 按名称匹配已有条目后写成待审核候选；该章全部片段完成后在 chapter_analysis 记下「这个正文版本已抽取」。
 */
export const extractMain: PhaseHandler<ExtractOutput> = {
  schemaName: 'bible_extract',
  schema: OUTPUT_SCHEMAS.extract,
  protocol: EXTRACT_PROTOCOL,
  skill: 'job',
  parts(ctx) {
    const target = chunkTarget(ctx);
    return { setting: knownEntryBlocks(entriesInText(ctx.db, target.text)), recap: [], mentions: [], target };
  },
  commit(ctx, output) {
    const c = requireChapter(ctx);
    const s = writeExtractCandidates(ctx.db, { jobId: ctx.job.id, chapterId: c.id, body: c.body, now: ctx.now, newId: ctx.newId }, output);
    markExtractChunk(ctx.db, { chapterId: c.id, bodyHash: c.bodyHash, index: ctx.chunk.index, count: ctx.chunk.count, model: ctx.model, now: ctx.now });
    return { written: s.written, unanchored: 0, filtered: s.dropped, duplicates: s.duplicates };
  },
};

/**
 * 一致性检查 main 阶段（设定 / 角色，ADR-009）：③ 本片段中出现的条目（角色检查只取人物条目；可变事实截至上一章）、
 * ④ 前情提要、⑤ 前文提及 + ⑥；输出锚定后写成 category = 任务类型的问题，evidence 写成「【条目】依据」。
 */
function consistencyMain(type: 'setting' | 'character', protocol: string): PhaseHandler<ConsistencyOutput> {
  return {
    schemaName: `${type}_issues`,
    schema: OUTPUT_SCHEMAS.consistency,
    protocol,
    skill: 'job',
    parts(ctx) {
      const c = requireChapter(ctx);
      const target = chunkTarget(ctx);
      const toc = tocChapters(ctx.db);
      const entries = entriesInText(ctx.db, target.text).filter((e) => type === 'setting' || e.kind === 'character');
      return {
        setting: settingBlocks(ctx.db, entries, c.id, toc),
        recap: pastRecap(ctx, c.id, toc),
        mentions: mentionBlocks(ctx.db, entries, c.id, toc),
        target,
      };
    },
    commit(ctx, output) {
      const c = requireChapter(ctx);
      const seen = existingIssueKeys(ctx.db, ctx.job.id, c.id, c.body, c.bodyHash);
      const range = { start: ctx.unit.range_start, end: ctx.unit.range_end };
      const stats: CommitResult = { ...NOTHING };
      for (const item of output.issues.slice(0, MAX_ISSUES_PER_UNIT)) {
        const hits = locate(c.body, range, item.excerpt, item.target, type);
        if (hits.length === 0) stats.unanchored++;
        for (const hit of hits) {
          const rewritten = item.replacement === null ? null : normalizeNewlines(item.replacement);
          const replacement = rewritten === hit.target ? null : rewritten;
          const key = issueKey(hit.start, hit.end, type);
          if (seen.has(key)) {
            stats.duplicates++;
            continue;
          }
          seen.add(key);
          const entry = item.entryName.trim();
          const evidence = item.evidence.trim();
          insertIssue(ctx.db, {
            id: ctx.newId(),
            job_id: ctx.job.id,
            chapter_id: c.id,
            category: type,
            severity: item.severity,
            excerpt: hit.excerpt,
            target: hit.target,
            start_offset: hit.start,
            end_offset: hit.end,
            replacement,
            message: item.message.trim().slice(0, 1000),
            evidence: (entry === '' ? evidence : `【${entry}】${evidence}`).slice(0, 1000),
            body_hash: c.bodyHash,
            status: 'open',
            created_at: ctx.now,
            updated_at: ctx.now,
          });
          stats.written++;
        }
      }
      return stats;
    },
  };
}

export const settingMain = consistencyMain('setting', SETTING_PROTOCOL);
export const characterMain = consistencyMain('character', CHARACTER_PROTOCOL);

/** 已实现的任务类型（与 ENABLED_JOB_TYPES 一致，§6.5 校验）。 */
export const JOB_HANDLERS: Partial<Record<JobType, JobHandler>> = {
  typo: { main: typoMain as PhaseHandler },
  review: { summary: summaryPhase as PhaseHandler, main: reviewMain as PhaseHandler, reduce: reviewReduce as PhaseHandler },
  setting: { summary: summaryPhase as PhaseHandler, main: settingMain as PhaseHandler },
  character: { summary: summaryPhase as PhaseHandler, main: characterMain as PhaseHandler },
  ai_flavor: { main: aiFlavorMain as PhaseHandler },
  inspiration: { summary: summaryPhase as PhaseHandler, main: inspirationMain as PhaseHandler },
  expand: { summary: summaryPhase as PhaseHandler, main: expandMain as PhaseHandler },
  bible_extract: { main: extractMain as PhaseHandler },
  memory: { main: memoryMain as PhaseHandler },
};
