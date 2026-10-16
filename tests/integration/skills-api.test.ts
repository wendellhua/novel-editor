import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { BODY_LIMITS, LIMITS } from '../../src/shared/constants';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HubSkill, HubSkillDetail, SkillDetail, SkillInfo, SkillRegistry } from '../../src/shared/types';
import { startTestApp, type TestApp } from '../helpers/app';
import { assertDto } from '../helpers/dto-schemas';
import { HUB_SKILL, startMockHub, type MockHub } from '../helpers/mock-hub';
import { makeZip, skillMd } from '../helpers/zip';

let t: TestApp;
let hub: MockHub;

beforeAll(async () => {
  hub = await startMockHub();
  t = await startTestApp({ hubBaseUrl: hub.baseUrl });
});
afterAll(async () => {
  await t.cleanup();
  await hub.close();
});

const S = (id: string): string => `/api/skills/${encodeURIComponent(id)}`;

async function ok<T>(method: string, path: string, body?: unknown, status = 200, headers?: Record<string, string>): Promise<T> {
  const res = await t.call(method, path, body, headers);
  expect(res.status, `${method} ${path} → ${res.body.slice(0, 300)}`).toBe(status);
  return res.json as T;
}

async function fail(method: string, path: string, body: unknown, status: number, code: string, headers?: Record<string, string>): Promise<string> {
  const res = await t.call(method, path, body, headers);
  expect(res.status, `${method} ${path} → ${res.body.slice(0, 300)}`).toBe(status);
  assertDto('Error', res.json);
  const err = (res.json as { error: { code: string; message: string } }).error;
  expect(err.code).toBe(code);
  return err.message;
}

const ZIP = { 'Content-Type': 'application/zip' };
const registry = (): SkillRegistry => JSON.parse(readFileSync(join(t.paths.skills, 'registry.json'), 'utf8')) as SkillRegistry;

