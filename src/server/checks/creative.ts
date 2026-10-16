import { locate } from '../../shared/anchor';
import { CREATIVE_LIMITS, MAX_ISSUES_PER_UNIT } from '../../shared/constants';
import { OUTPUT_SCHEMAS, type AiFlavorOutput, type ExpandOutput, type InspirationOutput } from '../../shared/schemas/outputs';
import { normalizeNewlines } from '../../shared/text';
import { entriesInText, nameWhitelistBlocks, settingBlocks } from '../bible/context';
import { LlmError } from '../llm/errors';
import { chapterShortLabel, type TocChapter } from '../manuscript/toc';
import { memoryBlocks } from '../memory/context';
import type { SqliteDatabase } from '../storage/sqlite';
import { recapBlocks, tocChapters } from './context';
import { cleanExpansion, saveExpansion } from './expansion';
import { confirmedNames } from './filters';
import type { CommitResult, PhaseHandler, UnitContext } from './handlers';
import type { PromptBlock, PromptParts } from './prompt';
import { AI_FLAVOR_PROTOCOL, EXPAND_PROTOCOL, INSPIRATION_PROTOCOL } from './protocol';
import { saveOverallReport } from './report';
import { existingIssueKeys, insertIssue, issueKey } from './repo';
import { parseJobOptions } from './rows';
import { NOTHING, chunkTarget, requireChapter } from './unit-kit';

// ---------------------------------------------------------------------------
// AI 味检测：问题都带改写，可以「采纳全部」一键优化
// ---------------------------------------------------------------------------

/** AI 味的 target 最长多少字（一两句话）；改写不超过 max(200, target × 3)。 */
export const AI_FLAVOR_TARGET_MAX_CHARS = 300;
export const aiFlavorRewriteMax = (target: string): number => Math.max(200, target.length * 3);

/**
 * 本地过滤（与 INV-10 同理，模型只报告、本地把关）：改写与原文相同、target 过长、改写过长、
 * 改写丢掉了 target 中出现的设定库专名——都不写入。
 */
export function keepAiFlavorIssue(target: string, replacement: string, names: readonly string[]): boolean {
  if (replacement === target) return false;
  if (target.length > AI_FLAVOR_TARGET_MAX_CHARS || replacement.length > aiFlavorRewriteMax(target)) return false;
  return names.every((n) => [...n].length < 2 || !target.includes(n) || replacement.includes(n));
}

