import { SENTENCE_END_CHARS } from './constants';

export interface TextRange {
  start: number;
  end: number;
}

/** 归一化文本：text[i] 由原文 [starts[i], ends[i]) 范围内的码点产生（UTF-16 偏移）。 */
export interface NormalizedText {
  text: string;
  starts: number[];
  ends: number[];
}

const WHITESPACE = /\s/u;
const SENTENCE_END = new Set(SENTENCE_END_CHARS);

/** 非空白 Unicode 码点数（标点计入），见 §6.4 / INV-3。 */
export function countWords(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (!WHITESPACE.test(ch)) n++;
  }
  return n;
}

/** 将 \r\n 与 \r 统一为 \n（正文写入前必须调用，INV-3）。 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * 按段落边界切块：块首尾相接覆盖全文，每块长度 ≤ maxChars。
 * 段落优先整段放入；超长段落在句末标点后切分；超长句子硬切（不拆代理对）。
 */
export function splitParagraphChunks(body: string, maxChars: number): TextRange[] {
  if (!Number.isInteger(maxChars) || maxChars < 2) {
    throw new RangeError(`maxChars 必须是 ≥ 2 的整数，收到 ${String(maxChars)}`);
  }
  const len = body.length;
  if (len === 0) return [];

  const segments: TextRange[] = [];
  let p = 0;
  while (p < len) {
    const nl = body.indexOf('\n', p);
    const paragraphEnd = nl === -1 ? len : nl + 1;
    if (paragraphEnd - p <= maxChars) {
      segments.push({ start: p, end: paragraphEnd });
    } else {
      splitLongParagraph(body, p, paragraphEnd, maxChars, segments);
    }
    p = paragraphEnd;
  }

  const chunks: TextRange[] = [];
  let current: TextRange | null = null;
  for (const seg of segments) {
    if (current !== null && seg.end - current.start <= maxChars) {
      current.end = seg.end;
    } else {
      if (current !== null) chunks.push(current);
      current = { start: seg.start, end: seg.end };
    }
  }
  if (current !== null) chunks.push(current);
  return chunks;
}

function splitLongParagraph(body: string, start: number, end: number, maxChars: number, out: TextRange[]): void {
  let sentenceStart = start;
  for (let i = start; i < end; i++) {
    const ch = body[i];
    const next = i + 1 < end ? body[i + 1] : undefined;
    const isBoundary = ch !== undefined && SENTENCE_END.has(ch) && (next === undefined || !SENTENCE_END.has(next));
    if (isBoundary) {
      pushHardSplit(body, sentenceStart, i + 1, maxChars, out);
      sentenceStart = i + 1;
    }
  }
  if (sentenceStart < end) pushHardSplit(body, sentenceStart, end, maxChars, out);
}

function pushHardSplit(body: string, start: number, end: number, maxChars: number, out: TextRange[]): void {
  let s = start;
  while (end - s > maxChars) {
    let cut = s + maxChars;
    if (isLowSurrogate(body.charCodeAt(cut)) && isHighSurrogate(body.charCodeAt(cut - 1))) cut -= 1;
    out.push({ start: s, end: cut });
    s = cut;
  }
  if (end > s) out.push({ start: s, end });
}

const PUNCTUATION_MAP: Readonly<Record<string, string>> = {
  '。': '.',
  '、': ',',
  '“': '"',
  '”': '"',
  '「': '"',
  '」': '"',
  '『': '"',
  '』': '"',
  '〝': '"',
  '〞': '"',
  '‘': "'",
  '’': "'",
  '—': '-',
  '–': '-',
  '―': '-',
  '・': '·',
  '•': '·',
  '‧': '·',
  '《': '<',
  '》': '>',
  '〈': '<',
  '〉': '>',
  '【': '[',
  '】': ']',
};

/**
 * 用于容错匹配的归一化：逐码点 NFKC → 统一中英文常见标点 → 删除空白。
 * 返回逐 UTF-16 码元的原文位置映射（见 §6.4、§7.4.3）。
 */
export function normalizeForMatch(source: string): NormalizedText {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < source.length) {
    const cp = source.codePointAt(i) ?? 0;
    const width = cp > 0xffff ? 2 : 1;
    const normalized = source.slice(i, i + width).normalize('NFKC');
    for (const ch of normalized) {
      const mapped = PUNCTUATION_MAP[ch] ?? ch;
      if (WHITESPACE.test(mapped)) continue;
      text += mapped;
      for (let k = 0; k < mapped.length; k++) {
        starts.push(i);
        ends.push(i + width);
      }
    }
    i += width;
  }
  return { text, starts, ends };
}

/** 把归一化文本上的 [a, b) 映射回原文范围。 */
export function toOriginalRange(normalized: NormalizedText, a: number, b: number): TextRange {
  if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b > a && b <= normalized.text.length)) {
    throw new RangeError(`非法范围 [${a}, ${b})，归一化文本长度 ${normalized.text.length}`);
  }
  const start = normalized.starts[a];
  const end = normalized.ends[b - 1];
  if (start === undefined || end === undefined) throw new RangeError('归一化映射缺失');
  return { start, end };
}
