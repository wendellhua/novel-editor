import { describe, expect, it } from 'vitest';
import { CHUNK_CHARS, SENTENCE_END_CHARS } from '../../src/shared/constants';
import {
  countWords,
  normalizeForMatch,
  normalizeNewlines,
  splitParagraphChunks,
  toOriginalRange,
  type TextRange,
} from '../../src/shared/text';
import { createRandom, randomText } from '../helpers/random';

describe('countWords', () => {
  it.each([
    ['', 0],
    ['你好，世界！', 6],
    ['Hello world', 10],
    ['中文 English\n混排', 11],
    ['\u3000\t\n \u00a0', 0],
    ['👍好', 2],
    ['👨‍👩‍👧', 5],
  ])('%j → %i', (text, expected) => {
    expect(countWords(text)).toBe(expected);
  });
});

describe('normalizeNewlines', () => {
  it('统一 CRLF 与 CR', () => {
    expect(normalizeNewlines('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });
});

function assertChunkInvariants(body: string, chunks: TextRange[], maxChars: number): void {
  if (body.length === 0) {
    expect(chunks).toEqual([]);
    return;
  }
  expect(chunks[0]?.start).toBe(0);
  expect(chunks.at(-1)?.end).toBe(body.length);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    expect(c.end).toBeGreaterThan(c.start);
    expect(c.end - c.start).toBeLessThanOrEqual(maxChars);
    if (i > 0) expect(c.start).toBe(chunks[i - 1]!.end);
    const before = body.charCodeAt(c.start - 1);
    const at = body.charCodeAt(c.start);
    const splitsPair = before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
    expect(splitsPair).toBe(false);
  }
}

describe('splitParagraphChunks', () => {
  it('空正文返回空数组', () => {
    expect(splitParagraphChunks('', 10)).toEqual([]);
  });

  it('maxChars 非法时抛错', () => {
    expect(() => splitParagraphChunks('abc', 1)).toThrow(RangeError);
    expect(() => splitParagraphChunks('abc', 2.5)).toThrow(RangeError);
  });

  it('整段优先：在段落边界打包', () => {
    expect(splitParagraphChunks('aaa\nbbb\nccc\n', 8)).toEqual([
      { start: 0, end: 8 },
      { start: 8, end: 12 },
    ]);
  });

  it('超长段落在句末标点后切分', () => {
    const body = '一二三四五。六七八九十。';
    expect(splitParagraphChunks(body, 7)).toEqual([
      { start: 0, end: 6 },
      { start: 6, end: 12 },
    ]);
  });

  it('连续句末标点作为整体，不在中间切开', () => {
    const body = '他说完了……”好的。';
    const chunks = splitParagraphChunks(body, 8);
    expect(chunks.map((c) => body.slice(c.start, c.end))).toEqual(['他说完了……”', '好的。']);
  });

  it('超长句子硬切且不拆代理对', () => {
    const body = '😀'.repeat(5);
    const chunks = splitParagraphChunks(body, 3);
    expect(chunks.map((c) => c.end - c.start)).toEqual([2, 2, 2, 2, 2]);
    assertChunkInvariants(body, chunks, 3);
  });

  it('属性：随机文本下块首尾相接、覆盖全文、不超上限、不拆代理对', () => {
    const rand = createRandom(20261009);
    for (let round = 0; round < 300; round++) {
      const body = randomText(rand, Math.floor(rand() * 600));
      const maxChars = 2 + Math.floor(rand() * 80);
      assertChunkInvariants(body, splitParagraphChunks(body, maxChars), maxChars);
    }
  });

  it('属性：块内部边界要么在换行后、要么在句末标点后、要么位于超长句子内部（硬切）', () => {
    const rand = createRandom(7);
    const ends = new Set(SENTENCE_END_CHARS);
    for (let round = 0; round < 200; round++) {
      const body = randomText(rand, 50 + Math.floor(rand() * 500));
      const maxChars = 10 + Math.floor(rand() * 60);
      const isBoundaryAt = (i: number): boolean => {
        const prev = body[i - 1] ?? '';
        return prev === '\n' || (ends.has(prev) && !ends.has(body[i] ?? ''));
      };
      for (const c of splitParagraphChunks(body, maxChars).slice(0, -1)) {
        if (isBoundaryAt(c.end)) continue;
        let sentenceStart = c.end - 1;
        while (sentenceStart > 0 && !isBoundaryAt(sentenceStart)) sentenceStart--;
        let sentenceEnd = c.end + 1;
        while (sentenceEnd < body.length && !isBoundaryAt(sentenceEnd)) sentenceEnd++;
        expect(sentenceEnd - sentenceStart).toBeGreaterThan(maxChars);
      }
    }
  });

  it('按 CHUNK_CHARS.typo 切分 3000 字正文', () => {
    const body = `${'字'.repeat(1499)}\n`.repeat(2);
    const chunks = splitParagraphChunks(body, CHUNK_CHARS.typo);
    expect(chunks).toEqual([
      { start: 0, end: 1500 },
      { start: 1500, end: 3000 },
    ]);
  });
});

describe('normalizeForMatch', () => {
  it.each([
    ['你好，世界！', '你好,世界!'],
    ['“他说。”', '"他说."'],
    ['你 好\n\u3000', '你好'],
    ['ＡＢ１', 'AB1'],
    ['《诛仙》【一】', '<诛仙>[一]'],
    ['……', '......'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeForMatch(input).text).toBe(expected);
  });

  it('省略号展开的每个点都映射回同一个原文码点', () => {
    const n = normalizeForMatch('啊…');
    expect(n.starts).toEqual([0, 1, 1, 1]);
    expect(n.ends).toEqual([1, 2, 2, 2]);
  });

  it('toOriginalRange 能把归一化匹配映射回原文', () => {
    const source = '他喊道：“  林惊羽！”';
    const n = normalizeForMatch(source);
    const a = n.text.indexOf('林惊羽!');
    expect(a).toBeGreaterThan(-1);
    const r = toOriginalRange(n, a, a + '林惊羽!'.length);
    expect(source.slice(r.start, r.end)).toBe('林惊羽！');
  });

  it('toOriginalRange 拒绝非法范围', () => {
    const n = normalizeForMatch('abc');
    expect(() => toOriginalRange(n, 2, 2)).toThrow(RangeError);
    expect(() => toOriginalRange(n, 0, 4)).toThrow(RangeError);
  });

  it('属性：映射单调、长度一致、无空白、每个码元可回溯到原文', () => {
    const rand = createRandom(42);
    for (let round = 0; round < 300; round++) {
      const source = randomText(rand, Math.floor(rand() * 200));
      const n = normalizeForMatch(source);
      expect(n.starts.length).toBe(n.text.length);
      expect(n.ends.length).toBe(n.text.length);
      expect(/\s/u.test(n.text)).toBe(false);
      for (let i = 0; i < n.text.length; i++) {
        const s = n.starts[i]!;
        const e = n.ends[i]!;
        expect(e).toBeGreaterThan(s);
        if (i > 0) expect(s).toBeGreaterThanOrEqual(n.starts[i - 1]!);
        expect(normalizeForMatch(source.slice(s, e)).text).toContain(n.text[i]!);
      }
    }
  });
});
