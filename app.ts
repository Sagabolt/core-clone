// app.ts — the forge's HTTP front door.
//
// One Store is created here and shared by every surface (git smart HTTP,
// REST v3, GraphQL v4, MCP), so an object created through one of them is
// visible through the others with the same id.
//
// Request-id rule (see INTEGRATION-NOTES.md): this file owns the counter.
// It advances `store.reqCounter` exactly once per request, before any
// handler runs, and every reply carries `X-GitHub-Request-Id: req-<n>`
// for that value. The handlers never advance it themselves: REST reads
// the current value, GraphQL/MCP read it without touching it, and the
// git helpers in util.ts stamp the current value instead of minting one.
//
// Git auth lives here too, because handleGit takes no token: a git route
// with a missing or wrong Bearer token is answered 401 JSON before the
// git handler ever sees it. The kit's git client always sends
// `Authorization` when it has a token, so a legitimate clone/push passes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, type Store } from './src/store.ts';
import { handleGit } from './src/git-protocol.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** `/{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}` */
const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** The path of a request URL, or '/' when it does not parse (never throws). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Answer with a JSON body plus the request id this request was given. */
function sendJson(res: ServerResponse, status: number, body: unknown, reqId: string, extra: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': reqId,
    ...extra,
  });
  res.end(text);
}

/**
 * True when the request carries the suite's bearer token. The env always
 * sets MAKEFUN_SHOP_TOKEN; when it is unset (local dev only) any non-empty
 * bearer counts, mirroring the GraphQL/MCP handlers, and anonymous requests
 * still fail.
 */
function gitAuthorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (match === null) return false;
  return expected === '' ? match[1]!.trim() !== '' : match[1] === expected;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store: Store = createStore();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // One increment per request, before dispatch; every handler below
    // reads this same counter value for its X-GitHub-Request-Id.
    store.reqCounter += 1;
    const reqId = `req-${store.reqCounter}`;
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    void (async () => {
      try {
        // The env's boot check calls this twice: 200 {"ok":true}, no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, reqId);
          return;
        }

        // Git smart HTTP, bearer-checked here (handleGit takes no token).
        if (GIT_ROUTE.test(path)) {
          if (!gitAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, reqId);
            return;
          }
          if (await handleGit(req, res, store)) return;
          // A git-shaped path handleGit declined (bad escape): plain 404.
          sendJson(res, 404, { message: 'Not Found' }, reqId);
          return;
        }

        // GraphQL v4 and MCP own their paths and their auth; they return
        // false only when the path is not theirs.
        if (await handleGraphQL(req, res, store)) return;
        if (await handleMcp(req, res, store)) return;

        // All of /api/v3/*, root included, goes through REST so the root
        // gets its X-GitHub-Request-Id too (the starter answered it bare).
        if (await handleRest(req, res, store)) return;

        // Everything else: GitHub's 404 body, still with a request id.
        sendJson(res, 404, { message: 'Not Found' }, reqId);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, reqId);
        } else {
          try {
            res.end();
          } catch {
            // The socket is already gone; nothing left to do.
          }
        }
      }
    })();
  });
}
