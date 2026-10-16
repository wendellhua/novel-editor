import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'ne_session';
const NONCE_TTL_MS = 60_000;
const MAX_OUTSTANDING_NONCES = 64;

export interface Auth {
  issueNonce(): string;
  consumeNonce(nonce: string): boolean;
  verifySecret(value: string | undefined): boolean;
  sessionCookie(): string;
  hasValidSession(cookieHeader: string | undefined): boolean;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (header === undefined) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

/** ADR-010：一次性 nonce（60 s）换取 HttpOnly + SameSite=Strict 会话 Cookie。 */
export function createAuth(secret: string, now: () => number = Date.now): Auth {
  const sessionToken = createHmac('sha256', secret).update('session').digest('hex');
  const nonces = new Map<string, number>();

  const purge = (): void => {
    const t = now();
    for (const [n, expiresAt] of nonces) if (expiresAt <= t) nonces.delete(n);
    while (nonces.size >= MAX_OUTSTANDING_NONCES) {
      const oldest = nonces.keys().next().value;
      if (oldest === undefined) break;
      nonces.delete(oldest);
    }
  };

  return {
    issueNonce() {
      purge();
      const nonce = randomBytes(16).toString('hex');
      nonces.set(nonce, now() + NONCE_TTL_MS);
      return nonce;
    },
    consumeNonce(nonce) {
      const expiresAt = nonces.get(nonce);
      if (expiresAt === undefined) return false;
      nonces.delete(nonce);
      return expiresAt > now();
    },
    verifySecret(value) {
      return value !== undefined && safeEqual(value, secret);
    },
    sessionCookie() {
      return `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`;
    },
    hasValidSession(cookieHeader) {
      const value = parseCookies(cookieHeader).get(SESSION_COOKIE);
      return value !== undefined && safeEqual(value, sessionToken);
    },
  };
}

/** INV-12：防 DNS 重绑定，Host 只能是本机回环地址加当前端口。 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** INV-12：写请求若带 Origin，必须是本服务自身；不带 Origin 的本机客户端（如第二个实例）放行。 */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}
