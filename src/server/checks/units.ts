import { CHAPTER_SCOPE_JOB_TYPES, CHUNK_CHARS, RECAP_CHAPTERS } from '../../shared/constants';
import { splitParagraphChunks } from '../../shared/text';
import type { JobType, Scope } from '../../shared/types';
import { missing } from '../errors';
import type { SqliteDatabase } from '../storage/sqlite';
import { chaptersWithValidAnalysis, chaptersWithValidSummary, unchangedSinceLastCheck, type NewUnit } from './repo';

/** 先跑 summary 阶段的任务类型（F3 第 2 步：④ 前情提要需要前几章的摘要）。 */
export const NEEDS_SUMMARY: ReadonlySet<JobType> = new Set(['review', 'setting', 'character', 'inspiration', 'expand']);
/** 最后有 reduce 阶段（汇总整体报告）的任务类型。 */
export const NEEDS_REDUCE: ReadonlySet<JobType> = new Set(['review']);

export interface PlanInput {
  workId: string;
  type: JobType;
  skillId: string;
  scope: Scope;
  onlyChanged: boolean;
}

export interface Plan {
  /** 进入 main 阶段的章节数（已去掉空章与未改动章）。 */
  chapters: number;
  /** main 阶段待查正文的总字符数。 */
  chars: number;
  skippedChapters: number;
  units: NewUnit[];
}

interface LiveChapter {
  id: string;
  volume_id: string;
  body: string;
  body_hash: string;
}

/** 全部未删除章节，按卷序、章序排列（与目录树一致）。 */
function liveChapters(db: SqliteDatabase): LiveChapter[] {
  return db
    .prepare(
      `SELECT c.id, c.volume_id, c.body, c.body_hash FROM chapter c JOIN volume v ON v.id = c.volume_id
       WHERE c.deleted_at IS NULL AND v.deleted_at IS NULL ORDER BY v.seq, v.created_at, c.seq, c.created_at`,
    )
    .all() as unknown as LiveChapter[];
}

/** 把范围展开为章节（F3 第 1 步）；范围不存在或已删除时 404。 */
export function chaptersInScope(db: SqliteDatabase, workId: string, scope: Scope, all: LiveChapter[] = liveChapters(db)): LiveChapter[] {
  if (scope.kind === 'work') {
    if (scope.id !== workId) throw missing('检查范围不存在');
    return all;
  }
  if (scope.kind === 'volume') {
    const vol = db.prepare('SELECT deleted_at FROM volume WHERE id = ?').get(scope.id) as { deleted_at: number | null } | undefined;
    if (vol === undefined || vol.deleted_at !== null) throw missing('检查范围中的分卷不存在');
    return all.filter((c) => c.volume_id === scope.id);
  }
  const hit = all.filter((c) => c.id === scope.id);
  if (hit.length === 0) throw missing('检查范围中的章节不存在');
  return hit;
}

/** 正文切块（§6.4 splitParagraphChunks），chunk_index 从 firstIndex 起连续编号。 */
export function chunkUnits(phase: NewUnit['phase'], chapter: Pick<LiveChapter, 'id' | 'body' | 'body_hash'>, maxChars: number, firstIndex = 0): NewUnit[] {
  return splitParagraphChunks(chapter.body, maxChars).map((r, i) => ({
    phase,
    chapterId: chapter.id,
    chunkIndex: firstIndex + i,
    start: r.start,
    end: r.end,
    bodyHash: chapter.body_hash,
  }));
}

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * 章节结尾的 maxChars 个字（灵感胶囊、智能扩写的 ⑥）：尽量从一个段落的开头取起（起点后半个窗口内有换行时）；
 * 不从代理对中间截断。正文为空时为 [0, 0)。
 */
export function tailRange(body: string, maxChars: number): { start: number; end: number } {
  const end = body.length;
  if (end <= maxChars) return { start: 0, end };
  let start = end - maxChars;
  const nl = body.indexOf('\n', start);
  if (nl >= 0 && nl < end - Math.floor(maxChars / 2)) start = nl + 1;
  if (isLowSurrogate(body.charCodeAt(start))) start++;
  return { start, end };
}

/**
 * 某章 main 阶段的单元：只针对当前章节的类型（灵感胶囊、智能扩写）是结尾的一个单元，其余类型按段落切块。
 * 规划与执行中改稿后的重新切分共用。
 */
