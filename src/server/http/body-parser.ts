import type { IncomingMessage } from 'node:http';
import { badRequest, payloadTooLarge } from './errors';

/** 读取请求体并限制大小：声明的 Content-Length 超限立即拒绝，分块传输时边读边计数。 */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw payloadTooLarge(limit);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > limit) throw payloadTooLarge(limit);
    chunks.push(buf);
  }
  return Buffer.concat(chunks, size);
}

export async function readJson(req: IncomingMessage, limit: number, optional: boolean): Promise<unknown> {
  const body = await readBody(req, limit);
  if (body.length === 0) {
    if (optional) return {};
    throw badRequest('请求体不能为空');
  }
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/i.test(type)) throw badRequest('Content-Type 必须是 application/json');
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw badRequest('请求体不是合法的 JSON');
  }
}
