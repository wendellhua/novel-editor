import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from '../../src/web/utils/markdown';

const t = (text: string, bold = false) => ({ text, bold });

describe('简易 Markdown 解析（审稿报告）', () => {
  it('标题、段落、有序与无序列表、加粗', () => {
    const md = '# 总体\n\n## 主要问题\n\n- 第一条 **重点**\n* 第二条\n\n1. 先改开头\n2) 再改结尾\n3、补伏笔\n\n第一行\n第二行\n\n#### 小节 ##';
    expect(parseMarkdown(md)).toEqual([
      { kind: 'heading', level: 1, inlines: [t('总体')] },
      { kind: 'heading', level: 2, inlines: [t('主要问题')] },
      { kind: 'list', ordered: false, items: [[t('第一条 '), t('重点', true)], [t('第二条')]] },
      { kind: 'list', ordered: true, items: [[t('先改开头')], [t('再改结尾')], [t('补伏笔')]] },
      { kind: 'paragraph', inlines: [t('第一行\n第二行')] },
      { kind: 'heading', level: 4, inlines: [t('小节')] },
    ]);
  });

  it('不支持的语法按文字显示：HTML 标签、链接、图片、表格都只是文字；代码围栏与分隔线被去掉', () => {
    const md = '<script>alert(1)</script>\n[链接](javascript:alert(1)) ![图](x.png)\n\n| a | b |\n\n```js\nconst x = 1;\n```\n\n---\n\n<img src=x onerror=alert(1)>';
    const blocks = parseMarkdown(md);
    expect(blocks).toEqual([
      { kind: 'paragraph', inlines: [t('<script>alert(1)</script>\n[链接](javascript:alert(1)) ![图](x.png)')] },
      { kind: 'paragraph', inlines: [t('| a | b |')] },
      { kind: 'paragraph', inlines: [t('const x = 1;')] },
      { kind: 'paragraph', inlines: [t('<img src=x onerror=alert(1)>')] },
    ]);
    // 输出只有三种块、两种行内，没有任何 HTML 字段
    for (const b of blocks) expect(Object.keys(b).sort()).toEqual(b.kind === 'list' ? ['items', 'kind', 'ordered'] : b.kind === 'heading' ? ['inlines', 'kind', 'level'] : ['inlines', 'kind']);
  });

  it('「3.5 万字」不是列表；列表项的缩进续行并入上一项；引用去掉「>」；CRLF 与行尾空白', () => {
    expect(parseMarkdown('3.5 万字的篇幅\r\n')).toEqual([{ kind: 'paragraph', inlines: [t('3.5 万字的篇幅')] }]);
    expect(parseMarkdown('- 第一项\n  续行\n不缩进的新段落')).toEqual([
      { kind: 'list', ordered: false, items: [[t('第一项\n续行')]] },
      { kind: 'paragraph', inlines: [t('不缩进的新段落')] },
    ]);
    expect(parseMarkdown('> 引用的话   ')).toEqual([{ kind: 'paragraph', inlines: [t('引用的话')] }]);
  });

  it('加粗只处理成对的 **，未闭合或空的保持原样', () => {
    expect(parseInline('a **b** c **d')).toEqual([t('a '), t('b', true), t(' c **d')]);
    expect(parseInline('****')).toEqual([t('****')]);
    expect(parseInline('**片段 1/2**')).toEqual([t('片段 1/2', true)]);
  });
});
