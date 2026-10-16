import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROOT } from '../../scripts/lib/project.ts';
import { LIMITS, TASK_KINDS } from '../../src/shared/constants';
import { createAssetReader } from '../../src/server/assets';
import { DomainError } from '../../src/server/errors';
import { Skills, localSlug } from '../../src/server/skills';
import { findManifestProblems, loadBuiltinSkills } from '../../src/server/skills/builtin';
import { HubError, SkillInvalidError } from '../../src/server/skills/errors';
import { HubClient } from '../../src/server/skills/hub-client';
import { buildPackage, packageFromFiles, packageFromZip } from '../../src/server/skills/importer';
import { parseSkillMd } from '../../src/server/skills/parser';
import { buildSkillRules } from '../../src/server/skills/prompt';
import { sanitizeRegistry } from '../../src/server/skills/registry';
import { readZip, type ZipLimits } from '../../src/server/skills/zip';
import { createSilentLogger } from '../../src/server/system/logger';
import { HUB_SKILL, startMockHub, type MockHub } from '../helpers/mock-hub';
import { makeTempDir } from '../helpers/tmp';
import { makeZip, skillMd } from '../helpers/zip';

const LIM: ZipLimits = { maxZipBytes: LIMITS.skillZipMaxBytes, maxUnpackedBytes: LIMITS.skillUnpackedMaxBytes, maxFiles: LIMITS.skillMaxFiles };

function invalid(fn: () => unknown, msg: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, `应当抛出 SkillInvalidError（${String(msg)}）`).toBeInstanceOf(SkillInvalidError);
  expect((caught as Error).message).toMatch(msg);
}

// ---------------------------------------------------------------------------

describe('parser：SKILL.md frontmatter（yaml）', () => {
  it('多行 description（以本机 ai-architect 为样本，折叠块 >）', () => {
    const text = readFileSync(join(ROOT, 'tests', 'fixtures', 'skills', 'ai-architect', 'SKILL.md'), 'utf8');
    const p = parseSkillMd(text);
    expect(p.name).toBe('ai-architect');
    expect(p.version).toBe('0.0.0');
    expect(p.description.startsWith('AI 编程架构师。')).toBe(true);
    expect(p.description).toContain('触发词：架构设计');
    expect(p.description).toContain('时激活。');
    expect(p.description.includes('\n'), '折叠块应合并为一行').toBe(false);
    expect(p.body.startsWith('# AI 编程架构师')).toBe(true);
  });

  it('字面块 |、引号折行、数字版本号、BOM + CRLF', () => {
    const lit = parseSkillMd('---\nname: 甲\ndescription: |\n  第一行\n  第二行\nversion: 2\n---\n正文');
    expect(lit).toEqual({ name: '甲', description: '第一行\n第二行', version: '2', body: '正文' });
    const quoted = parseSkillMd('\uFEFF---\r\nname: "乙"\r\ndescription: "跨行的\r\n  描述"\r\nauthor: 忽略\r\n---\r\n\r\n# 规则\r\n');
    expect(quoted).toEqual({ name: '乙', description: '跨行的 描述', version: '0.0.0', body: '# 规则' });
  });

  it('不合法：无 frontmatter、缺 name、空 description、YAML 错误、不是键值对', () => {
    invalid(() => parseSkillMd('# 没有 frontmatter'), /frontmatter/);
    invalid(() => parseSkillMd('---\ndescription: x\n---\n'), /缺少 name/);
    invalid(() => parseSkillMd('---\nname: x\ndescription: "  "\n---\n'), /缺少 description/);
    invalid(() => parseSkillMd('---\nname: [x\n---\n'), /不是合法 YAML/);
    invalid(() => parseSkillMd('---\n- a\n- b\n---\n'), /键值对/);
  });
});

