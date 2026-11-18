import { createHmac } from 'node:crypto';

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

/** HS256 JWT, as Document Server signs its requests to the host system */
export function signJwt(payload: object, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ iat: Math.floor(Date.now() / 1000), ...payload }));
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

/**
 * The JWT secret and header of the stand's Document Server — published by tests/setup/document-server.ts
 * for scenarios that call the host system the way Document Server does.
 */
export function documentServerJwt(): { secret: string; header: string } {
  const secret = process.env.DOCUMENTSERVER_SECRET;
  if (!secret) {
    throw new Error('DOCUMENTSERVER_SECRET is not set — the stand publishes it in tests/setup/document-server.ts');
  }
  return { secret, header: process.env.DOCUMENTSERVER_HEADER ?? 'Authorization' };
}

/**
 * Headers Document Server sends when it downloads a file: its JWT carries the request as `payload`.
 * `secret` overrides the stand's one, for scenarios that check a foreign signature is refused.
 */
export function downloadHeaders(url: string, secret = documentServerJwt().secret): Record<string, string> {
  return { [documentServerJwt().header]: `Bearer ${signJwt({ payload: { url } }, secret)}` };
}

/** A callback request as Document Server sends it: the body, signed into its `token` field */
export function signedCallbackBody(body: Record<string, unknown>, secret = documentServerJwt().secret): string {
  return JSON.stringify({ ...body, token: signJwt(body, secret) });
}
