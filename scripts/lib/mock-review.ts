import { mockTypoContent, targetTextOf } from './mock-typo.ts';

/**
 * 模拟「编辑审稿」相关的模型（测试与冒烟共用）：按 system 消息开头的编辑器协议（§7.4.1 ①）判断阶段——
 * 章节摘要、审稿逐片段意见、审稿汇总；其余按错别字检查处理。输出都可预测，便于断言。
 */
export type MockTask =
  | 'summary'
  | 'review'
  | 'review_reduce'
  | 'extract'
  | 'setting'
  | 'character'
  | 'fix'
  | 'ai_flavor'
  | 'inspiration'
  | 'expand'
  | 'memory'
  | 'typo';

/** 各段协议的第一句（与 src/server/checks/protocol.ts 一致；测试会校验）。 */
export const PROTOCOL_OPENINGS: Readonly<Record<Exclude<MockTask, 'typo'>, string>> = {
  summary: '你是一名小说编辑助理，负责为章节写摘要',
  review: '你是一名网络小说责任编辑，负责审读章节',
  review_reduce: '你是一名网络小说主编，负责根据各章的审稿意见写出整体审稿报告',
  extract: '你是一名小说设定整理员，负责从章节中抽取设定条目与事实',
  setting: '你是一名小说设定校对，负责对照设定库与前文检查设定是否前后矛盾',
  character: '你是一名小说人物设定校对，负责对照设定库与前文检查角色是否前后一致',
  fix: '你是一名小说修改编辑，负责按照修改意见改写正文中的一处文字',
  ai_flavor: '你是一名资深中文小说编辑，负责找出正文中「AI 味」明显的表达',
  inspiration: '你是一名资深网络小说策划编辑，负责根据作品设定、剧情记忆与当前剧情',
  expand: '你是一名网络小说写手，负责根据前文续写当前章节',
  memory: '你是一名小说编辑助理，负责维护作品的「剧情记忆」',
};

/** 模拟 AI 味检测：出现即报告，并给出改写。 */
export const MOCK_AI_FLAVOR: readonly { text: string; replacement: string }[] = [
  { text: '嘴角勾起一抹弧度', replacement: '笑了笑' },
  { text: '眼中闪过一丝冷意', replacement: '眯起了眼' },
];

function mockAiFlavor(text: string): { issues: object[] } {
  const issues = [];
  for (const p of MOCK_AI_FLAVOR) {
    const at = text.indexOf(p.text);
    if (at < 0) continue;
    const excerpt = text.slice(Math.max(0, at - 4), Math.min(text.length, at + p.text.length + 4));
    issues.push({ excerpt, target: p.text, replacement: p.replacement, severity: 'warning', message: '神态套话，AI 味明显' });
  }
  return { issues };
}

/** 模拟灵感胶囊：五条路线；局势里注明是否读到了剧情记忆（据此验证剧情记忆接入了 ④）。 */
export function mockInspiration(user: string): object {
  const memory = user.includes('【剧情记忆') ? '（已参考剧情记忆）' : '（没有剧情记忆）';
  return {
    situation: `当前局势${memory}：林远刚刚回到山门。`,
    emotion: '最近三章持续紧张，需要一次小的释放后再升级冲突。',
    routes: ['宗门危机', '师姐的秘密', '旧敌来访', '两难抉择', '玉佩之谜'].map((title, i) => ({
      title,
      premise: `第 ${i + 1} 条路线的核心设想`,
      beats: ['节拍一', '节拍二', '节拍三'],
      tension: '目标、阻碍与代价',
      hook: '章末悬念',
      risk: '注意与设定一致',
    })),
  };
}

/** 模拟智能扩写的续写正文。 */
export const MOCK_EXPANSION = '远处传来一声钟响，林远停下了脚步。\n他回头望去，山门前空无一人。';

/** user 消息中「当前剧情记忆」里的主线（mock 剧情记忆把它接着往下写，用于验证状态是逐次累积的）。 */
const previousMainline = (user: string): string => /主线进展：(.*)/u.exec(user)?.[1]?.trim() ?? '';