export const aiFlavorMain: PhaseHandler<AiFlavorOutput> = {
  schemaName: 'ai_flavor_issues',
  schema: OUTPUT_SCHEMAS.ai_flavor,
  protocol: AI_FLAVOR_PROTOCOL,
  skill: 'job',
  parts(ctx) {
    const target = chunkTarget(ctx);
    return { setting: nameWhitelistBlocks(entriesInText(ctx.db, target.text)), recap: [], mentions: [], target };
  },
  commit(ctx, output) {
    const c = requireChapter(ctx);
    const seen = existingIssueKeys(ctx.db, ctx.job.id, c.id, c.body, c.bodyHash);
    const names = confirmedNames(ctx.db);
    const range = { start: ctx.unit.range_start, end: ctx.unit.range_end };
    const stats: CommitResult = { ...NOTHING };
    for (const item of output.issues.slice(0, MAX_ISSUES_PER_UNIT)) {
      const hits = locate(c.body, range, item.excerpt, item.target, 'ai_flavor');
      if (hits.length === 0) stats.unanchored++;
      for (const hit of hits) {
        const replacement = normalizeNewlines(item.replacement).trim();
        if (!keepAiFlavorIssue(hit.target, replacement, names)) {
          stats.filtered++;
          continue;
        }
        const key = issueKey(hit.start, hit.end, 'ai_flavor');
        if (seen.has(key)) {
          stats.duplicates++;
          continue;
        }
        seen.add(key);
        insertIssue(ctx.db, {
          id: ctx.newId(),
          job_id: ctx.job.id,
          chapter_id: c.id,
          category: 'ai_flavor',
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

// ---------------------------------------------------------------------------
// 灵感胶囊与智能扩写共用的上下文：作品信息、设定、剧情记忆（可含本章）、前 3 章摘要、上一章结尾
// ---------------------------------------------------------------------------

/** 当前章节已写的部分少于这么多字时，另附上一章结尾作为衔接。 */
export const PREVIOUS_TAIL_WHEN_SHORTER_THAN = 1500;
export const PREVIOUS_TAIL_CHARS = 1200;
/** ③ 最多列出多少个设定条目。 */
const CREATIVE_ENTRIES_MAX = 30;

const clip = (s: string, n: number): string => {
  const t = s.trim();
  return [...t].length <= n ? t : `${[...t].slice(0, n).join('')}…`;
};

function workBlock(db: SqliteDatabase): PromptBlock {
  const w = db.prepare('SELECT title, genre, synopsis FROM work').get() as { title: string; genre: string; synopsis: string } | undefined;
  const lines = [`【作品】《${w?.title ?? ''}》${w !== undefined && w.genre.trim() !== '' ? `（类型：${w.genre.trim()}）` : ''}`];
  if (w !== undefined && w.synopsis.trim() !== '') lines.push(`简介：${clip(w.synopsis, 800)}`);
  return { text: lines.join('\n'), trimmable: false, order: 0 };
}

function previousTailBlock(db: SqliteDatabase, toc: readonly TocChapter[], index: number): PromptBlock[] {
  const bodyOf = db.prepare('SELECT body FROM chapter WHERE id = ?');
  for (let k = index - 1; k >= 0; k--) {
    const c = toc[k] as TocChapter;
    const body = ((bodyOf.get(c.id) as { body: string } | undefined)?.body ?? '').trim();
    if (body === '') continue;
    const tail = body.length > PREVIOUS_TAIL_CHARS ? `…${body.slice(-PREVIOUS_TAIL_CHARS)}` : body;
    return [{ text: `【上一章结尾 · ${chapterShortLabel(c)} ${c.title}】\n${tail}`, trimmable: true, order: toc.length + 1 }];
  }
  return [];
}

/** ⑥ 的标题：卷章、本章已写多少字（只给结尾部分时注明），扩写时加上目标字数。 */
export function creativeHeader(ctx: UnitContext, extra: string): string {
  const c = requireChapter(ctx);
  const written = c.body.trim() === '' ? '本章还没有正文' : ctx.unit.range_start > 0 ? `本章已写 ${c.body.length} 字，以下是结尾部分` : `本章已写 ${c.body.length} 字`;
  return `【第${c.volume.seq + 1}卷 ${c.volume.title} · 第${c.seq + 1}章 ${c.title} · ${written}${extra}】`;
}

function creativeParts(ctx: UnitContext, extra: string): Omit<PromptParts, 'protocol' | 'skillRules'> {
  const c = requireChapter(ctx);
  const toc = tocChapters(ctx.db);
  const index = toc.findIndex((x) => x.id === c.id);
  const text = c.body.slice(ctx.unit.range_start, ctx.unit.range_end);
  const memory = memoryBlocks(ctx.db, c.id, toc, true);
  const previous = c.body.length < PREVIOUS_TAIL_WHEN_SHORTER_THAN ? previousTailBlock(ctx.db, toc, index) : [];
  // 设定条目：本章结尾、剧情记忆与上一章结尾中出现的
  const entries = entriesInText(ctx.db, [text, ...memory.map((b) => b.text), ...previous.map((b) => b.text)].join('\n')).slice(0, CREATIVE_ENTRIES_MAX);
  return {
    setting: [workBlock(ctx.db), ...settingBlocks(ctx.db, entries, c.id, toc)],
    recap: [...memory, ...recapBlocks(ctx.db, c.id, toc), ...previous],
    mentions: [],
    target: { header: creativeHeader(ctx, extra), text: text.trim() === '' ? '（本章还没有正文）' : text },
  };
}

// ---------------------------------------------------------------------------
// 灵感胶囊：五条剧情发展路线，渲染为 Markdown 报告（与审稿报告同一个查看界面）
// ---------------------------------------------------------------------------

const ORDINALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 灵感报告（Markdown）：当前局势、情绪曲线、各条路线（核心设想、剧情走向、张力来源、章末钩子、风险与注意）。 */
export function renderInspiration(o: InspirationOutput, chapterLabel: string): string {
  const routes = o.routes.filter((r) => r.title.trim() !== '' || r.premise.trim() !== '').slice(0, CREATIVE_LIMITS.inspirationRoutes);
  const out = [`## 当前局势`, '', clip(o.situation, 1000), '', `## 情绪曲线`, '', clip(o.emotion, 800), '', `## ${routes.length} 条剧情发展路线（接在${chapterLabel}之后）`];
  routes.forEach((r, i) => {
    out.push('', `### 路线${ORDINALS[i] ?? String(i + 1)}：${clip(r.title, 30)}`, '', `**核心设想**：${clip(r.premise, 400)}`, '', '**剧情走向**：');
    r.beats
      .map((b) => clip(b, 300))
      .filter((b) => b !== '')
      .slice(0, 8)
      .forEach((b, k) => out.push(`${k + 1}. ${b.replace(/\n+/gu, ' ')}`));
    out.push('', `**张力来源**：${clip(r.tension, 400)}`, '', `**章末钩子**：${clip(r.hook, 300)}`, '', `**风险与注意**：${clip(r.risk, 400)}`);
  });
  return out.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

export const inspirationMain: PhaseHandler<InspirationOutput> = {
  schemaName: 'inspiration_routes',
  schema: OUTPUT_SCHEMAS.inspiration,
  protocol: INSPIRATION_PROTOCOL,
  skill: 'job',
  parts: (ctx) => creativeParts(ctx, ' · 构思接下来的剧情'),
  commit(ctx, output) {
    const c = requireChapter(ctx);
    if (output.routes.length === 0) throw new LlmError('invalid_output', 'AI 没有给出剧情路线');
    saveOverallReport(ctx.db, ctx.job.id, renderInspiration(output, `第${c.volume.seq + 1}卷第${c.seq + 1}章《${c.title}》`).slice(0, 50_000));
    return { ...NOTHING, written: Math.min(output.routes.length, CREATIVE_LIMITS.inspirationRoutes) };
  },
};

// ---------------------------------------------------------------------------
// 智能扩写：只根据前文完成当前章节；结果由作者确认后插入章末
// ---------------------------------------------------------------------------

export const targetCharsOf = (ctx: UnitContext): number => parseJobOptions(ctx.job.options).targetChars ?? CREATIVE_LIMITS.expandDefaultChars;

export const expandMain: PhaseHandler<ExpandOutput> = {
  schemaName: 'chapter_expansion',
  schema: OUTPUT_SCHEMAS.expand,
  protocol: EXPAND_PROTOCOL,
  skill: 'job',
  parts: (ctx) => creativeParts(ctx, ` · 续写约 ${targetCharsOf(ctx)} 字`),
  commit(ctx, output) {
    const c = requireChapter(ctx);
    const text = cleanExpansion(output.text, c.body, targetCharsOf(ctx));
    if (text === '') throw new LlmError('invalid_output', 'AI 没有给出可用的续写');
    saveExpansion(ctx.db, { jobId: ctx.job.id, chapterId: c.id, bodyHash: c.bodyHash, text, now: ctx.now });
    return { ...NOTHING, written: 1 };
  },
};
