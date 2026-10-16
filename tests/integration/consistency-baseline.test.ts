import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSISTENCY_SAMPLE, CONTRADICTIONS, REASONABLE, SEED, locateMarker } from '../../scripts/lib/consistency-sample.ts';
import { taskOf } from '../../scripts/lib/mock-review.ts';
import { targetTextOf } from '../../scripts/lib/mock-typo.ts';
import { ROOT } from '../../scripts/lib/project.ts';
import { TEST_BUILD_DIR } from '../global-setup';
import { completion, startMockLlm, type MockLlm } from '../helpers/mock-llm';
import { makeTempDir } from '../helpers/tmp';

const around = (text: string, target: string): string => {
  const i = text.indexOf(target);
  return text.slice(Math.max(0, i - 5), Math.min(text.length, i + target.length + 5));
};
const issue = (text: string, target: string) => ({ excerpt: around(text, target), target, replacement: null, severity: 'error', entryName: '', evidence: '依据', message: '矛盾' });

describe('一致性基线样书', () => {
  it('6 处矛盾与 3 处合理变化的上下文各出现一次；设定库种子的引文都是对应章节的原文', () => {
    expect(CONTRADICTIONS).toHaveLength(6);
    expect(REASONABLE).toHaveLength(3);
    for (const m of [...CONTRADICTIONS, ...REASONABLE]) expect(() => locateMarker(m), m.id).not.toThrow();
    for (const e of SEED) for (const f of e.facts) expect(CONSISTENCY_SAMPLE[f.chapter]!.body.includes(f.quote), `${e.name} ${f.quote}`).toBe(true);
  });
});

describe('npm run baseline:consistency（模拟模型验证脚本本身）', () => {
  let llm: MockLlm;
  let tmp: ReturnType<typeof makeTempDir>;
  beforeAll(async () => {
    tmp = makeTempDir('ne-consistency-baseline-');
    llm = await startMockLlm((req) => {
      const user = req.body.messages?.find((m) => m.role === 'user')?.content ?? '';
      if (!user.includes('## 待查正文')) return completion('{"ok":true,"reply":"pong"}');
      const text = targetTextOf(user);
      const task = taskOf(req.body);
      if (task === 'summary') return completion(JSON.stringify({ summary: text.slice(0, 20) }));
      const found = (targets: string[]) => targets.filter((t) => text.includes(t)).map((t) => issue(text, t));
      if (task === 'setting') return completion(JSON.stringify({ issues: found(['半日', '走进藏经阁', '长剑', '炼气五层', ...(text.includes('终于突破到炼气九层') ? ['炼气九层'] : [])]) }));
      if (task === 'character') return completion(JSON.stringify({ issues: found(['湛蓝', '林师兄']) }));
      // 错别字检查：没有专名白名单时把「苏晴」当成错字
      const typos = text.includes('苏晴') && !user.includes('一律视为正确写法') ? [{ excerpt: around(text, '苏晴'), target: '苏晴', replacement: '苏青', category: 'typo', severity: 'warning', message: '疑似错字' }] : [];
      return completion(JSON.stringify({ issues: typos }));
    });
  });
  afterAll(async () => {
    await llm.close();
    tmp.cleanup();
  });

  it('输出检出数、合理变化误报数，以及白名单开 / 关时的专名误报', async () => {
    const out = join(tmp.dir, 'report.json');
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'scripts', 'consistency-baseline.ts')], {
      env: { ...process.env, NE_LLM_BASE_URL: llm.baseUrl, NE_LLM_MODEL: 'mock-consistency', NE_LLM_API_KEY: '', NE_SERVER_CJS: join(TEST_BUILD_DIR, 'server.cjs'), NE_BASELINE_OUT: out },
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    expect(code, stdout).toBe(0);
    const report = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown> & { typoWhitelist: { off: { properNoun: number }; on: { properNoun: number } } };
    expect(report).toMatchObject({ contradictions: 6, detected: 6, missed: [], reasonableChanges: 3, reasonableFlagged: 1, otherIssues: 0 });
    // 苏晴出现在第 2、4、6、8 章：关闭白名单时每处都被误判，开启后（提示词白名单 + 本地专名过滤）一条都没有
    expect(report.typoWhitelist.off.properNoun).toBeGreaterThanOrEqual(4);
    expect(report.typoWhitelist.on.properNoun).toBe(0);
    expect(stdout).toContain('检出矛盾 6/6，合理变化被误报 1/3');
  }, 90_000);
});
