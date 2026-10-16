import type { BibleCandidate, BibleEntry, BibleFact, CandidatePayload, EntryKind } from '../../shared/types';

export interface EntryRow {
  id: string;
  kind: EntryKind;
  name: string;
  aliases: string;
  summary: string;
  first_chapter_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface FactRow {
  id: string;
  entry_id: string;
  attribute: string;
  value: string;
  mutable: number;
  chapter_id: string | null;
  quote: string;
  created_at: number;
  updated_at: number;
}

export type CandidateOp = BibleCandidate['op'];

export interface CandidateRow {
  id: string;
  job_id: string;
  op: CandidateOp;
  target_entry_id: string | null;
  payload: string;
  chapter_id: string;
  quote: string;
  status: BibleCandidate['status'];
  created_at: number;
  decided_at: number | null;
}

/** aliases 列是 JSON string[]；损坏或含非字符串时只保留合法的部分。 */
export function parseAliases(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
  } catch {
    return [];
  }
}

export const toEntry = (r: EntryRow): BibleEntry => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  aliases: parseAliases(r.aliases),
  summary: r.summary,
  firstChapterId: r.first_chapter_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const toFact = (r: FactRow): BibleFact => ({
  id: r.id,
  entryId: r.entry_id,
  attribute: r.attribute,
  value: r.value,
  mutable: r.mutable === 1,
  chapterId: r.chapter_id,
  quote: r.quote,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function parsePayload(raw: string): CandidatePayload | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null ? (v as CandidatePayload) : null;
  } catch {
    return null;
  }
}

export const toCandidate = (r: CandidateRow): BibleCandidate => ({
  id: r.id,
  jobId: r.job_id,
  op: r.op,
  targetEntryId: r.target_entry_id,
  payload: parsePayload(r.payload) ?? ({ alias: '' } as CandidatePayload),
  chapterId: r.chapter_id,
  quote: r.quote,
  status: r.status,
  createdAt: r.created_at,
});