describe('zip：INV-13 恶意样本', () => {
  const ok = makeZip([
    { name: 'SKILL.md', data: skillMd('好技能') },
    { name: 'references/', data: '' },
    { name: 'references/a.md', data: '甲'.repeat(1000), method: 8 },
    { name: 'notes.txt', data: 'stored', method: 0 },
  ]);

  it('正常包：stored 与 deflate 都能解出，目录项被跳过', () => {
    const files = readZip(ok, LIM);
    expect(files.map((f) => f.path)).toEqual(['SKILL.md', 'references/a.md', 'notes.txt']);
    expect(files[1]?.data.toString('utf8')).toBe('甲'.repeat(1000));
  });

  it('未标记 UTF-8 的 GBK 文件名（中文 Windows 压缩工具）', () => {
    const gbkName = Buffer.concat([Buffer.from([0xcb, 0xb5, 0xc3, 0xf7]), Buffer.from('.md')]);
    const files = readZip(makeZip([{ name: 'x', nameBytes: gbkName, data: 'x' }]), LIM);
    expect(files[0]?.path).toBe('说明.md');
  });

  it.each([
    ['路径带 ..', [{ name: '../evil.md', data: 'x' }], /\.\./],
    ['反斜杠形式的 ..', [{ name: 'a\\..\\..\\evil.md', data: 'x' }], /\.\./],
    ['绝对路径', [{ name: '/etc/passwd', data: 'x' }], /绝对路径/],
    ['盘符路径', [{ name: 'C:/Windows/x.md', data: 'x' }], /绝对路径/],
    ['符号链接', [{ name: 'SKILL.md', data: '/etc/passwd', unixMode: 0o120777 }], /符号链接/],
    ['加密项', [{ name: 'SKILL.md', data: 'x', flags: 0x801 }], /加密/],
    ['不支持的压缩方式', [{ name: 'SKILL.md', data: 'x', method: 12 }], /压缩方式/],
    ['重复文件', [{ name: 'a.md', data: '1' }, { name: 'a.md', data: '2' }], /重复/],
    ['声明大小与实际不符', [{ name: 'a.md', data: 'hello', declaredSize: 3 }], /大小与目录记录不一致/],
    ['CRC 错误', [{ name: 'a.md', data: 'hello', crc: 1 }], /校验失败/],
  ] as const)('%s → 拒绝', (_label, entries, msg) => {
    invalid(() => readZip(makeZip([...entries]), LIM), msg);
  });

  it('超出文件数、声明解压大小、压缩包大小时拒绝', () => {
    const many = makeZip(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.md`, data: 'x' })));
    invalid(() => readZip(many, { ...LIM, maxFiles: 5 }), /文件数超过 5/);
    invalid(() => readZip(makeZip([{ name: 'a.md', data: 'x'.repeat(2000) }]), { ...LIM, maxUnpackedBytes: 1000 }), /解压后超过/);
    invalid(() => readZip(ok, { ...LIM, maxZipBytes: 100 }), /压缩包超过/);
  });

  it('zip 炸弹：声明很小、实际解压很大，解压在限额处被硬性中止', () => {
    const bomb = makeZip([{ name: 'a.md', data: Buffer.alloc(5_000_000), declaredSize: 10 }]);
    expect(bomb.length).toBeLessThan(20_000);
    const started = performance.now();
    invalid(() => readZip(bomb, { ...LIM, maxUnpackedBytes: 100_000 }), /解压后超过/);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('不是 zip 文件', () => {
    invalid(() => readZip(Buffer.from('PK not really a zip file at all, just text padding'), LIM), /不是有效的 zip/);
  });
});

describe('importer：技能包整理', () => {
  const f = (path: string, data: string): { path: string; data: Buffer } => ({ path, data: Buffer.from(data) });

  it('根目录只有一个子目录且其中有 SKILL.md 时，把它当作根；__MACOSX 与 .DS_Store 被忽略；只保留 .md/.txt', () => {
    const pkg = buildPackage([
      f('my-skill/SKILL.md', skillMd('技能甲')),
      f('my-skill/references/b.md', 'B'),
      f('my-skill/scripts/run.sh', 'rm -rf /'),
      f('my-skill/logo.png', 'png'),
      f('__MACOSX/my-skill/._SKILL.md', 'junk'),
      f('my-skill/.DS_Store', 'junk'),
    ]);
    expect(pkg.parsed.name).toBe('技能甲');
    expect(pkg.files.map((x) => x.path).sort()).toEqual(['SKILL.md', 'references/b.md']);
    expect(pkg.skipped).toBe(2);
  });

  it('缺少 SKILL.md、多个顶层目录、SKILL.md 不是 UTF-8 时拒绝', () => {
    invalid(() => buildPackage([f('README.md', 'x')]), /缺少 SKILL\.md/);
    invalid(() => buildPackage([f('a/SKILL.md', skillMd('x')), f('b/x.md', 'y')]), /缺少 SKILL\.md/);
    invalid(() => buildPackage([{ path: 'SKILL.md', data: Buffer.from([0xff, 0xfe, 0x00]) }]), /UTF-8/);
  });

  it('文件夹导入（base64）：路径同样校验，非法 base64 拒绝', () => {
    const b64 = (s: string): string => Buffer.from(s).toString('base64');
    expect(packageFromFiles({ files: [{ path: 'folder/SKILL.md', contentBase64: b64(skillMd('文件夹技能')) }] }).parsed.name).toBe('文件夹技能');
    invalid(() => packageFromFiles({ files: [{ path: '../SKILL.md', contentBase64: b64('x') }] }), /\.\./);
    invalid(() => packageFromFiles({ files: [{ path: 'SKILL.md', contentBase64: '不是base64' }] }), /base64/);
  });

  it('zip 整体流程：packageFromZip', () => {
    const pkg = packageFromZip(makeZip([{ name: 'x/SKILL.md', data: skillMd('压缩包技能') }, { name: 'x/a.txt', data: 'A' }]));
    expect(pkg.files.map((x) => x.path)).toEqual(['SKILL.md', 'a.txt']);
  });
});

describe('builtin：内置技能清单（§6.5）', () => {
  it('仓库中的 6 个内置技能全部合法，按 TASK_KINDS 排序', () => {
    const list = loadBuiltinSkills(createAssetReader(ROOT));
    expect(list.map((b) => b.jobType)).toEqual([...TASK_KINDS]);
    for (const b of list) {
      expect(b.id).toBe(`builtin:${b.dir}`);
      expect(b.parsed.body.length).toBeGreaterThan(200);
    }
  });

  it('故意改坏：每一类问题都会被发现', () => {
    const good = JSON.parse(readFileSync(join(ROOT, 'builtin-skills', 'manifest.json'), 'utf8')) as Record<string, string>[];
    const read = (dir: string): string | null => (dir === 'missing' ? null : dir === 'broken' ? '# 无 frontmatter' : skillMd(dir));
    expect(findManifestProblems(good, read)).toEqual([]);
    const cases: [string, unknown, RegExp][] = [
      ['id 前缀', good.map((m, i) => (i === 0 ? { ...m, id: 'typo-check' } : m)), /id 必须是 builtin:typo-check/],
      ['id 重复', [...good, good[0]], /id 重复/],
      ['jobType 不合法', good.map((m, i) => (i === 0 ? { ...m, jobType: 'spell' } : m)), /不属于 TaskKind/],
      ['缺少一种 TaskKind', good.slice(1), /「typo」应恰好有 1 个/],
      ['同一 TaskKind 两个', [...good, { id: 'builtin:x', dir: 'x', jobType: 'typo' }], /「typo」应恰好有 1 个内置技能（实际 2 个）/],
      ['dir 不合法', [...good.slice(0, 5), { id: 'builtin:../x', dir: '../x', jobType: 'summary' }], /dir 不合法/],
      ['缺 SKILL.md', [...good.slice(0, 5), { id: 'builtin:missing', dir: 'missing', jobType: 'summary' }], /缺少 builtin-skills\/missing\/SKILL\.md/],
      ['SKILL.md 不合法', [...good.slice(0, 5), { id: 'builtin:broken', dir: 'broken', jobType: 'summary' }], /SKILL\.md 不合法/],
      ['多余字段', good.map((m, i) => (i === 0 ? { ...m, extra: 1 } : m)), /字段必须恰好是/],
      ['不是数组', {}, /必须是数组/],
    ];
    for (const [label, manifest, re] of cases) {
      expect(findManifestProblems(manifest, read).join('\n'), label).toMatch(re);
    }
  });
});

describe('prompt：技能规则段（§7.4.1 ②）', () => {
  it('标题 + 正文 + 按路径排序的参考资料', () => {
    const text = buildSkillRules('甲', '正文', [
      { path: 'references/b.md', text: 'B' },
      { path: 'references/a.md', text: 'A\r\n' },
      { path: 'references/empty.md', text: '  ' },
    ]);
    expect(text).toBe('## 检查规则（技能：甲）\n\n正文\n\n### 参考资料：references/a.md\n\nA\n\n### 参考资料：references/b.md\n\nB');
  });

  it('超出上限时截断并注明，总长不超过上限', () => {
    const text = buildSkillRules('甲', '字'.repeat(500), [], 200);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toMatch(/超过 200 字，其余部分已截断）$/);
  });
});

describe('registry：注册表修复', () => {
  const record = {
    id: 'local:a-123456',
    source: 'local',
    dir: 'local__a-123456',
    name: 'A',
    description: '',
    version: '1.0.0',
    enabled: true,
    appliesTo: ['review'],
    hub: null,
    installedAt: 1,
  };
  it('不合法、重复、冒充内置的记录被丢弃并记入修复列表', () => {
    const r = sanitizeRegistry({
      version: 1,
      skills: [
        record,
        { ...record, id: 'local:b' },
        { ...record, id: 'builtin:typo-check', dir: 'x__y' },
        { ...record, id: 'local:c', dir: '../escape' },
        { ...record, id: 'local:d', dir: 'local__d', appliesTo: ['summary'] },
      ],
    });
    expect(r.value.skills.map((s) => s.id)).toEqual(['local:a-123456']);
    expect(r.repaired).toEqual(['skills[1]', 'skills[2]', 'skills[3]', 'skills[4]']);
  });
});

describe('Skills：安装、修改、删除与 SkillHub', () => {
  let hub: MockHub;
  let tmp: ReturnType<typeof makeTempDir>;
  let skills: Skills;
  const log = createSilentLogger();
  const assets = createAssetReader(ROOT);
  const make = (baseUrl = hub.baseUrl): Skills =>
    new Skills({
      dir: join(tmp.dir, 'skills'),
      assets,
      log,
      hub: new HubClient({ baseUrl, clientId: 'client-uuid', userAgent: 'NovelEditor/test', maxZipBytes: 1024 * 1024 }),
      now: () => 1_000,
    });

  beforeAll(async () => {
    hub = await startMockHub();
  });
  afterAll(async () => {
    await hub.close();
  });
  beforeEach(() => {
    tmp?.cleanup();
    tmp = makeTempDir('ne-skills-');
    skills = make();
    hub.requests.length = 0;
    hub.missing = false;
  });

  it('列表先列 10 个内置技能；内置技能不能修改、不能删除', () => {
    const list = skills.list();
    expect(list).toHaveLength(10);
    expect(list.every((s) => s.source === 'builtin' && s.enabled && s.installedAt === null)).toBe(true);
    expect(() => skills.update('builtin:typo-check', { enabled: false })).toThrow(/内置技能不能修改/);
    expect(() => skills.remove('builtin:typo-check')).toThrow(/内置技能不能删除/);
    expect(skills.detail('builtin:chapter-summary').body).toContain('200 字');
    expect(skills.rulesFor('builtin:typo-check').startsWith('## 检查规则（技能：错别字与标点检查）')).toBe(true);
  });

  it('导入 zip：只落盘文本文件；详情、规则段含 references；修改适用类型与启用；删除目录', () => {
    const info = skills.importZip(
      makeZip([
        { name: 'pack/SKILL.md', data: skillMd('Qidian Style 审稿', '描述') },
        { name: 'pack/references/z.md', data: 'Z 规则' },
        { name: 'pack/references/a.txt', data: 'A 规则' },
        { name: 'pack/scripts/evil.sh', data: 'rm -rf ~' },
      ]),
    );
    expect(info).toMatchObject({ source: 'local', name: 'Qidian Style 审稿', version: '1.2.0', enabled: true, appliesTo: ['review'], installedAt: 1000 });
    expect(info.id).toMatch(/^local:qidian-style-[0-9a-f]{6}$/);
    const dir = join(tmp.dir, 'skills', `local__${info.id.slice('local:'.length)}`);
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'scripts')), '非文本文件不落盘').toBe(false);

    const detail = skills.detail(info.id);
    expect(detail.references).toEqual([
      { path: 'references/a.txt', size: Buffer.byteLength('A 规则') },
      { path: 'references/z.md', size: Buffer.byteLength('Z 规则') },
    ]);
    const rules = skills.rulesFor(info.id);
    expect(rules.indexOf('A 规则')).toBeLessThan(rules.indexOf('Z 规则'));

    expect(skills.update(info.id, { appliesTo: ['setting', 'typo'], enabled: false })).toMatchObject({ appliesTo: ['typo', 'setting'], enabled: false });
    expect(make().list().find((s) => s.id === info.id), '重启后保留').toMatchObject({ enabled: false, appliesTo: ['typo', 'setting'] });

    skills.remove(info.id);
    expect(existsSync(dir)).toBe(false);
    expect(() => skills.detail(info.id)).toThrow(DomainError);
  });

  it('非法包不会留下任何文件，注册表不变', () => {
    expect(() => skills.importZip(makeZip([{ name: '../SKILL.md', data: skillMd('x') }]))).toThrow(SkillInvalidError);
    expect(readdirSync(join(tmp.dir, 'skills')).sort()).toEqual(['registry.json']);
  });

  it('启动时清理未完成安装的临时目录；目录丢失的记录被移除', () => {
    const info = skills.importZip(makeZip([{ name: 'SKILL.md', data: skillMd('将被删除目录') }]));
    const root = join(tmp.dir, 'skills');
    mkdirSync(join(root, '.tmp-deadbeef'));
    writeFileSync(join(root, '.tmp-deadbeef', 'x.md'), 'x');
    rmSync(join(root, `local__${info.id.slice(6)}`), { recursive: true });
    const again = make();
    expect(existsSync(join(root, '.tmp-deadbeef'))).toBe(false);
    expect(again.list().some((s) => s.id === info.id)).toBe(false);
  });

  it('localSlug：保留 ASCII，全中文时为 skill', () => {
    expect(localSlug('My Skill!! v2')).toBe('my-skill-v2');
    expect(localSlug('起点风格')).toBe('skill');
  });

  it('SkillHub 搜索：带客户端标识；坐标不安全或缺 namespace 的条目被过滤', async () => {
    const results = await skills.hubSearch('小说', 5);
    expect(results).toEqual([{ namespace: HUB_SKILL.namespace, slug: HUB_SKILL.slug, name: '起点风格审稿', summary: '按起点编辑标准审稿', version: '1.2.0' }]);
    expect(hub.requests[0]?.path).toBe(`/api/v1/search?q=${encodeURIComponent('小说')}&limit=5`);
    expect(hub.requests[0]?.headers['x-skillhub-client-id']).toBe('client-uuid');
    expect(hub.requests[0]?.headers['user-agent']).toBe('NovelEditor/test');
  });

  it('SkillHub 详情：安全报告只保留 https 链接', async () => {
    const d = await skills.hubDetail(HUB_SKILL.namespace, HUB_SKILL.slug);
    expect(d.version).toBe('1.2.0');
    expect(d.securityReports).toEqual([{ provider: '科恩实验室', status: 'benign', statusText: '安全，无风险', reportUrl: 'https://tix.qq.com/report/1' }]);
  });

  it('SkillHub 安装：跟随 302 下载；再次安装原地更新并保留启用状态与适用类型', async () => {
    const info = await skills.hubInstall({ namespace: HUB_SKILL.namespace, slug: HUB_SKILL.slug });
    expect(info).toMatchObject({
      id: `hub:${HUB_SKILL.namespace}/${HUB_SKILL.slug}`,
      source: 'skillhub',
      appliesTo: ['review'],
      name: '起点风格审稿',
    });
    expect(hub.requests.map((r) => r.path)).toEqual([
      `/api/v1/download?slug=${HUB_SKILL.slug}&namespace=${HUB_SKILL.namespace}&version=`,
      '/files/skill.zip',
      `/api/v1/skills/${HUB_SKILL.slug}?namespace=${HUB_SKILL.namespace}`,
    ]);
    expect(skills.detail(info.id).references.map((r) => r.path)).toEqual(['references/rules.md']);
    skills.update(info.id, { enabled: false, appliesTo: ['character'] });
    const again = await skills.hubInstall({ namespace: HUB_SKILL.namespace, slug: HUB_SKILL.slug, version: '1.3.0' });
    expect(again).toMatchObject({ enabled: false, appliesTo: ['character'], version: '1.3.0' });
    expect(skills.list().filter((s) => s.id === info.id)).toHaveLength(1);
    expect(readdirSync(join(tmp.dir, 'skills')).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('SkillHub 失败：404 → NOT_FOUND；超大包 → HubError；连不上 → HubError', async () => {
    hub.missing = true;
    await expect(skills.hubInstall({ namespace: HUB_SKILL.namespace, slug: HUB_SKILL.slug })).rejects.toThrow(DomainError);
    hub.missing = false;
    const saved = hub.zip;
    hub.zip = Buffer.alloc(2 * 1024 * 1024);
    await expect(skills.hubInstall({ namespace: HUB_SKILL.namespace, slug: HUB_SKILL.slug })).rejects.toThrow(/超过 1 MB/);
    hub.zip = saved;
    await expect(make('http://127.0.0.1:1').hubSearch('x')).rejects.toThrow(HubError);
  });
});
