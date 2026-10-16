import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIBLE_SAMPLE, EXPECTED_ENTRIES } from '../../scripts/lib/bible-sample.ts';
import { targetTextOf } from '../../scripts/lib/mock-typo.ts';
import { ROOT } from '../../scripts/lib/project.ts';
import { TEST_BUILD_DIR } from '../global-setup';
import { completion, startMockLlm, type MockLlm } from '../helpers/mock-llm';
import { makeTempDir } from '../helpers/tmp';

/** 模拟模型：本片段里出现的主要设定各输出一个实体，事实的引文取包含名称的那一句；「林远」带上境界。 */
function mockEntities(text: string): object {
  const sentences = text.split(/(?<=[。！？])/u);
  const kinds: Record<string, string> = { 青云门: 'faction', 青云山: 'location', 玄冰剑: 'item' };
  const entities = EXPECTED_ENTRIES.filter((n) => text.includes(n)).map((name) => {
    const quote = (sentences.find((s) => s.includes(name)) ?? '').trim();
    const facts = [{ attribute: '出场', value: '本章出现', mutable: false, quote }];
    // 本片段结束时的境界：取最后一次提到的
    const realm = [...text.matchAll(/炼气[三九]层|筑基/gu)].at(-1)?.[0];
    if (name === '林远' && realm !== undefined) facts.push({ attribute: '境界', value: realm, mutable: true, quote: (sentences.findLast((s) => s.includes(realm)) ?? '').trim() });
    return { name, kind: kinds[name] ?? 'character', aliases: name === '林远' && text.includes('小林') ? ['小林'] : [], summary: `${name}（模拟）`, facts };
  });
  return { entities };
}

describe('设定抽取样书与 npm run baseline:bible（模拟模型验证脚本本身）', () => {
  let llm: MockLlm;
  let tmp: ReturnType<typeof makeTempDir>;
  beforeAll(async () => {
    tmp = makeTempDir('ne-bible-baseline-');
    llm = await startMockLlm((req) => {
      const user = req.body.messages?.find((m) => m.role === 'user')?.content ?? '';
      if (!user.includes('## 待查正文')) return completion('{"ok":true,"reply":"pong"}');
      return completion(JSON.stringify(mockEntities(targetTextOf(user))));
    });
  });
  afterAll(async () => {
    await llm.close();
    tmp.cleanup();
  });

  it('样书：10 章，每个主要设定都出现在正文中', () => {
    expect(BIBLE_SAMPLE).toHaveLength(10);
    const all = BIBLE_SAMPLE.map((c) => c.body).join('\n');
    for (const n of EXPECTED_ENTRIES) expect(all.includes(n), n).toBe(true);
  });

  it('抽取 → 全部接受（同名合并）→ 主要设定全部入库，事实带章节且引文逐字', async () => {
    const out = join(tmp.dir, 'report.json');
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'scripts', 'bible-baseline.ts')], {
      env: { ...process.env, NE_LLM_BASE_URL: llm.baseUrl, NE_LLM_MODEL: 'mock-bible', NE_LLM_API_KEY: '', NE_SERVER_CJS: join(TEST_BUILD_DIR, 'server.cjs'), NE_BASELINE_OUT: out },
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    expect(code, stdout).toBe(0);
    const report = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    expect(report).toMatchObject({ expected: 7, expectedFound: 7, missing: [], quotesVerbatim: true, failedUnits: 0, entries: 7 });
    expect(report.factsWithChapter).toBe(report.facts);
    expect(report.mergedOnConflict, '同名的新条目跨章节出现时由服务端在本批中合并，无需冲突处理').toBe(0);
    expect(report.linYuanTimeline).toEqual(['境界=炼气三层（第 1 章）', '境界=炼气九层（第 5 章）', '境界=筑基（第 9 章）']);
    expect(stdout).toContain('主要设定命中 7/7');
  }, 60_000);
});
