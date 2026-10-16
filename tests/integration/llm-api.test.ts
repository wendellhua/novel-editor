import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TASK_KINDS } from '../../src/shared/constants';
import type { LlmConfig, LlmDefaults, LlmPreset, LlmProfile, ProbeResult } from '../../src/shared/types';
import { LLM_PRESETS } from '../../src/server/llm/presets';
import { startTestApp, type TestApp } from '../helpers/app';
import { assertDto } from '../helpers/dto-schemas';
import { completion, errorReply, startMockLlm, type MockLlm } from '../helpers/mock-llm';

const KEY = 'sk-api-SECRET-abcdefghijklmnop9876';
let t: TestApp;
let mock: MockLlm;
/** 所有响应原文，最后统一检查不含明文 Key（INV-17）。 */
const bodies: string[] = [];

beforeAll(async () => {
  t = await startTestApp();
  mock = await startMockLlm();
});
afterAll(async () => {
  await t.cleanup();
  await mock.close();
});

async function ok<T>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
  const res = await t.call(method, path, body);
  bodies.push(res.body);
  expect(res.status, `${method} ${path} → ${res.body}`).toBe(status);
  return res.json as T;
}

async function fail(method: string, path: string, body: unknown, status: number): Promise<string> {
  const res = await t.call(method, path, body);
  bodies.push(res.body);
  expect(res.status, `${method} ${path} → ${res.body}`).toBe(status);
  assertDto('Error', res.json);
  return (res.json as { error: { message: string } }).error.message;
}

const readLlmJson = (): LlmConfig => JSON.parse(readFileSync(t.paths.llm, 'utf8')) as LlmConfig;
const newProfile = (extra: Record<string, unknown> = {}): Promise<LlmProfile> =>
  ok<LlmProfile>('POST', '/api/llm/profiles', { name: 'Mock', baseUrl: mock.baseUrl, model: 'mock-model', apiKey: KEY, ...extra });

