import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { targetTextOf } from '../../scripts/lib/mock-typo.ts';
import { ROOT } from '../../scripts/lib/project.ts';
import { KNOWN_ERRORS, TYPO_SAMPLE, correctedSample, knownErrorRanges } from '../../scripts/lib/typo-sample.ts';
import { TEST_BUILD_DIR } from '../global-setup';
import { completion, startMockLlm, type MockLlm } from '../helpers/mock-llm';
import { makeTempDir } from '../helpers/tmp';

describe('错别字基线样章', () => {
  it('恰好 20 处已知错误，上下文各出现一次、范围互不重叠；全部改正后不再含错误写法', () => {
    const ranges = knownErrorRanges();
    expect(ranges).toHaveLength(20);
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.start).toBeGreaterThanOrEqual(sorted[i - 1]!.end);
    for (const r of ranges) expect(TYPO_SAMPLE.slice(r.start, r.end)).toBe(r.error.wrong);
    const fixed = correctedSample();
    for (const e of KNOWN_ERRORS) {
      expect(fixed.includes(e.context), e.context).toBe(false);
      expect(fixed.includes(e.context.replace(e.wrong, e.right)), e.context).toBe(true);
    }
  });
});

describe('npm run baseline:typo（用「全对 + 1 处误报」的模拟模型验证脚本本身）', () => {
  let llm: MockLlm;
  let tmp: ReturnType<typeof makeTempDir>;
  beforeAll(async () => {
    tmp = makeTempDir('ne-baseline-test-');
    llm = await startMockLlm((req) => {
      const user = req.body.messages?.find((m) => m.role === 'user')?.content ?? '';
      if (!user.includes('## 待查正文')) return completion('{"ok":true,"reply":"pong"}');
      const text = targetTextOf(user);
      const issues = KNOWN_ERRORS.filter((e) => text.includes(e.context)).map((e) => ({
        excerpt: e.context,
        target: e.wrong,
        replacement: e.right,
        category: e.kind,
        severity: 'error',
        message: '已知错误',
      }));
      if (text.includes('演武场中央')) issues.push({ excerpt: '站在了演武场中央', target: '演武', replacement: '练武', category: 'typo', severity: 'warning', message: '误报' });
      return completion(JSON.stringify({ issues }));
    });
  });
  afterAll(async () => {
    await llm.close();
    tmp.cleanup();
  });

  it('输出召回、误报与「采纳全部」后改对的数量', async () => {
    const out = join(tmp.dir, 'report.json');
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'scripts', 'typo-baseline.ts')], {
      env: { ...process.env, NE_LLM_BASE_URL: llm.baseUrl, NE_LLM_MODEL: 'mock-perfect', NE_LLM_API_KEY: '', NE_SERVER_CJS: join(TEST_BUILD_DIR, 'server.cjs'), NE_BASELINE_OUT: out },
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    expect(code, stdout).toBe(0);
    const report = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    expect(report).toMatchObject({ known: 20, recall: 20, falsePositives: 1, correctedAfterApplyAll: 20, fullyCorrect: false, missed: [] });
    expect(report.falsePositiveDetails).toEqual(['演武→练武：误报']);
    expect(stdout).toContain('召回 20/20，误报 1，采纳全部后改对 20/20');
  }, 60_000);
});
