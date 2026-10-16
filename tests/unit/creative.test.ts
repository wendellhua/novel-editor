import { describe, expect, it } from 'vitest';
import { keepAiFlavorIssue, renderInspiration } from '../../src/server/checks/creative';
import { cleanExpansion, joinExpansion } from '../../src/server/checks/expansion';
import { cleanMemory } from '../../src/server/checks/memory-unit';
import { tailRange } from '../../src/server/checks/units';
import { anchorAt, resumePoint, takeBatch, type PendingSegment } from '../../src/server/memory/coverage';
import { renderState } from '../../src/server/memory/context';
import { CREATIVE_LIMITS } from '../../src/shared/constants';

describe('智能扩写：整理续写与插入方式', () => {
  const body = '林远回到山门，看见师姐站在台阶上。';

  it('去掉段首缩进、代码块标记、开头与之后的章节标题（一次只写当前章）、结尾的「未完待续」', () => {
    expect(cleanExpansion('```\n　　他走上台阶。\n  师姐笑了。\n```', body, 2000)).toBe('他走上台阶。\n师姐笑了。');
    expect(cleanExpansion('第三章 风起\n他走上台阶。', body, 2000)).toBe('他走上台阶。');
    expect(cleanExpansion('他走上台阶。\n第四章 夜袭\n夜里有人来了。', body, 2000)).toBe('他走上台阶。');
    expect(cleanExpansion('他走上台阶。（未完待续）', body, 2000)).toBe('他走上台阶。');
  });

  it('前文不用空行分段时合并多余的空行；用空行分段时保留一个空行', () => {
    expect(cleanExpansion('甲。\n\n\n乙。', body, 2000)).toBe('甲。\n乙。');
    expect(cleanExpansion('甲。\n\n\n乙。', '前文。\n\n后文。', 2000)).toBe('甲。\n\n乙。');
  });

  it('去掉与前文结尾重复的开头（≥ 6 字）；篇幅超过目标两倍时在句末截断', () => {
    expect(cleanExpansion('看见师姐站在台阶上。他走过去。', body, 2000)).toBe('他走过去。');
    expect(cleanExpansion('台阶上很冷。', body, 2000), '只重复 3 个字不算').toBe('台阶上很冷。');
    const long = '他走了一步。'.repeat(100);
    const cut = cleanExpansion(long, body, 100);
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(cut.endsWith('。')).toBe(true);
  });

  it('插入：章节为空或以换行结尾时原样；上一句写完时另起一段；没写完时直接接上', () => {
    expect(joinExpansion('', '续写。')).toBe('续写。');
    expect(joinExpansion('前文。\n', '续写。')).toBe('续写。');
    expect(joinExpansion('前文。', '续写。')).toBe('\n续写。');
    expect(joinExpansion('他说：“走吧。”', '续写。')).toBe('\n续写。');
    expect(joinExpansion('他慢慢', '走了过去。')).toBe('走了过去。');
    expect(joinExpansion('前文。', '\n\n续写。')).toBe('\n续写。');
  });

  it('tailRange：短章取全部；长章取结尾，尽量从段落开头起，不从代理对中间截断', () => {
    expect(tailRange('', 10)).toEqual({ start: 0, end: 0 });
    expect(tailRange('一二三', 10)).toEqual({ start: 0, end: 3 });
    const s = `${'甲'.repeat(20)}\n${'乙'.repeat(8)}`;
    expect(tailRange(s, 12)).toEqual({ start: 21, end: 29 });
    expect(tailRange('甲'.repeat(30), 10)).toEqual({ start: 20, end: 30 });
    const astral = `${'甲'.repeat(5)}𠀀${'乙'.repeat(9)}`;
    const r = tailRange(astral, 10);
    expect(astral.slice(r.start, r.end).startsWith('\udc00')).toBe(false);
  });
});

describe('AI 味：本地过滤', () => {
  it('改写与原文相同、过长、target 过长、丢掉专名的不写入；整句删除可以', () => {
    expect(keepAiFlavorIssue('嘴角勾起一抹弧度', '笑了笑', [])).toBe(true);
    expect(keepAiFlavorIssue('嘴角勾起一抹弧度', '', []), '整句删除').toBe(true);
    expect(keepAiFlavorIssue('嘴角勾起一抹弧度', '嘴角勾起一抹弧度', [])).toBe(false);
    expect(keepAiFlavorIssue('字'.repeat(301), '改', [])).toBe(false);
    expect(keepAiFlavorIssue('笑', '改'.repeat(201), [])).toBe(false);
    expect(keepAiFlavorIssue('林远眼中闪过一丝冷意', '他眯起了眼', ['林远']), '丢掉专名').toBe(false);
    expect(keepAiFlavorIssue('林远眼中闪过一丝冷意', '林远眯起了眼', ['林远'])).toBe(true);
  });
});