/** 模拟剧情记忆：事件取本批次正文中带【E…】标记的句子；主线在上一次的基础上追加本批次的首尾标记（如「【E1】～【E39】→【E200】～【E260】」）。 */
export function mockMemory(user: string, text: string): object {
  const events = [...text.matchAll(/【E\d+】[^。\n]*/gu)].map((m) => m[0]);
  const marks = [...text.matchAll(/【E\d+】/gu)].map((m) => m[0]);
  const prev = previousMainline(user);
  const added = marks.length > 0 ? `${marks[0]}～${marks.at(-1)}` : '（无标记事件）';
  return {
    events: events.slice(0, 15),
    mainline: prev === '' ? added : `${prev}→${added}`,
    characters: [{ name: '林远', status: `最近：${events.at(-1) ?? '无'}` }],
    threads: ['玉佩的来历'],
    emotion: '紧张',
  };
}

/** 模拟 AI 修复的改写：表中的写法按表改，其余在原文后加「（已改）」。 */
export const MOCK_FIXES: Readonly<Record<string, string>> = { 突然: '猛然间' };

/** user 消息中「## 标题」小节的内容。 */
export function sectionOf(user: string, title: string): string {
  const i = user.indexOf(`## ${title}\n`);
  if (i < 0) return '';
  const rest = user.slice(i + title.length + 4);
  const j = rest.indexOf('\n\n## ');
  return j < 0 ? rest : rest.slice(0, j);
}

export function mockFix(user: string): { replacement: string } {
  const target = sectionOf(user, '待修改的原文');
  return { replacement: MOCK_FIXES[target] ?? `${target}（已改）` };
}

/**
 * 模拟一致性检查会发现的矛盾：正文出现 text，且「设定上下文」里列出了 entryName 这个条目时才报告
 * （据此验证 ③ 确实接进了提示词）。
 */
export const MOCK_CONSISTENCY: readonly {
  task: 'setting' | 'character';
  text: string;
  replacement: string | null;
  entryName: string;
  evidence: string;
}[] = [
  { task: 'setting', text: '半日', replacement: '三日', entryName: '落霞镇', evidence: '青云山到落霞镇的路程是三日' },
  { task: 'character', text: '苏师妹', replacement: '师姐', entryName: '苏晴', evidence: '苏晴是林远的师姐' },
];

function mockConsistency(task: 'setting' | 'character', user: string, text: string): { issues: object[] } {
  const i = user.indexOf('## 设定上下文');
  const setting = i < 0 ? '' : user.slice(i, user.indexOf('## 待查正文'));
  const issues = [];
  for (const p of MOCK_CONSISTENCY) {
    const at = text.indexOf(p.text);
    if (p.task !== task || at < 0 || !setting.includes(`】${p.entryName}`)) continue;
    const excerpt = text.slice(Math.max(0, at - 6), Math.min(text.length, at + p.text.length + 6));
    issues.push({ excerpt, target: p.text, replacement: p.replacement, severity: 'error', entryName: p.entryName, evidence: p.evidence, message: `与设定「${p.evidence}」矛盾` });
  }
  return { issues };
}

/** 模拟抽取中会随剧情变化的属性。 */
const MUTABLE_ATTRIBUTES = new Set(['境界', '位置', '伤势', '持有', '职务']);

const kindOfName = (name: string): string =>
  /[门宗派帮会]$/u.test(name) ? 'faction' : /[山城谷峰岛殿]$/u.test(name) ? 'location' : /[剑刀鼎珠丹]$/u.test(name) ? 'item' : 'character';

/**
 * 模拟设定抽取：按固定句式从正文中取设定——「X的属性是值。」成为 X 的一条事实（引文就是这句话），
 * 「X又名Y。」成为 X 的别名。同一实体合并输出。
 */
export function mockExtract(text: string): { entities: object[] } {
  const byName = new Map<string, { name: string; kind: string; aliases: string[]; summary: string; facts: object[] }>();
  const entity = (name: string) => {
    let e = byName.get(name);
    if (e === undefined) {
      e = { name, kind: kindOfName(name), aliases: [], summary: `${name}（模拟抽取）`, facts: [] };
      byName.set(name, e);
    }
    return e;
  };
  // 名称前面不能紧挨着汉字（句首、标点或换行之后），避免把「他发现林远」当成名称
  for (const m of text.matchAll(/(?<!\p{Script=Han})([\p{Script=Han}]{2,6}?)的([\p{Script=Han}]{1,4})是([^。，\n]{1,20})。/gu)) {
    const attribute = m[2] ?? '';
    entity(m[1] ?? '').facts.push({ attribute, value: m[3] ?? '', mutable: MUTABLE_ATTRIBUTES.has(attribute), quote: m[0] });
  }
  for (const m of text.matchAll(/(?<!\p{Script=Han})([\p{Script=Han}]{2,6}?)又名([\p{Script=Han}]{2,6})。/gu)) entity(m[1] ?? '').aliases.push(m[2] ?? '');
  return { entities: [...byName.values()] };
}

