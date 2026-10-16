/**
 * 审稿报告的简易 Markdown 解析（T15 决策点：不引入渲染库）。
 * 只识别标题、列表（有序 / 无序）、段落与 **加粗**；其余语法按原文显示。
 * 输出是结构化的块，由 MarkdownView 以 Vue 文本节点渲染——全程不拼 HTML 字符串、不用 v-html，
 * 模型输出里的任何标签都只会作为文字出现。
 */
export interface MdInline {
  text: string;
  bold: boolean;
}

export type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; inlines: MdInline[] }
  | { kind: 'list'; ordered: boolean; items: MdInline[][] }
  | { kind: 'paragraph'; inlines: MdInline[] };

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/u;
const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/u;
/** 「1. 」「1) 」后面必须有空白（避免把「3.5 万字」当成列表）；「1、」「1）」可以直接接文字。 */
const ORDERED = /^[ \t]*\d{1,3}(?:[.)][ \t]+|[、）][ \t]*)(.*)$/u;
const FENCE = /^[ \t]*(```|~~~)/u;
const RULE = /^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/u;
const QUOTE = /^[ \t]*>[ \t]?(.*)$/u;

/** 行内：只处理成对的 **加粗**，其余原样保留。 */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  // 加粗内容不跨行、不含「**」、首尾不是「*」
  const re = /\*\*([^*\n]+(?:\*[^*\n]+)*)\*\*/gu;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false });
    out.push({ text: m[1] ?? '', bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out.filter((x) => x.text !== '');
}

export function parseMarkdown(source: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const closeParagraph = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  const closeList = (): void => {
    if (list !== null) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map(parseInline) });
    list = null;
  };
  const closeAll = (): void => {
    closeParagraph();
    closeList();
  };
  const addItem = (ordered: boolean, text: string): void => {
    closeParagraph();
    if (list === null || list.ordered !== ordered) {
      closeList();
      list = { ordered, items: [] };
    }
    list.items.push(text.trim());
  };

  for (const raw of source.replace(/\r\n?/gu, '\n').split('\n')) {
    const line = raw.replace(/[ \t]+$/u, '');
    if (line.trim() === '' || FENCE.test(line)) {
      closeAll();
      continue;
    }
    if (RULE.test(line)) {
      closeAll();
      continue;
    }
    const h = HEADING.exec(line);
    if (h !== null) {
      closeAll();
      const level = Math.min(4, (h[1] ?? '#').length) as 1 | 2 | 3 | 4;
      blocks.push({ kind: 'heading', level, inlines: parseInline(h[2] ?? '') });
      continue;
    }
    const b = BULLET.exec(line);
    if (b !== null) {
      addItem(false, b[1] ?? '');
      continue;
    }
    const o = ORDERED.exec(line);
    if (o !== null && (o[1] ?? '') !== '') {
      addItem(true, o[1] ?? '');
      continue;
    }
    const q = QUOTE.exec(line);
    const text = q !== null ? (q[1] ?? '') : line.trim();
    // 列表项下缩进的续行并入上一项
    const current = list as { ordered: boolean; items: string[] } | null;
    if (current !== null && /^[ \t]+/u.test(raw) && paragraph.length === 0) {
      current.items[current.items.length - 1] = `${current.items.at(-1) ?? ''}\n${text}`;
      continue;
    }
    closeList();
    paragraph.push(text);
  }
  closeAll();
  return blocks;
}
