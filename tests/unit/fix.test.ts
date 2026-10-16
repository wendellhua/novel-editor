import { describe, expect, it } from 'vitest';
import { cleanReplacement, fixMaxChars, fixMessages } from '../../src/server/checks/fix';
import { FIX_PROTOCOL } from '../../src/server/checks/protocol';
import { findFixProblems } from '../../src/server/static-data';
import { OUTPUT_SCHEMAS } from '../../src/shared/schemas/outputs';

describe('cleanReplacement：整理模型给出的改写', () => {
  const before = '他推开门，';
  const after = '。屋里很暗。';

  it('正常的改写原样保留；与原文相同时为 null；空字符串表示删除', () => {
    expect(cleanReplacement('猛地', '突然', before, after)).toBe('猛地');
    expect(cleanReplacement('突然', '突然', before, after)).toBeNull();
    expect(cleanReplacement('  突然 \n', '突然', before, after)).toBeNull();
    expect(cleanReplacement('', '突然', before, after)).toBe('');
  });

  it('统一换行；target 两端没有空白时去掉两端空白，有空白时保留', () => {
    expect(cleanReplacement('一\r\n二', '一二', '', '')).toBe('一\n二');
    expect(cleanReplacement('  猛地\n', '突然', before, after)).toBe('猛地');
    expect(cleanReplacement('　猛地', '　突然', '', '')).toBe('　猛地');
  });

  it('去掉模型自己加上的成对引号；target 本身以引号开头时保留', () => {
    expect(cleanReplacement('「猛地」', '突然', before, after)).toBe('猛地');
    expect(cleanReplacement('“猛地”', '突然', before, after)).toBe('猛地');
    expect(cleanReplacement('"猛地"', '突然', before, after)).toBe('猛地');
    expect(cleanReplacement('“快走！”', '“走！”', '', '')).toBe('“快走！”');
  });

  it('去掉与前文结尾、后文开头重复的部分（≥ 2 字）', () => {
    expect(cleanReplacement('推开门，猛地', '突然', before, after)).toBe('猛地');
    expect(cleanReplacement('猛地。屋里', '突然', before, after)).toBe('猛地');
    expect(cleanReplacement('他推开门，猛地。屋里很暗。', '突然', before, after)).toBe('猛地');
    expect(cleanReplacement('门，猛地', '突然', before, after), '只重复前文最后两个字「门，」也去掉').toBe('猛地');
  });

  it('单个相同的标点：后文以「。」开头而改写以「。」结尾时去掉；target 自己带这个标点时保留', () => {
    expect(cleanReplacement('猛地停住了。', '突然停下', '', '。他回头。')).toBe('猛地停住了');
    expect(cleanReplacement('猛地停住了。', '突然停下。', '', '他回头。')).toBe('猛地停住了。');
    expect(cleanReplacement('，猛地', '突然', '他说，', '')).toBe('猛地');
  });

  it('target 自身就以前文结尾的字开头时不去掉（重复是原文本来的写法）', () => {
    expect(cleanReplacement('一步步', '一步', '他一步', '')).toBe('一步步');
    expect(cleanReplacement('哈哈大笑', '哈哈', '哈哈', '')).toBe('哈哈大笑');
  });

  it('长度上限：max(200, target × 4)', () => {
    expect(fixMaxChars('突然')).toBe(200);
    expect(fixMaxChars('字'.repeat(100))).toBe(400);
  });
});

describe('fixMessages：修复请求的提示词', () => {
  it('system 是修复协议；user 依次是修改意见（类别、意见、依据）、前文、待修改的原文、后文', () => {
    const [system, user] = fixMessages({ category: 'setting', message: '路程应为三日', evidence: '【落霞镇】路程是三日', target: '半日' }, '只用了', '便赶回');
    expect(system).toEqual({ role: 'system', content: FIX_PROTOCOL });
    expect(user!.content).toBe('## 修改意见\n类别：设定矛盾\n意见：路程应为三日\n依据：【落霞镇】路程是三日\n\n## 前文\n只用了\n\n## 待修改的原文\n半日\n\n## 后文\n便赶回');
  });

  it('没有依据时省略；章节开头、结尾注明没有前文 / 后文', () => {
    const [, user] = fixMessages({ category: 'review', message: '可以更生动', evidence: '', target: '他走了' }, '', '');
    expect(user!.content).not.toContain('依据');
    expect(user!.content).toContain('## 前文\n（无：这处文字在章节开头）');
    expect(user!.content).toContain('## 后文\n（无：这处文字在章节结尾）');
  });
});

describe('findFixProblems：修复协议与 Schema 的静态约束', () => {
  it('仓库中的协议与 Schema 合法', () => {
    expect(findFixProblems()).toEqual([]);
  });

  it('协议缺少「JSON」、超长、Schema 不取自 OUTPUT_SCHEMAS 时报告', () => {
    expect(findFixProblems('只输出对象')).toEqual(['FIX_PROTOCOL 必须出现「JSON」（json_object 档要求）']);
    expect(findFixProblems(FIX_PROTOCOL, OUTPUT_SCHEMAS.fix, 10)[0]).toMatch(/超过 PROMPT_PROTOCOL_MAX_CHARS/);
    expect(findFixProblems(FIX_PROTOCOL, { type: 'object' })).toEqual(['修复的 schema 必须取自 OUTPUT_SCHEMAS']);
  });
});