type Body = { messages?: { role: string; content: string }[] };

export function taskOf(body: Body): MockTask {
  const system = body.messages?.find((m) => m.role === 'system')?.content ?? '';
  for (const [task, opening] of Object.entries(PROTOCOL_OPENINGS) as [Exclude<MockTask, 'typo'>, string][]) {
    if (system.startsWith(opening)) return task;
  }
  return 'typo';
}

const userOf = (body: Body): string => body.messages?.find((m) => m.role === 'user')?.content ?? '';

/** ⑥ 的片段标题行（如「【第1卷 正文 · 第2章 夜袭 · 片段 1/1】」）。 */
export function headerOf(userContent: string): string {
  const i = userContent.indexOf('## 待查正文');
  return i < 0 ? '' : (userContent.slice(i).split('\n')[2] ?? '');
}

/** 审稿时会被指出的写法：出现即报告一条意见（「非常非常」可一键改为「非常」）。 */
export const MOCK_REVIEW_PATTERNS: readonly { text: string; replacement: string | null; severity: 'warning' | 'info'; message: string }[] = [
  { text: '非常非常', replacement: '非常', severity: 'warning', message: '叠用「非常」显得啰嗦，保留一个即可' },
  { text: '突然', replacement: null, severity: 'info', message: '「突然」用得偏多，可以用动作本身制造意外感' },
];

export interface MockReviewOptions {
  /** 评语的附加内容（测试用来制造很长的评语）。 */
  commentPadding?: string;
  /** 为 true 时不报告任何意见、评语为空。 */
  silent?: boolean;
}

/** 根据 chat/completions 请求体生成对应阶段的输出 JSON 字符串。 */
export function mockReviewContent(body: Body, options: MockReviewOptions = {}): string {
  const user = userOf(body);
  const header = headerOf(user);
  const text = targetTextOf(user);
  switch (taskOf(body)) {
    case 'summary':
      return JSON.stringify({ summary: `摘要：${text.replace(/\s+/gu, '').slice(0, 24)}` });
    case 'review': {
      if (options.silent === true) return JSON.stringify({ issues: [], comment: '' });
      const issues = [];
      for (const p of MOCK_REVIEW_PATTERNS) {
        const i = text.indexOf(p.text);
        if (i < 0) continue;
        const excerpt = text.slice(Math.max(0, i - 4), Math.min(text.length, i + p.text.length + 4));
        issues.push({ excerpt, target: p.text, replacement: p.replacement, severity: p.severity, message: p.message });
      }
      return JSON.stringify({ issues, comment: `评语：${header} 本片段冲突清楚，结尾的悬念可以再强一些。${options.commentPadding ?? ''}` });
    }
    case 'extract':
      return JSON.stringify(mockExtract(text));
    case 'fix':
      return JSON.stringify(mockFix(user));
    case 'ai_flavor':
      return JSON.stringify(mockAiFlavor(text));
    case 'inspiration':
      return JSON.stringify(mockInspiration(user));
    case 'expand':
      return JSON.stringify({ text: MOCK_EXPANSION });
    case 'memory':
      return JSON.stringify(mockMemory(user, text));
    case 'setting':
    case 'character':
      return JSON.stringify(mockConsistency(taskOf(body) as 'setting' | 'character', user, text));
    case 'review_reduce': {
      const chapters = text.split('\n').filter((l) => l.startsWith('### ')).length;
      return JSON.stringify({
        report: `## 总体评价\n\n共审读 ${chapters} 章，主线推进清楚，**节奏**整体紧凑。\n\n## 最需要优先解决的问题\n\n- 部分章节「突然」用得偏多\n- 章末悬念偏弱\n\n## 具体修改建议\n\n1. 用动作制造意外感\n2. 每章结尾留一个具体的期待点`,
      });
    }
    default:
      return mockTypoContent(body);
  }
}
