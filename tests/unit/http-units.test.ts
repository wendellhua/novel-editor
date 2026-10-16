import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { isSafeRelPath } from '../../src/server/assets';
import { createAuth, isAllowedHost, isAllowedOrigin, parseCookies } from '../../src/server/http/auth';
import { readBody, readJson } from '../../src/server/http/body-parser';
import { HttpError } from '../../src/server/http/errors';
import { Router } from '../../src/server/http/router';

function fakeReq(body: string | Buffer[], headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from(typeof body === 'string' ? [Buffer.from(body)] : body) as unknown as IncomingMessage;
  stream.headers = headers;
  return stream;
}

describe('Router', () => {
  const noop = (): undefined => undefined;

  it('匹配路径参数并解码', () => {
    const r = new Router().get('/api/works/:workId/chapters/:cid', noop);
    const m = r.match('GET', '/api/works/w%201/chapters/c2');
    expect(m?.params).toEqual({ workId: 'w 1', cid: 'c2' });
    expect(m?.route.auth).toBe('session');
  });

  it('方法、段数不同或编码非法时不匹配', () => {
    const r = new Router().get('/api/works/:workId', noop);
    expect(r.match('POST', '/api/works/1')).toBeNull();
    expect(r.match('GET', '/api/works/1/x')).toBeNull();
    expect(r.match('GET', '/api/works/%E0%A4%A')).toBeNull();
  });

  it('重复注册同一路由时抛错', () => {
    const r = new Router().get('/a/:id', noop);
    expect(() => r.get('/a/:id', noop)).toThrow('路由重复');
  });
});

describe('Auth（ADR-010）', () => {
  const secret = 'f'.repeat(64);

  it('nonce 只能用一次', () => {
    const auth = createAuth(secret);
    const n = auth.issueNonce();
    expect(n).toMatch(/^[0-9a-f]{32}$/);
    expect(auth.consumeNonce(n)).toBe(true);
    expect(auth.consumeNonce(n)).toBe(false);
  });

  it('nonce 60 秒后失效', () => {
    let t = 1_000_000;
    const auth = createAuth(secret, () => t);
    const n = auth.issueNonce();
    t += 60_001;
    expect(auth.consumeNonce(n)).toBe(false);
  });

  it('未使用的 nonce 数量有上限', () => {
    const auth = createAuth(secret);
    const first = auth.issueNonce();
    for (let i = 0; i < 100; i++) auth.issueNonce();
    expect(auth.consumeNonce(first)).toBe(false);
  });

  it('会话 Cookie 校验', () => {
    const auth = createAuth(secret);
    const cookie = auth.sessionCookie();
    expect(cookie).toMatch(/^ne_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
    const value = cookie.split(';')[0]!;
    expect(auth.hasValidSession(`other=1; ${value}`)).toBe(true);
    expect(auth.hasValidSession('ne_session=bad')).toBe(false);
    expect(auth.hasValidSession(undefined)).toBe(false);
    expect(createAuth('e'.repeat(64)).hasValidSession(value)).toBe(false);
  });

  it('密钥校验', () => {
    const auth = createAuth(secret);
    expect(auth.verifySecret(secret)).toBe(true);
    expect(auth.verifySecret('f'.repeat(63))).toBe(false);
    expect(auth.verifySecret(undefined)).toBe(false);
  });

  it('parseCookies', () => {
    expect([...parseCookies('a=1; b = 2;c=3=4').entries()]).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', '3=4'],
    ]);
  });

  it('Host 与 Origin 规则（INV-12）', () => {
    expect(isAllowedHost('127.0.0.1:17321', 17321)).toBe(true);
    expect(isAllowedHost('localhost:17321', 17321)).toBe(true);
    expect(isAllowedHost('127.0.0.1:1', 17321)).toBe(false);
    expect(isAllowedHost('evil.com', 17321)).toBe(false);
    expect(isAllowedHost(undefined, 17321)).toBe(false);
    expect(isAllowedOrigin(undefined, 17321)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:17321', 17321)).toBe(true);
    expect(isAllowedOrigin('http://evil.com', 17321)).toBe(false);
    expect(isAllowedOrigin('null', 17321)).toBe(false);
  });
});

describe('请求体读取', () => {
  it('声明长度超限时直接拒绝（413）', async () => {
    const err = await readBody(fakeReq('x', { 'content-length': '2000' }), 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(413);
  });

  it('分块传输超限时拒绝（413）', async () => {
    const err = await readBody(fakeReq([Buffer.alloc(600), Buffer.alloc(600)]), 1000).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(413);
  });

  it('解析 JSON 并校验 Content-Type', async () => {
    expect(await readJson(fakeReq('{"a":1}', { 'content-type': 'application/json; charset=utf-8' }), 100, false)).toEqual({ a: 1 });
    const wrongType = await readJson(fakeReq('{"a":1}', { 'content-type': 'text/plain' }), 100, false).catch((e: unknown) => e);
    expect((wrongType as HttpError).code).toBe('VALIDATION');
    const bad = await readJson(fakeReq('{bad', { 'content-type': 'application/json' }), 100, false).catch((e: unknown) => e);
    expect((bad as HttpError).code).toBe('VALIDATION');
  });

  it('空请求体：可选时返回 {}，必填时报错', async () => {
    expect(await readJson(fakeReq(''), 100, true)).toEqual({});
    const err = await readJson(fakeReq(''), 100, false).catch((e: unknown) => e);
    expect((err as HttpError).code).toBe('VALIDATION');
  });
});

describe('isSafeRelPath（静态资源防穿越）', () => {
  it.each([
    ['web/index.html', true],
    ['web/assets/a.js', true],
    ['../config.json', false],
    ['web/../../x', false],
    ['/etc/passwd', false],
    ['web\\..\\x', false],
    ['web//a', false],
    ['', false],
  ])('%j → %s', (p, ok) => {
    expect(isSafeRelPath(p)).toBe(ok);
  });
});
