import { describe, expect, it } from 'vitest';
import { applyEdits, isAnchored, locate, mapPosition, reanchor, rebaseAnchor, resolveAnchor, type TextEdit } from '../../src/shared/anchor';
import { normalizeForMatch } from '../../src/shared/text';
import { confirmedNames, filterTypoIssue } from '../../src/server/checks/filters';
import { createRandom, randomText } from '../helpers/random';

/** 码点边界（UTF-16 偏移），用于选取不会拆开代理对的片段。 */
function boundaries(text: string): number[] {
  const out = [0];
  let i = 0;
  for (const ch of text) {
    i += ch.length;
    out.push(i);
  }
  return out;
}

const pick = <T>(rand: () => number, list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
const int = (rand: () => number, lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const isSpace = (s: string): boolean => /^\s/u.test(s) || /\s$/u.test(s);

interface Sample {
  body: string;
  /** target 与 excerpt 在 body 中的范围。 */
  t: { start: number; end: number };
  ex: { start: number; end: number };
  target: string;
  excerpt: string;
}

/** 随机正文 + 随机 target（1～6 个码点，首尾不是空白）+ 包含它的 excerpt（向两侧各扩 0～15 个码点）。 */
function sample(rand: () => number): Sample | null {
  const body = randomText(rand, int(rand, 60, 600));
  const b = boundaries(body);
  const i = int(rand, 0, b.length - 2);
  const j = Math.min(b.length - 1, i + int(rand, 1, 6));
  const t = { start: b[i] as number, end: b[j] as number };
  const target = body.slice(t.start, t.end);
  if (target === '' || isSpace(target)) return null;
  const ex = { start: b[Math.max(0, i - int(rand, 0, 15))] as number, end: b[Math.min(b.length - 1, j + int(rand, 0, 15))] as number };
  return { body, t, ex, target, excerpt: body.slice(ex.start, ex.end) };
}

function* samples(seed: number, n: number): Generator<Sample> {
  const rand = createRandom(seed);
  let made = 0;
  while (made < n) {
    const s = sample(rand);
    if (s === null) continue;
    made++;
    yield s;
  }
}

describe('INV-7 属性测试：锚定结果总是满足 body.slice(start, end) === target', () => {
  it('首次锚定：模型逐字给出 excerpt / target——每个结果逐字一致，且包含真实位置', () => {
    for (const s of samples(7, 400)) {
      const hits = locate(s.body, { start: 0, end: s.body.length }, s.excerpt, s.target, 'typo');
      for (const h of hits) {
        expect(s.body.slice(h.start, h.end)).toBe(h.target);
        expect(h.target).toBe(s.target);
      }
      // §7.4.3 第 3 步：target 取 excerpt 内的第一次出现
      expect(hits.some((h) => h.start === s.ex.start + s.excerpt.indexOf(s.target))).toBe(true);
    }
  });

  it('首次锚定：模型给出归一化后的片段（去空白、全半角与中英文标点统一）——结果仍逐字取自原文', () => {
    let checked = 0;
    for (const s of samples(11, 400)) {
      const modelExcerpt = normalizeForMatch(s.excerpt).text;
      const modelTarget = normalizeForMatch(s.target).text;
      if (modelExcerpt === '' || modelTarget === '') continue;
      checked++;
      const hits = locate(s.body, { start: 0, end: s.body.length }, modelExcerpt, modelTarget, 'punctuation');
      expect(hits.length, JSON.stringify({ modelExcerpt, modelTarget })).toBeGreaterThan(0);
      for (const h of hits) {
        expect(isAnchored(s.body, h)).toBe(true);
        // 映射回原文时按整个码点取（如「…」归一化为三个点），所以原文 target 归一化后包含模型的 target
        expect(normalizeForMatch(h.target).text.includes(modelTarget)).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('重新锚定：在 excerpt 之外插入任意文字后能找到新位置；excerpt 唯一时恰好是平移后的位置', () => {
    const rand = createRandom(23);
    for (const s of samples(23, 400)) {
      const b = boundaries(s.body);
      const outside = b.filter((p) => p <= s.ex.start || p >= s.ex.end);
      const p = pick(rand, outside);
      const ins = randomText(rand, int(rand, 0, 40));
      const body = s.body.slice(0, p) + ins + s.body.slice(p);
      const hit = reanchor(body, { excerpt: s.excerpt, target: s.target, start: s.t.start });
      expect(hit).not.toBeNull();
      expect(isAnchored(body, hit!)).toBe(true);
      expect(body.includes(hit!.excerpt) && hit!.excerpt.includes(s.target)).toBe(true);
      const unique = body.indexOf(s.excerpt) === body.lastIndexOf(s.excerpt) && s.excerpt.indexOf(s.target) === s.excerpt.lastIndexOf(s.target);
      if (unique) expect(hit!.start).toBe(s.t.start + (p <= s.ex.start ? ins.length : 0));
    }
  });

  it('重新锚定：在 excerpt 内（target 之外）加空白、换行后，归一化匹配仍能找到且逐字一致', () => {
    const rand = createRandom(31);
    for (const s of samples(31, 400)) {
      const b = boundaries(s.body).filter((p) => p > s.ex.start && p < s.ex.end && (p <= s.t.start || p >= s.t.end));
      if (b.length === 0) continue;
      const p = pick(rand, b);
      const body = s.body.slice(0, p) + pick(rand, [' ', '\n', '\u3000', '  ']) + s.body.slice(p);
      const hit = reanchor(body, { excerpt: s.excerpt, target: s.target, start: s.t.start });
      if (normalizeForMatch(s.excerpt).text === '') continue;
      expect(hit, JSON.stringify({ excerpt: s.excerpt, target: s.target })).not.toBeNull();
      expect(isAnchored(body, hit!)).toBe(true);
    }
  });

  it('重新锚定：target 被改掉后返回 null 或落在另一处逐字一致的位置（不会返回不一致的位置）', () => {
    for (const s of samples(37, 400)) {
      const body = s.body.slice(0, s.t.start) + '✗' + s.body.slice(s.t.end);
      const hit = reanchor(body, { excerpt: s.excerpt, target: s.target, start: s.t.start });
      if (hit !== null) expect(isAnchored(body, hit)).toBe(true);
    }
  });

  it('修正后平移（F4）：随机替换不与 target 重叠时，平移后的位置逐字一致，excerpt 是新正文的子串且包含 target', () => {
    const rand = createRandom(41);
    for (const s of samples(41, 400)) {
      const b = boundaries(s.body);
      const edits: TextEdit[] = [];
      for (let k = 0; k < int(rand, 1, 4); k++) {
        const i = int(rand, 0, b.length - 2);
        const e = { start: b[i] as number, end: b[Math.min(b.length - 1, i + int(rand, 1, 3))] as number, text: randomText(rand, int(rand, 0, 5)) };
        if (e.start < s.t.end && s.t.start < e.end) continue;
        if (edits.some((x) => e.start < x.end && x.start < e.end)) continue;
        edits.push(e);
      }
      const newBody = applyEdits(s.body, edits);
      const moved = rebaseAnchor(s.body, newBody, edits, { excerpt: s.excerpt, target: s.target, start: s.t.start, end: s.t.end });
      expect(moved).not.toBeNull();
      expect(isAnchored(newBody, moved!)).toBe(true);
      expect(newBody.includes(moved!.excerpt)).toBe(true);
      expect(moved!.excerpt.includes(s.target)).toBe(true);
    }
  });

  it('前端定位 resolveAnchor：位置仍一致时原样返回，否则重新锚定', () => {
    const body = '他在接再厉，终于练成。';
    expect(resolveAnchor(body, { excerpt: '他在接再厉，终于', target: '在接再厉', start: 1, end: 5 })).toEqual({ start: 1, end: 5 });
    expect(resolveAnchor(`前面加字${body}`, { excerpt: '他在接再厉，终于', target: '在接再厉', start: 1, end: 5 })).toMatchObject({ start: 5, end: 9 });
    expect(resolveAnchor('全部改写了', { excerpt: '他在接再厉，终于', target: '在接再厉', start: 1, end: 5 })).toBeNull();
  });
});

describe('替换与位置映射', () => {
  const body = '0123456789';
  const edits: TextEdit[] = [
    { start: 2, end: 4, text: 'ab' },
    { start: 6, end: 7, text: 'XYZ' },
  ];
  it('applyEdits 从后往前替换；重叠时抛错', () => {
    expect(applyEdits(body, edits)).toBe('01ab45XYZ789');
    expect(() => applyEdits(body, [...edits, { start: 3, end: 5, text: '' }])).toThrow(RangeError);
  });
  it('mapPosition：替换之前不动、之后累加长度差、内部按 assoc 落到开头或结尾', () => {
    expect([0, 2, 4, 5, 6, 7, 10].map((p) => mapPosition(p, edits, 1))).toEqual([0, 2, 4, 5, 6, 9, 12]);
    expect(mapPosition(3, edits, -1)).toBe(2);
    expect(mapPosition(3, edits, 1)).toBe(4);
  });
  it('rebaseAnchor：target 与替换重叠时返回 null', () => {
    expect(rebaseAnchor(body, applyEdits(body, edits), edits, { excerpt: '23456', target: '3', start: 3, end: 4 })).toBeNull();
    expect(rebaseAnchor(body, applyEdits(body, edits), edits, { excerpt: '345', target: '5', start: 5, end: 6 })).toEqual({
      start: 5,
      end: 6,
      excerpt: 'ab45',
      target: '5',
    });
  });
});

describe('INV-10：错别字检查结果的本地过滤', () => {
  const body = '林惊羽在接再厉，终于突破了青云门的结界。';
  const item = (p: Partial<Parameters<typeof filterTypoIssue>[0]> = {}) => ({ category: 'typo' as const, target: '在接再厉', replacement: '再接再厉', start: 3, end: 7, ...p });

  it('合格的错别字保留原类别', () => {
    expect(filterTypoIssue(item(), body, [])).toEqual({ keep: true, category: 'typo' });
    expect(filterTypoIssue(item({ category: 'punctuation', target: '，', replacement: ',', start: 7, end: 8 }), body, [])).toEqual({ keep: true, category: 'punctuation' });
  });

  it('① target 与 replacement 相同 → 丢弃（任何类别）', () => {
    expect(filterTypoIssue(item({ replacement: '在接再厉' }), body, [])).toEqual({ keep: false, reason: 'no_change' });
    expect(filterTypoIssue(item({ category: 'grammar', replacement: '在接再厉' }), body, [])).toEqual({ keep: false, reason: 'no_change' });
  });

  it('② target 超过 8 个字 → 改为 grammar；③ 字数差超过 2 → 改为 grammar', () => {
    expect(filterTypoIssue(item({ target: '在接再厉终于突破了青', replacement: '再接再厉终于突破了青' }), body, [])).toEqual({ keep: true, category: 'grammar' });
    expect(filterTypoIssue(item({ target: '在接再厉', replacement: '再接再厉了吧' }), body, [])).toEqual({ keep: true, category: 'typo' });
    expect(filterTypoIssue(item({ target: '在接再厉', replacement: '再接再厉了吧好' }), body, [])).toEqual({ keep: true, category: 'grammar' });
    expect(filterTypoIssue(item({ target: '😀😀😀😀😀😀😀😀', replacement: '好' }), body, []).keep, '按码点计').toBe(true);
    expect(filterTypoIssue(item({ target: '😀😀😀😀', replacement: '好好' }), body, [])).toEqual({ keep: true, category: 'typo' });
  });

  it('④ target 包含设定名称或别名 → 丢弃；落在正文中某个专名内部 → 丢弃；grammar 类不受 ④ 约束', () => {
    expect(filterTypoIssue(item({ target: '林惊羽在', replacement: '林惊雨在', start: 0, end: 4 }), body, ['林惊羽'])).toEqual({ keep: false, reason: 'proper_noun' });
    expect(filterTypoIssue(item({ target: '惊羽', replacement: '惊雨', start: 1, end: 3 }), body, ['林惊羽'])).toEqual({ keep: false, reason: 'proper_noun' });
    expect(filterTypoIssue(item({ target: '云门', replacement: '云山', start: 14, end: 16 }), body, ['青云门'])).toEqual({ keep: false, reason: 'proper_noun' });
    expect(filterTypoIssue(item(), body, ['林惊羽', '青云门']).keep, '与专名相邻但不重叠').toBe(true);
    expect(filterTypoIssue(item({ category: 'grammar', target: '惊羽', replacement: '惊雨', start: 1, end: 3 }), body, ['林惊羽']).keep).toBe(true);
    expect(filterTypoIssue(item({ target: '林', replacement: '木', start: 0, end: 1 }), body, ['林']).keep, '单字专名只按「包含」判断').toBe(false);
    expect(filterTypoIssue(item({ target: '惊', replacement: '京', start: 1, end: 2 }), body, ['林']).keep, '单字专名不做重叠判断').toBe(true);
  });

  it('confirmedNames 读取名称与别名，忽略空值与损坏的别名 JSON', async () => {
    const { openDatabase } = await import('../../src/server/storage/sqlite');
    const db = openDatabase(':memory:');
    db.exec("CREATE TABLE bible_entry (name TEXT, aliases TEXT); INSERT INTO bible_entry VALUES ('林惊羽', '[\"小林\", \"\", 3]'), (' ', '[]'), ('青云门', 'oops')");
    expect(confirmedNames(db).sort()).toEqual(['小林', '林惊羽', '青云门']);
    db.close();
  });
});
