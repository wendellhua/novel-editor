/**
 * 模拟「错别字检查」模型（测试与冒烟共用）：从提示词的「## 待查正文」里找出词表中的错误写法，
 * 按 §7.4.2 TypoOutput 返回逐字 excerpt。不依赖任何外部服务。
 */
export const MOCK_TYPOS: Readonly<Record<string, string>> = {
  在接再厉: '再接再厉',
  迫不急待: '迫不及待',
  一但: '一旦',
};

/** 取出 user 消息中「## 待查正文」之后、去掉片段标题行的正文。 */
export function targetTextOf(userContent: string): string {
  const i = userContent.indexOf('## 待查正文');
  if (i < 0) return '';
  const rest = userContent.slice(i).split('\n').slice(3);
  return rest.join('\n');
}

export interface MockTypoIssue {
  excerpt: string;
  target: string;
  replacement: string;
  category: 'typo';
  severity: 'error';
  message: string;
}

export function findMockTypos(text: string): MockTypoIssue[] {
  const out: MockTypoIssue[] = [];
  for (const [wrong, right] of Object.entries(MOCK_TYPOS)) {
    for (let i = text.indexOf(wrong); i >= 0; i = text.indexOf(wrong, i + wrong.length)) {
      const start = Math.max(0, i - 4);
      const end = Math.min(text.length, i + wrong.length + 4);
      out.push({ excerpt: text.slice(start, end), target: wrong, replacement: right, category: 'typo', severity: 'error', message: `「${right}」误作「${wrong}」` });
    }
  }
  return out;
}

/** 根据 chat/completions 请求体生成 TypoOutput JSON 字符串。 */
export function mockTypoContent(body: { messages?: { role: string; content: string }[] }): string {
  const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
  return JSON.stringify({ issues: findMockTypos(targetTextOf(user)) });
}