describe('模型配置接口（§7.2）', () => {
  it('预设列表与内置预设一致', async () => {
    const presets = await ok<LlmPreset[]>('GET', '/api/llm/presets');
    assertDto('LlmPreset', presets, true);
    expect(presets).toEqual(LLM_PRESETS);
  });

  it('新建、列表、修改、删除；响应只含掩码 Key，llm.json 中保存明文', async () => {
    const created = await newProfile({ name: ' 本地 Mock ' });
    assertDto('LlmProfile', created);
    expect(created).toMatchObject({ name: '本地 Mock', apiKeyMasked: 'sk-****9876', jsonMode: 'json_object', maxConcurrency: 3 });
    expect(readLlmJson().profiles.find((p) => p.id === created.id)?.apiKey).toBe(KEY);

    const list = await ok<LlmProfile[]>('GET', '/api/llm/profiles');
    assertDto('LlmProfile', list, true);
    expect(list.map((p) => p.id)).toContain(created.id);

    const P = `/api/llm/profiles/${created.id}`;
    const patched = await ok<LlmProfile>('PATCH', P, { temperature: 0.7, apiKey: '', extraBody: { enable_thinking: false } });
    assertDto('LlmProfile', patched);
    expect(patched).toMatchObject({ temperature: 0.7, apiKeyMasked: 'sk-****9876', extraBody: { enable_thinking: false } });

    await ok('DELETE', P, undefined, 204);
    expect((await ok<LlmProfile[]>('GET', '/api/llm/profiles')).map((p) => p.id)).not.toContain(created.id);
    expect(readLlmJson().profiles.map((p) => p.id)).not.toContain(created.id);
    await fail('DELETE', P, undefined, 404);
  });

  it('请求校验：缺字段、多余字段、越界、跨字段规则、保留参数、不存在的配置', async () => {
    await fail('POST', '/api/llm/profiles', { name: 'x', baseUrl: mock.baseUrl }, 400);
    await fail('POST', '/api/llm/profiles', { name: 'x', baseUrl: mock.baseUrl, model: 'm', apiKeyMasked: 'x' }, 400);
    await fail('POST', '/api/llm/profiles', { name: 'x', baseUrl: 'ftp://a', model: 'm' }, 400);
    await fail('POST', '/api/llm/profiles', { name: 'x', baseUrl: mock.baseUrl, model: 'm', maxConcurrency: 17 }, 400);
    await fail('POST', '/api/llm/profiles', { name: 'x', baseUrl: mock.baseUrl, model: 'm', temperature: 2.5 }, 400);
    expect(
      await fail('POST', '/api/llm/profiles', { name: 'x', baseUrl: mock.baseUrl, model: 'm', maxOutputTokens: 8192, contextTokens: 8192 }, 400),
    ).toContain('至少要比最大输出多');
    expect(await fail('POST', '/api/llm/profiles', { name: 'x', baseUrl: mock.baseUrl, model: 'm', extraBody: { stream: true } }, 400)).toContain(
      'stream',
    );
    await fail('PATCH', '/api/llm/profiles/ghost', { name: 'x' }, 404);
    await fail('POST', '/api/llm/profiles/ghost/test', undefined, 404);
    const p = await newProfile();
    await fail('PATCH', `/api/llm/profiles/${p.id}`, {}, 400);
  });

  it('更换服务域名但未提供新 Key：旧 Key 被清空（不会发给新的服务方）', async () => {
    const p = await newProfile();
    const moved = await ok<LlmProfile>('PATCH', `/api/llm/profiles/${p.id}`, { baseUrl: 'https://other.example.com/v1' });
    expect(moved.apiKeyMasked).toBe('');
    expect(readLlmJson().profiles.find((x) => x.id === p.id)?.apiKey).toBe('');
  });

  it('测试连接：逐档探测，成功后把 jsonMode 写回配置并持久化', async () => {
    mock.handle = (req) =>
      req.body.response_format?.type === 'json_schema' ? errorReply(400, 'unsupported response_format') : completion('{"ok":true,"reply":"pong"}');
    const p = await newProfile({ jsonMode: 'prompt' });
    mock.requests.length = 0;
    const r = await ok<ProbeResult>('POST', `/api/llm/profiles/${p.id}/test`);
    assertDto('ProbeResult', r);
    expect(r).toMatchObject({ ok: true, jsonMode: 'json_object', error: null });
    expect(mock.requests.map((x) => x.body.response_format?.type)).toEqual(['json_schema', 'json_object']);
    expect(mock.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect((await ok<LlmProfile[]>('GET', '/api/llm/profiles')).find((x) => x.id === p.id)?.jsonMode).toBe('json_object');
    expect(readLlmJson().profiles.find((x) => x.id === p.id)?.jsonMode).toBe('json_object');
  });

  it('测试连接失败：返回 200 + ok=false，错误信息中不含服务端回显的 Key，jsonMode 不变', async () => {
    mock.handle = () => errorReply(401, `Incorrect API key provided: ${KEY}`);
    const p = await newProfile({ jsonMode: 'json_schema' });
    const r = await ok<ProbeResult>('POST', `/api/llm/profiles/${p.id}/test`);
    assertDto('ProbeResult', r);
    expect(r).toMatchObject({ ok: false, jsonMode: 'json_schema' });
    expect(r.error).toContain('HTTP 401');
    expect(readLlmJson().profiles.find((x) => x.id === p.id)?.jsonMode).toBe('json_schema');
  });

  it('默认模型：读取、设置（必须是完整映射且指向已有配置）、删除配置后自动置空', async () => {
    const initial = await ok<LlmDefaults>('GET', '/api/llm/defaults');
    assertDto('LlmDefaults', initial);
    const a = await newProfile({ name: 'A' });
    const b = await newProfile({ name: 'B' });
    const map = Object.fromEntries(TASK_KINDS.map((k) => [k, k === 'summary' ? b.id : a.id])) as LlmDefaults;
    expect(await ok('PUT', '/api/llm/defaults', map)).toEqual(map);
    expect(await ok('GET', '/api/llm/defaults')).toEqual(map);
    expect(readLlmJson().defaults).toEqual(map);

    await fail('PUT', '/api/llm/defaults', { ...map, typo: 'ghost' }, 400);
    const { summary: _omit, ...partial } = map;
    await fail('PUT', '/api/llm/defaults', partial, 400);
    await fail('PUT', '/api/llm/defaults', { ...map, extra: null }, 400);

    await ok('DELETE', `/api/llm/profiles/${a.id}`, undefined, 204);
    const after = await ok<LlmDefaults>('GET', '/api/llm/defaults');
    expect(after.typo).toBeNull();
    expect(after.summary).toBe(b.id);
  });

  it('INV-17：所有接口响应与服务端日志中都不出现明文 Key', () => {
    expect(bodies.length).toBeGreaterThan(20);
    expect(bodies.join('\n')).not.toContain(KEY);
    expect(t.log.lines.some((l) => l.includes('测试连接失败'))).toBe(true);
    expect(t.log.lines.join('\n')).not.toContain(KEY);
  });
});
