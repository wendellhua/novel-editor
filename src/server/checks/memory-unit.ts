import { CHUNK_CHARS } from '../../shared/constants';
import { OUTPUT_SCHEMAS, type MemoryOutput } from '../../shared/schemas/outputs';
import type { PlotMemoryState } from '../../shared/types';
import { entriesInText, knownEntryBlocks } from '../bible/context';
import { anchorAt, batchLabel, batchText, measurePending, takeBatch, type Batch } from '../memory/coverage';
import { renderState } from '../memory/context';
import { insertEntry, latestEntry, setCoverage } from '../memory/repo';
import { tocChapters } from './context';
import type { PhaseHandler, UnitContext } from './handlers';
import { MEMORY_PROTOCOL } from './protocol';
import { NOTHING } from './unit-kit';

/** 剧情记忆各字段的长度与条数上限（只防失控输出；协议要求更短）。 */
export const MEMORY_LIMITS = { events: 20, eventChars: 150, mainlineChars: 1200, characters: 30, nameChars: 30, statusChars: 200, threads: 20, threadChars: 200, emotionChars: 400 } as const;

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/gu, ' ').trim();
  return [...t].length <= n ? t : `${[...t].slice(0, n).join('')}…`;
};
const list = (xs: readonly string[], max: number, chars: number): string[] => [...new Set(xs.map((x) => clip(x, chars)).filter((x) => x !== ''))].slice(0, max);

/** 清洗模型输出：去空白、去重、截断。 */
export function cleanMemory(o: MemoryOutput): { events: string[]; state: PlotMemoryState } {
  const seen = new Set<string>();
  const characters: PlotMemoryState['characters'] = [];
  for (const c of o.characters) {
    const name = clip(c.name, MEMORY_LIMITS.nameChars);
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    characters.push({ name, status: clip(c.status, MEMORY_LIMITS.statusChars) });
  }
  return {
    events: list(o.events, MEMORY_LIMITS.events, MEMORY_LIMITS.eventChars),
    state: {
      mainline: clip(o.mainline, MEMORY_LIMITS.mainlineChars),
      characters: characters.slice(0, MEMORY_LIMITS.characters),
      threads: list(o.threads, MEMORY_LIMITS.threads, MEMORY_LIMITS.threadChars),
      emotion: clip(o.emotion, MEMORY_LIMITS.emotionChars),
    },
  };
}

/**
 * 本单元的批次：执行时（而不是创建任务时）按当前正文计算尚未纳入的部分，取前 CHUNK_CHARS.memory 字——
 * 任务创建后作者接着写的内容也能纳入，已纳入的部分永远不会重复发送。结果存在 scratch 里，提交时按它更新进度。
 */
function batchOf(ctx: UnitContext): Batch {
  const cached = ctx.scratch.batch as Batch | undefined;
  if (cached !== undefined) return cached;
  const batch = takeBatch(measurePending(ctx.db, tocChapters(ctx.db)).segments, CHUNK_CHARS.memory);
  ctx.scratch.batch = batch;
  return batch;
}

/**
 * 剧情记忆 main 阶段（ADR-011）：单元之间串行（每次更新基于上一次的结果）。
 * ④ = 当前剧情记忆（最近一次更新后的状态与事件）；③ = 本批次中出现的设定条目（沿用设定库的叫法）；⑥ = 本批次的新正文。
 * 提交：写入一条更新记录（事件 + 新状态快照），并把本批次各章的进度推进到批次末尾。
 */
export const memoryMain: PhaseHandler<MemoryOutput> = {
  schemaName: 'plot_memory',
  schema: OUTPUT_SCHEMAS.memory,
  protocol: MEMORY_PROTOCOL,
  skill: 'job',
  serial: true,
  skip: (ctx) => batchOf(ctx).pieces.length === 0,
  parts(ctx) {
    const batch = batchOf(ctx);
    const text = batchText(batch);
    const last = latestEntry(ctx.db);
    const state = last === null ? '' : renderState(last.state);
    const recap = [{ text: `【当前剧情记忆】\n${state === '' ? '（空：这是第一次建立剧情记忆）' : state}`, trimmable: false, order: 0 }];
    if (last !== null && last.events.length > 0) recap.push({ text: `【上次记录的事件 · ${last.label}】\n${last.events.map((e) => `- ${e}`).join('\n')}`, trimmable: true, order: 1 });
    return {
      setting: knownEntryBlocks(entriesInText(ctx.db, text)),
      recap,
      mentions: [],
      target: { header: `【剧情记忆更新 · ${batchLabel(batch)} · 新增正文约 ${batch.chars} 字】`, text },
    };
  },
  commit(ctx, output) {
    const batch = batchOf(ctx);
    const { events, state } = cleanMemory(output);
    insertEntry(ctx.db, {
      id: ctx.newId(),
      jobId: ctx.job.id,
      chapterIds: [...new Set(batch.pieces.map((p) => p.chapter.id))],
      label: batchLabel(batch),
      chars: batch.chars,
      events,
      state,
      now: ctx.now,
    });
    // 模型调用期间章节可能被彻底删除（清空回收站）：进度表引用 chapter，跳过已不存在的章节
    const exists = ctx.db.prepare('SELECT 1 FROM chapter WHERE id = ?');
    for (const p of batch.pieces) {
      if (exists.get(p.chapter.id) !== undefined) setCoverage(ctx.db, p.chapter.id, { covered: p.end, anchor: anchorAt(p.body, p.end) }, ctx.now);
    }
    return { ...NOTHING, written: 1 };
  },
};
