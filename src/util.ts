// src/util.ts — small HTTP helpers shared by every surface.
//
// Every JSON reply carries a non-empty `X-GitHub-Request-Id` header whose value is
// deterministic for a given request sequence (`req-<n>` from a process-wide counter, or
// from the store's counter when the caller passes one in). No clock, no randomness.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** An HTTP error: `status` is the reply status, `message` the JSON `{message}` body. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Largest JSON request body accepted (16 MiB; the entry's snapshot cap, reused as a bound). */
export const MAX_JSON_BODY_BYTES = 16 * 1024 * 1024;

let requestCounter = 0;

/**
 * The next deterministic request id. When the caller passes the store, the store's counter
 * is used so ids and timestamps share one sequence; otherwise a module counter is used.
 */
export function nextRequestId(store?: { reqCounter: number }): string {
  if (store) {
    store.reqCounter += 1;
    return `req-${store.reqCounter}`;
  }
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Read a request body and parse it as JSON. Empty body -> undefined. Malformed -> 400. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > MAX_JSON_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks, size).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
}

/** Read a request body as raw bytes (used by the git smart-HTTP handlers). */
export async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    chunks.push(buf);
  }
  return Buffer.concat(chunks, size);
}

/**
 * Send a JSON reply. `headers` are added beside `content-type` and
 * `X-GitHub-Request-Id`; when the caller did not supply a request id, the
 * store's current counter value is stamped WITHOUT advancing it — app.ts
 * advances the counter exactly once per request, before dispatch.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
  store?: { reqCounter: number },
): void {
  const text = `${JSON.stringify(body)}\n`;
  const lower = new Set(Object.keys(headers).map((key) => key.toLowerCase()));
  const requestId = lower.has('x-github-request-id')
    ? undefined
    : store !== undefined
      ? `req-${store.reqCounter}`
      : nextRequestId();
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...(requestId ? { 'x-github-request-id': requestId } : {}),
    ...headers,
  });
  res.end(text);
}

/** Send a raw (non-JSON) reply, e.g. a git advertisement or packfile. The
 * request id is the store's current counter value, stamped without
 * advancing it (app.ts owns the one increment per request). */
export function sendRaw(
  res: ServerResponse,
  status: number,
  buffer: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
  store?: { reqCounter: number },
): void {
  const lower = new Set(Object.keys(headers).map((key) => key.toLowerCase()));
  const requestId = lower.has('x-github-request-id')
    ? undefined
    : store !== undefined
      ? `req-${store.reqCounter}`
      : nextRequestId();
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': buffer.length,
    ...(requestId ? { 'x-github-request-id': requestId } : {}),
    ...headers,
  });
  res.end(buffer);
}

/** 404 with a JSON `{message}` body. */
export function json404(res: ServerResponse, message = 'Not Found', store?: { reqCounter: number }): void {
  sendJson(res, 404, { message }, {}, store);
}

/** 401 with a JSON `{message}` body. */
export function json401(res: ServerResponse, message = 'Requires authentication', store?: { reqCounter: number }): void {
  sendJson(res, 401, { message }, {}, store);
}
