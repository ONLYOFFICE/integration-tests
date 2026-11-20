import { createHmac, randomUUID } from 'node:crypto';

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

/**
 * HS256 JWT, as Document Server signs its requests to the host system. `expiresIn` (seconds, may
 * be negative for an already expired token) adds an `exp` claim.
 */
export function signJwt(payload: object, secret: string, options: { expiresIn?: number } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iat: now,
    ...(options.expiresIn !== undefined ? { exp: now + options.expiresIn } : {}),
    ...payload,
  };
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(claims));
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

/**
 * The stand's Document Server: its public address, JWT secret and header — published by
 * tests/setup/document-server.ts for scenarios that call the host system the way Document Server
 * does, or call Document Server itself.
 */
export function documentServer(): { url: string; secret: string; header: string } {
  const url = process.env.OIT_DOCUMENTSERVER_URL ?? process.env.DOCUMENTSERVER_URL;
  const secret = process.env.DOCUMENTSERVER_SECRET;
  if (!url || !secret) {
    throw new Error('The Document Server address or secret is not set — tests/setup/document-server.ts publishes them');
  }
  return { url: url.replace(/\/?$/, '/'), secret, header: process.env.DOCUMENTSERVER_HEADER ?? 'Authorization' };
}

/**
 * Headers Document Server sends when it downloads a file: its JWT carries the request as `payload`.
 * `secret` overrides the stand's one, for scenarios that check a foreign signature is refused.
 */
export function downloadHeaders(
  url: string,
  secret = documentServer().secret,
  options: { header?: string; expiresIn?: number } = {},
): Record<string, string> {
  const header = options.header ?? documentServer().header;
  return { [header]: `Bearer ${signJwt({ payload: { url } }, secret, { expiresIn: options.expiresIn })}` };
}

/** A callback request as Document Server sends it: the body, signed into its `token` field */
export function signedCallbackBody(body: Record<string, unknown>, secret = documentServer().secret): string {
  return JSON.stringify({ ...body, token: signJwt(body, secret) });
}

/**
 * Has Document Server's conversion service fetch `url` (a file link the host system handed to
 * Docs) and convert it, and returns the result's URL — a file under the Document Server address,
 * as the editor hands one to the host when saving or saving a copy.
 */
export async function convertWithDocumentServer(url: string, fileType: string, outputType = fileType): Promise<string> {
  const ds = documentServer();
  const request = { async: false, filetype: fileType, outputtype: outputType, key: randomUUID(), title: `autotest.${fileType}`, url };
  const response = await fetch(`${ds.url}converter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...request, token: signJwt(request, ds.secret) }),
  });
  const result = (await response.json().catch(() => ({}))) as { fileUrl?: string; endConvert?: boolean; error?: number };
  if (!response.ok || !result.endConvert || !result.fileUrl) {
    throw new Error(`Document Server conversion of ${url} failed: HTTP ${response.status} ${JSON.stringify(result)}`);
  }
  return result.fileUrl;
}
