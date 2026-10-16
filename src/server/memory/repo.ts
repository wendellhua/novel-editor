import type { PlotMemoryEntry, PlotMemoryState } from '../../shared/types';
import type { SqliteDatabase } from '../storage/sqlite';

/** plot_memory_entry 行（ADR-011）：一次增量更新。 */
export interface EntryRow {
  id: string;
  seq: number;
  job_id: string;
  chapter_ids: string;
  label: string;
  chars: number;
  events: string;
  state: string;
  created_at: number;
}

/** 解析后的一次更新：本次纳入的章节、事件与更新后的全书状态快照。 */
export interface MemoryEntry {
  id: string;
  seq: number;
  chapterIds: string[];
  label: string;
  chars: number;
  events: string[];
  state: PlotMemoryState;
  createdAt: number;
}

const EMPTY_STATE: PlotMemoryState = { mainline: '', characters: [], threads: [], emotion: '' };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** 解析状态快照；损坏时按空状态处理（下一次更新会重新建立）。 */
export function parseState(raw: string): PlotMemoryState {
  const v = parseJson(raw);
  if (typeof v !== 'object' || v === null) return { ...EMPTY_STATE };
  const o = v as Record<string, unknown>;
  const characters = Array.isArray(o.characters)
    ? o.characters
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
        .map((c) => ({ name: typeof c.name === 'string' ? c.name : '', status: typeof c.status === 'string' ? c.status : '' }))
        .filter((c) => c.name !== '')
    : [];
  return {
    mainline: typeof o.mainline === 'string' ? o.mainline : '',
    characters,
    threads: strings(o.threads),
    emotion: typeof o.emotion === 'string' ? o.emotion : '',
  };
}

export function toEntry(r: EntryRow): MemoryEntry {
  return {
    id: r.id,
    seq: r.seq,
    chapterIds: strings(parseJson(r.chapter_ids)),
    label: r.label,
    chars: r.chars,
    events: strings(parseJson(r.events)),
    state: parseState(r.state),
    createdAt: r.created_at,
  };
}

export const toEntryDto = (e: MemoryEntry): PlotMemoryEntry => ({ id: e.id, seq: e.seq, label: e.label, chars: e.chars, events: e.events, createdAt: e.createdAt });

/** 全部更新，按写入顺序（seq 递增）。 */
export function listEntries(db: SqliteDatabase): MemoryEntry[] {
  return (db.prepare('SELECT * FROM plot_memory_entry ORDER BY seq').all() as unknown as EntryRow[]).map(toEntry);
}

export function latestEntry(db: SqliteDatabase): MemoryEntry | null {
  const r = db.prepare('SELECT * FROM plot_memory_entry ORDER BY seq DESC LIMIT 1').get() as EntryRow | undefined;
  return r === undefined ? null : toEntry(r);
}

export function insertEntry(
  db: SqliteDatabase,
  e: { id: string; jobId: string; chapterIds: string[]; label: string; chars: number; events: string[]; state: PlotMemoryState; now: number },
): number {
  const seq = ((db.prepare('SELECT max(seq) AS m FROM plot_memory_entry').get() as { m: number | null }).m ?? 0) + 1;
  db.prepare(
    'INSERT INTO plot_memory_entry (id, seq, job_id, chapter_ids, label, chars, events, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(e.id, seq, e.jobId, JSON.stringify(e.chapterIds), e.label, e.chars, JSON.stringify(e.events), JSON.stringify(e.state), e.now);
  return seq;
}

/** 每章已纳入剧情记忆的进度：covered 之前的正文已记录，anchor 为已纳入部分末尾的原文。 */
export interface Coverage {
  covered: number;
  anchor: string;
}

export function coverageMap(db: SqliteDatabase): Map<string, Coverage> {
  const rows = db.prepare('SELECT chapter_id AS id, covered_chars AS covered, anchor FROM plot_memory_chapter').all() as { id: string; covered: number; anchor: string }[];
  return new Map(rows.map((r) => [r.id, { covered: r.covered, anchor: r.anchor }]));
}

export function setCoverage(db: SqliteDatabase, chapterId: string, c: Coverage, now: number): void {
  db.prepare(
    `INSERT INTO plot_memory_chapter (chapter_id, covered_chars, anchor, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (chapter_id) DO UPDATE SET covered_chars = excluded.covered_chars, anchor = excluded.anchor, updated_at = excluded.updated_at`,
  ).run(chapterId, c.covered, c.anchor, now);
}

/** 重建剧情记忆：清空全部记录与进度。 */
export function clearMemory(db: SqliteDatabase): void {
  db.exec('DELETE FROM plot_memory_entry; DELETE FROM plot_memory_chapter;');
}