describe('技能接口（§7.2）', () => {
  it('列表含 10 个内置技能；详情含正文；内置技能不能修改或删除', async () => {
    const list = await ok<SkillInfo[]>('GET', '/api/skills');
    assertDto('SkillInfo', list, true);
    expect(list.filter((s) => s.source === 'builtin').map((s) => s.appliesTo[0])).toEqual([
      'typo',
      'review',
      'setting',
      'character',
      'ai_flavor',
      'inspiration',
      'expand',
      'bible_extract',
      'memory',
      'summary',
    ]);
    const detail = await ok<SkillDetail>('GET', S('builtin:editorial-review'));
    assertDto('SkillDetail', detail);
    expect(detail.body).toContain('审读维度');
    expect(await fail('PATCH', S('builtin:typo-check'), { enabled: false }, 400, 'VALIDATION')).toContain('内置技能不能修改');
    expect(await fail('DELETE', S('builtin:typo-check'), undefined, 400, 'VALIDATION')).toContain('内置技能不能删除');
    await fail('GET', S('local:nope'), undefined, 404, 'NOT_FOUND');
  });

  it('导入 zip（原始字节）→ 修改适用类型与启用 → 删除', async () => {
    const zip = makeZip([
      { name: 'style/SKILL.md', data: skillMd('本书禁用词', '列出本书不允许出现的词') },
      { name: 'style/references/words.txt', data: '卧槽\n牛逼\n' },
      { name: 'style/run.py', data: 'import os' },
    ]);
    const info = await ok<SkillInfo>('POST', '/api/skills/import', zip, 200, ZIP);
    assertDto('SkillInfo', info);
    expect(info).toMatchObject({ source: 'local', name: '本书禁用词', appliesTo: ['review'], enabled: true });
    const detail = await ok<SkillDetail>('GET', S(info.id));
    expect(detail.references).toEqual([{ path: 'references/words.txt', size: Buffer.byteLength('卧槽\n牛逼\n') }]);
    const record = registry().skills.find((s) => s.id === info.id);
    expect(record?.dir).toMatch(/^local__skill-[0-9a-f]{6}$/);
    expect(existsSync(join(t.paths.skills, record?.dir ?? '', 'run.py')), '脚本不落盘').toBe(false);

    const patched = await ok<SkillInfo>('PATCH', S(info.id), { appliesTo: ['typo', 'review'], enabled: false });
    expect(patched).toMatchObject({ appliesTo: ['typo', 'review'], enabled: false });
    await fail('PATCH', S(info.id), { appliesTo: ['summary'] }, 400, 'VALIDATION');
    await fail('PATCH', S(info.id), { appliesTo: [] }, 400, 'VALIDATION');
    await fail('PATCH', S(info.id), {}, 400, 'VALIDATION');

    await ok('DELETE', S(info.id), undefined, 204);
    await fail('GET', S(info.id), undefined, 404, 'NOT_FOUND');
    expect(existsSync(join(t.paths.skills, record?.dir ?? 'x'))).toBe(false);
  });

  it('INV-13：恶意 zip 一律 422 SKILL_INVALID，且不留下任何文件', async () => {
    const before = registry().skills.length;
    const samples: [string, Buffer][] = [
      ['路径穿越', makeZip([{ name: '../../SKILL.md', data: skillMd('x') }])],
      ['绝对路径', makeZip([{ name: '/SKILL.md', data: skillMd('x') }])],
      ['符号链接', makeZip([{ name: 'SKILL.md', data: '/etc/passwd', unixMode: 0o120777 }])],
      ['缺少 SKILL.md', makeZip([{ name: 'README.md', data: '# hi' }])],
      ['缺少 name', makeZip([{ name: 'SKILL.md', data: '---\ndescription: x\n---\n' }])],
      ['文件数超限', makeZip(Array.from({ length: 501 }, (_, i) => ({ name: `f${i}.md`, data: 'x' })))],
      ['zip 炸弹', makeZip([{ name: 'SKILL.md', data: Buffer.alloc(25 * 1024 * 1024), declaredSize: 100 }])],
      ['不是 zip', Buffer.from('definitely not a zip archive, just some bytes')],
    ];
    for (const [label, zip] of samples) {
      const msg = await fail('POST', '/api/skills/import', zip, 422, 'SKILL_INVALID', ZIP);
      expect(msg, label).not.toBe('');
    }
    expect(registry().skills.length).toBe(before);
    expect(readdirSync(t.paths.skills).filter((n) => n.startsWith('.')), '没有残留临时目录').toEqual([]);
  });

  it('文件夹导入：接近 20 MB 上限的文本（base64 后超过 25 MB）也能导入，不会被请求体上限拦成 413', async () => {
    const big = Buffer.alloc(LIMITS.skillUnpackedMaxBytes - 512 * 1024, 'a');
    const res = await t.call('POST', '/api/skills/import', {
      files: [
        { path: 'big/SKILL.md', contentBase64: Buffer.from(skillMd('大技能')).toString('base64') },
        { path: 'big/references/big.md', contentBase64: big.toString('base64') },
      ],
    });
    expect(res.status, res.body.slice(0, 200)).toBe(200);
    const info = res.json as SkillInfo;
    expect((await ok<SkillDetail>('GET', S(info.id))).references).toEqual([{ path: 'references/big.md', size: big.length }]);
    await ok('DELETE', S(info.id), undefined, 204);
  });

  it('压缩包超过 10 MB → 422；请求体声明超过 BODY_LIMITS.skillImport → 413（不等上传完就拒绝）', async () => {
    expect(await fail('POST', '/api/skills/import', Buffer.alloc(10 * 1024 * 1024 + 1), 422, 'SKILL_INVALID', ZIP)).toContain('10 MB');
    // 只发请求头：服务端按声明的 Content-Length 立即返回 413 并关闭连接
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: t.app.port,
          method: 'POST',
          path: '/api/skills/import',
          headers: {
            Host: `127.0.0.1:${t.app.port}`,
            Cookie: t.cookie,
            Origin: `http://127.0.0.1:${t.app.port}`,
            ...ZIP,
            'Content-Length': String(BODY_LIMITS.skillImport + 1),
          },
        },
        (r) => {
          let body = '';
          r.on('data', (c: Buffer) => (body += c.toString('utf8')));
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('文件夹导入（JSON + base64）；路径非法 → 422；缺字段 → 400', async () => {
    const b64 = (s: string): string => Buffer.from(s).toString('base64');
    const info = await ok<SkillInfo>('POST', '/api/skills/import', {
      files: [
        { path: 'my-folder/SKILL.md', contentBase64: b64(skillMd('文件夹技能')) },
        { path: 'my-folder/references/a.md', contentBase64: b64('A') },
      ],
    });
    expect(info.name).toBe('文件夹技能');
    await fail('POST', '/api/skills/import', { files: [{ path: '..\\SKILL.md', contentBase64: b64('x') }] }, 422, 'SKILL_INVALID');
    await fail('POST', '/api/skills/import', { files: [{ path: 'SKILL.md' }] }, 400, 'VALIDATION');
  });

  it('SkillHub：搜索、详情（含安全报告）、安装后出现在列表并能看到正文', async () => {
    const results = await ok<HubSkill[]>('GET', `/api/skills/hub/search?q=${encodeURIComponent('小说')}&limit=10`);
    assertDto('HubSkill', results, true);
    expect(results).toHaveLength(1);
    const detail = await ok<HubSkillDetail>('GET', `/api/skills/hub/detail?namespace=${HUB_SKILL.namespace}&slug=${HUB_SKILL.slug}`);
    assertDto('HubSkillDetail', detail);
    expect(detail.securityReports.map((r) => r.provider)).toEqual(['科恩实验室']);

    const info = await ok<SkillInfo>('POST', '/api/skills/hub/install', { namespace: HUB_SKILL.namespace, slug: HUB_SKILL.slug });
    assertDto('SkillInfo', info);
    expect(info).toMatchObject({ id: `hub:${HUB_SKILL.namespace}/${HUB_SKILL.slug}`, source: 'skillhub' });
    expect((await ok<SkillInfo[]>('GET', '/api/skills')).some((s) => s.id === info.id)).toBe(true);
    expect((await ok<SkillDetail>('GET', S(info.id))).body).toContain('第一条');

    await fail('GET', '/api/skills/hub/search', undefined, 400, 'VALIDATION');
    await fail('POST', '/api/skills/hub/install', { namespace: '../x', slug: 'y' }, 400, 'VALIDATION');
    hub.missing = true;
    await fail('POST', '/api/skills/hub/install', { namespace: HUB_SKILL.namespace, slug: HUB_SKILL.slug }, 404, 'NOT_FOUND');
    hub.missing = false;
  });

  it('SkillHub 不可用 → 502 HUB_ERROR（只记一行警告），本地功能不受影响', async () => {
    const other = await startTestApp();
    try {
      const res = await other.call('GET', '/api/skills/hub/search?q=x');
      expect(res.status).toBe(502);
      expect((res.json as { error: { code: string } }).error.code).toBe('HUB_ERROR');
      expect(other.log.lines.some((l) => l.startsWith('[warn] 外部服务失败'))).toBe(true);
      expect(other.log.lines.some((l) => l.startsWith('[error]'))).toBe(false);
      expect((await other.call('GET', '/api/skills')).status).toBe(200);
    } finally {
      await other.cleanup();
    }
  });
});