describe('灵感胶囊：报告渲染', () => {
  it('当前局势、情绪曲线、最多 inspirationRoutes 条路线，节拍为有序列表', () => {
    const route = (title: string) => ({ title, premise: '设想', beats: ['甲', '', '乙'], tension: '张力', hook: '钩子', risk: '风险' });
    const md = renderInspiration({ situation: '局势', emotion: '情绪', routes: ['A', 'B', 'C', 'D', 'E', 'F'].map(route) }, '第1卷第2章《夜袭》');
    expect(md.startsWith('## 当前局势\n\n局势\n\n## 情绪曲线\n\n情绪')).toBe(true);
    expect(md).toContain(`## ${CREATIVE_LIMITS.inspirationRoutes} 条剧情发展路线（接在第1卷第2章《夜袭》之后）`);
    expect(md).toContain('### 路线一：A');
    expect(md).toContain('### 路线五：E');
    expect(md, '多出来的路线不显示').not.toContain('路线六');
    expect(md).toContain('**剧情走向**：\n1. 甲\n2. 乙');
    expect(md).toContain('**风险与注意**：风险');
  });
});

describe('剧情记忆：增量进度与批次', () => {
  it('resumePoint：锚点在原位置时就是 covered；已纳入部分被改长 / 改短时找回锚点；锚点不见时按字数估计', () => {
    const body = `${'甲乙丙丁戊己庚辛壬癸。'.repeat(4)}子丑寅卯辰巳午未申酉。`;
    const covered = 44;
    const rec = { covered, anchor: anchorAt(body, covered) };
    expect(rec.anchor).toHaveLength(32);
    expect(resumePoint(body, undefined)).toBe(0);
    expect(resumePoint(body, rec)).toBe(covered);
    expect(resumePoint(`前言。${body}`, rec), '前面加了字').toBe(covered + 3);
    expect(resumePoint(body.slice(2), rec), '前面删了字（锚点之前）').toBe(covered - 2);
    expect(resumePoint(`${body.slice(0, covered)}插入的新内容。${body.slice(covered)}`, rec), '在接续点之后写的不受影响').toBe(covered);
    expect(resumePoint('完全不同的正文内容，很长很长很长。'.repeat(4), rec), '锚点不见时按字数估计').toBe(covered);
    expect(resumePoint('短', rec), '正文变短').toBe(1);
  });

  it('takeBatch：按目录顺序装满批次；长片段在段落边界截断，余下的留给下一批', () => {
    const chapter = (id: string) => ({ id, rid: 1, title: id, seq: 0, volume: { seq: 0, title: '卷' } });
    const seg = (id: string, body: string, start = 0): PendingSegment => ({ chapter: chapter(id), index: 0, start, end: body.length, body });
    const para = '一二三四五六七八九十。\n';
    const a = seg('a', para.repeat(10));
    const b = seg('b', para.repeat(300));
    const batch = takeBatch([a, b], 2000);
    expect(batch.pieces.map((p) => p.chapter.id)).toEqual(['a', 'b']);
    expect(batch.pieces[0]!.end).toBe(a.body.length);
    expect(batch.chars).toBeLessThanOrEqual(2000);
    expect(batch.pieces[1]!.end).toBeLessThan(b.body.length);
    expect(batch.pieces[1]!.text.endsWith('\n'), '在段落边界截断').toBe(true);
    // 下一批从截断处接着取
    const rest = takeBatch([{ ...b, start: batch.pieces[1]!.end }], 2000);
    expect(rest.pieces[0]!.start).toBe(batch.pieces[1]!.end);
    expect(takeBatch([a, b], 400).pieces.map((p) => p.chapter.id), '剩余空间不足 400 字时不再放入下一章').toEqual(['a']);
  });

  it('cleanMemory：去空白、去重、限长；renderState 跳过空字段', () => {
    const { events, state } = cleanMemory({
      events: [' 事件一 ', '', '事件一', '事件二'],
      mainline: '  主线  ',
      characters: [{ name: '林远', status: '受伤' }, { name: '林远', status: '重复' }, { name: '', status: '无名' }],
      threads: ['伏笔', '伏笔'],
      emotion: '紧张',
    });
    expect(events).toEqual(['事件一', '事件二']);
    expect(state).toEqual({ mainline: '主线', characters: [{ name: '林远', status: '受伤' }], threads: ['伏笔'], emotion: '紧张' });
    expect(renderState(state)).toBe('主线进展：主线\n人物现状：\n- 林远：受伤\n未解决的冲突与伏笔：\n- 伏笔\n情绪走势：紧张');
    expect(renderState({ mainline: '', characters: [], threads: [], emotion: '' })).toBe('');
  });
});