export function mainUnitsFor(type: JobType, chapter: Pick<LiveChapter, 'id' | 'body' | 'body_hash'>, firstIndex = 0): NewUnit[] {
  if (CHAPTER_SCOPE_JOB_TYPES.includes(type)) {
    const r = tailRange(chapter.body, CHUNK_CHARS[type]);
    return [{ phase: 'main', chapterId: chapter.id, chunkIndex: firstIndex, start: r.start, end: r.end, bodyHash: chapter.body_hash }];
  }
  return chunkUnits('main', chapter, CHUNK_CHARS[type], firstIndex);
}

/**
 * 生成执行单元（F3 第 2 步）：
 * - summary：NEEDS_SUMMARY 类型才有；为每个 main 章节的前 RECAP_CHAPTERS 章（全书顺序）中缺少有效摘要缓存、正文非空的章节生成；
 * - main：范围内正文非空的章节按 CHUNK_CHARS[type] 切块；勾选 onlyChanged 时跳过上次同类型、同技能检查后未改动的章节；
 *   灵感胶囊、智能扩写（范围只能是一章）只有一个单元，本章正文可以为空（从头写起），但本章与前文不能都没有正文；
 * - reduce：NEEDS_REDUCE 类型且有 main 单元时生成一个（chapter_id 为 ''）。
 */
export function planUnits(db: SqliteDatabase, input: PlanInput): Plan {
  const all = liveChapters(db);
  const inScope = chaptersInScope(db, input.workId, input.scope, all);
  let main: LiveChapter[];
  let skipped: number;
  if (CHAPTER_SCOPE_JOB_TYPES.includes(input.type)) {
    const c = inScope[0] as LiveChapter;
    const before = all.slice(0, all.findIndex((x) => x.id === c.id));
    main = c.body.trim() !== '' || before.some((x) => x.body.trim() !== '') ? [c] : [];
    skipped = 0;
  } else {
    const scoped = inScope.filter((c) => c.body.length > 0);
    const unchanged = input.onlyChanged ? unchangedSinceLastCheck(db, input.type, input.skillId) : new Set<string>();
    // 设定抽取：正文没变、已经完整抽取过的章节不再抽取（F5 第 1 步，chapter_analysis 缓存）
    const extracted = input.type === 'bible_extract' ? chaptersWithValidAnalysis(db, 'bible_extract') : new Set<string>();
    main = scoped.filter((c) => !unchanged.has(c.id) && !extracted.has(c.id));
    skipped = scoped.length - main.length;
  }

  const units: NewUnit[] = [];
  if (NEEDS_SUMMARY.has(input.type) && main.length > 0) {
    const order = new Map(all.map((c, i) => [c.id, i]));
    const cached = chaptersWithValidSummary(db);
    const need = new Set<number>();
    for (const c of main) {
      const i = order.get(c.id) ?? 0;
      for (let k = Math.max(0, i - RECAP_CHAPTERS); k < i; k++) need.add(k);
    }
    for (const i of [...need].sort((a, b) => a - b)) {
      const c = all[i];
      if (c !== undefined && c.body.length > 0 && !cached.has(c.id)) units.push(...chunkUnits('summary', c, CHUNK_CHARS.summary));
    }
  }
  let chars = 0;
  for (const c of main) {
    const mine = mainUnitsFor(input.type, c);
    units.push(...mine);
    // 只针对当前章节的类型只读结尾部分；其余类型读整章
    chars += CHAPTER_SCOPE_JOB_TYPES.includes(input.type) ? mine.reduce((n, u) => n + (u.end - u.start), 0) : c.body.length;
  }
  if (NEEDS_REDUCE.has(input.type) && main.length > 0) {
    units.push({ phase: 'reduce', chapterId: '', chunkIndex: 0, start: 0, end: 0, bodyHash: '' });
  }
  return { chapters: main.length, chars, skippedChapters: skipped, units };
}

/** 剧情记忆任务的单元：count 个不绑定章节的批次（执行时才按当前正文选定内容，见 checks/memory-unit）。 */
export const memoryUnits = (count: number): NewUnit[] =>
  Array.from({ length: Math.max(1, count) }, (_, i) => ({ phase: 'main', chapterId: '', chunkIndex: i, start: 0, end: 0, bodyHash: '' }));
