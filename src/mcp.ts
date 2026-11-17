// src/mcp.ts — Model Context Protocol endpoint (POST /mcp), JSON-RPC 2.0 over
// Streamable HTTP, answered as plain application/json.
//
// Two eras, one endpoint (see the kit's checks-mcp.ts / mcp-client.ts):
//   modern  2026-07-28: no handshake; every request declares its revision and
//           `server/discover` answers {supportedVersions, capabilities,
//           serverInfo} in one request.
//   legacy  2025-11-25 and earlier: `initialize` (echo a supported revision)
//           + `notifications/initialized` (202, no body).
//
// tools/list is built from one frozen constant array, so two calls answer
// byte-identical lists. tools/call runs the same store mutations GraphQL and
// REST use (imported from ./graphql.ts) — no duplicated logic. Deterministic:
// no Date.now() / new Date() / Math.random(); timestamps come from the store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo, Store } from './store.ts';
import {
  createIssueInStore,
  createPullRequestInStore,
  issueJson,
  mergePullRequestInStore,
  pullJson,
  repoJson,
} from './graphql.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const CURRENT_REVISION = '2026-07-28';
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

// -------------------------------------------------------------------------------------------
// Small utilities
// -------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId?: string): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...(requestId === undefined ? {} : { 'x-github-request-id': requestId }),
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (match === null) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return expected === '' ? match[1]!.trim() !== '' : match[1] === expected;
}

/** X-GitHub-Request-Id value: deterministic, from the store's request counter (not incremented here). */
function requestIdOf(store: Store): string {
  return `req-${typeof store.reqCounter === 'number' ? store.reqCounter : 0}`;
}

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/** A tool result: content blocks of JSON text, optionally marked as an error. */
function toolResult(value: unknown, isError = false): Record<string, unknown> {
  const result: Record<string, unknown> = { content: [{ type: 'text', text: JSON.stringify(value) }] };
  if (isError) result.isError = true;
  return result;
}

// -------------------------------------------------------------------------------------------
// Tools. One frozen constant: tools/list answers byte-identical lists.
// Schemas use github-mcp-server's property names; the suite maps its documented
// arguments onto them (and fills full_name = owner/repo when it can).
// -------------------------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, Record<string, unknown>>; required: string[] };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        title: Object.freeze({ type: 'string', description: 'The title of the issue.' }),
        body: Object.freeze({ type: 'string', description: 'The body of the issue.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        state: Object.freeze({ type: 'string', description: 'Filter by state: open, closed or all.', enum: Object.freeze(['open', 'closed', 'all']) }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        title: Object.freeze({ type: 'string', description: 'The title of the pull request.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch of the pull request.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch of the pull request.' }),
        body: Object.freeze({ type: 'string', description: 'The body of the pull request.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner of the repository.' }),
        repo: Object.freeze({ type: 'string', description: 'The name of the repository.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'The number of the pull request to merge.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

/** Find a tool by exact name, or by normalized suffix (a `github__` prefix is fine). */
function findTool(name: string): ToolDef | undefined {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const tool of TOOLS) {
    if (tool.name === name) return tool;
  }
  for (const tool of TOOLS) {
    const wanted = tool.name.replace(/[^a-z0-9]/g, '');
    if (normalized.length > wanted.length && normalized.endsWith(wanted)) return tool;
  }
  return undefined;
}

// -------------------------------------------------------------------------------------------
// Argument handling: the suite maps its documented names onto the schema's
// properties, but accept the common synonyms and a full_name fallback too.
// -------------------------------------------------------------------------------------------

function pickString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function pickNumber(args: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

/** Split owner/repo out of a full_name argument when owner/repo are missing. */
function splitFullName(args: Record<string, unknown>): { owner?: string; repo?: string } {
  const fullName = pickString(args, 'full_name', 'repo_full_name', 'repository_full_name', 'fullName');
  if (fullName === undefined) return {};
  const slash = fullName.indexOf('/');
  if (slash <= 0 || slash === fullName.length - 1) return {};
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

interface RepoArgs {
  owner?: string;
  repo?: string;
}

function repoArgsOf(args: Record<string, unknown>): RepoArgs {
  const fromFullName = splitFullName(args);
  return {
    owner: pickString(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'namespace') ?? fromFullName.owner,
    repo: pickString(args, 'repo', 'repository', 'repository_name', 'repo_name', 'project') ?? fromFullName.repo,
  };
}

function getRepoOrNull(store: Store, args: Record<string, unknown>): Repo | null {
  const { owner, repo } = repoArgsOf(args);
  if (owner === undefined || repo === undefined) return null;
  return store.getRepo(owner, repo) ?? null;
}

// -------------------------------------------------------------------------------------------
// Tool implementations. All state changes go through the shared helpers in
// ./graphql.ts — the same code GraphQL (and REST, once it lands) uses.
// -------------------------------------------------------------------------------------------

type ToolOutcome = { ok: true; value: unknown } | { ok: false; message: string };

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = findTool(name);
  if (tool === undefined) return { ok: false, message: `Unknown tool: ${name}` };

  // Required-argument check first: a missing required argument is a tool
  // error (isError:true), never an exception or an HTTP 500.
  const missing: string[] = [];
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') missing.push(required);
  }
  // The suite may address an argument by a synonym or by full_name; count
  // those as present for the properties they stand for.
  if (missing.length > 0) {
    const { owner, repo } = repoArgsOf(args);
    const present = new Set<string>();
    if (owner !== undefined) present.add('owner');
    if (repo !== undefined) present.add('repo');
    const title = pickString(args, 'title', 'issue_title', 'pr_title', 'pull_request_title', 'subject');
    if (title !== undefined) present.add('title');
    const head = pickString(args, 'head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from_branch', 'branch');
    if (head !== undefined) present.add('head');
    const base = pickString(args, 'base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into_branch');
    if (base !== undefined) present.add('base');
    const pullNumber = pickNumber(args, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index');
    if (pullNumber !== undefined) present.add('pull_number');
    const stillMissing = missing.filter((key) => !present.has(key));
    if (stillMissing.length > 0) {
      return { ok: false, message: `Missing required argument(s): ${stillMissing.join(', ')}` };
    }
  }

  try {
    switch (tool.name) {
      case 'create_repo': {
        const repoName = pickString(args, 'name', 'repo', 'repository', 'repository_name', 'repo_name');
        if (repoName === undefined) return { ok: false, message: 'Missing required argument(s): name' };
        const description = pickString(args, 'description', 'about', 'summary');
        const isPrivate = typeof args.private === 'boolean' ? args.private : args.private === 'true';
        const repo = store.createRepo(repoName, { description: description ?? '', private: isPrivate });
        return { ok: true, value: repoJson(store, repo) };
      }
      case 'get_repo': {
        const repo = getRepoOrNull(store, args);
        if (repo === null) {
          const { owner, repo: repoName } = repoArgsOf(args);
          return { ok: false, message: `Repository not found: ${owner ?? ''}/${repoName ?? ''}` };
        }
        return { ok: true, value: repoJson(store, repo) };
      }
      case 'create_issue': {
        const repo = getRepoOrNull(store, args);
        if (repo === null) {
          const { owner, repo: repoName } = repoArgsOf(args);
          return { ok: false, message: `Repository not found: ${owner ?? ''}/${repoName ?? ''}` };
        }
        const title = pickString(args, 'title', 'issue_title', 'subject');
        if (title === undefined) return { ok: false, message: 'Missing required argument(s): title' };
        const body = pickString(args, 'body', 'issue_body', 'description', 'content', 'text');
        const issue = createIssueInStore(store, repo, { title, body: body ?? '' });
        return { ok: true, value: issueJson(store, repo, issue) };
      }
      case 'list_issues': {
        const repo = getRepoOrNull(store, args);
        if (repo === null) {
          const { owner, repo: repoName } = repoArgsOf(args);
          return { ok: false, message: `Repository not found: ${owner ?? ''}/${repoName ?? ''}` };
        }
        const state = pickString(args, 'state', 'status') ?? 'open';
        const issues = repo.issues.filter((issue) => {
          if (state === 'all') return true;
          if (state === 'closed') return issue.state === 'closed';
          return issue.state === 'open';
        });
        return { ok: true, value: issues.map((issue) => issueJson(store, repo, issue)) };
      }
      case 'create_pull_request': {
        const repo = getRepoOrNull(store, args);
        if (repo === null) {
          const { owner, repo: repoName } = repoArgsOf(args);
          return { ok: false, message: `Repository not found: ${owner ?? ''}/${repoName ?? ''}` };
        }
        const title = pickString(args, 'title', 'pr_title', 'pull_request_title', 'subject');
        const head = pickString(args, 'head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from_branch', 'branch');
        const base = pickString(args, 'base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into_branch');
        if (title === undefined || head === undefined || base === undefined) {
          return { ok: false, message: 'Missing required argument(s): title, head, base' };
        }
        const body = pickString(args, 'body', 'description', 'content', 'text');
        const pull = createPullRequestInStore(store, repo, { headRefName: head, baseRefName: base, title, body: body ?? '' });
        return { ok: true, value: pullJson(store, repo, pull) };
      }
      case 'merge_pull_request': {
        const repo = getRepoOrNull(store, args);
        if (repo === null) {
          const { owner, repo: repoName } = repoArgsOf(args);
          return { ok: false, message: `Repository not found: ${owner ?? ''}/${repoName ?? ''}` };
        }
        const number = pickNumber(args, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index');
        if (number === undefined) return { ok: false, message: 'Missing required argument(s): pull_number' };
        const pull = repo.pulls.find((entry) => entry.number === number);
        if (pull === undefined) return { ok: false, message: `Pull request #${number} not found` };
        const merged = mergePullRequestInStore(store, repo, pull);
        return { ok: true, value: pullJson(store, repo, merged) };
      }
      default:
        return { ok: false, message: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// -------------------------------------------------------------------------------------------
// JSON-RPC dispatch.
// -------------------------------------------------------------------------------------------

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function capabilities(): Record<string, unknown> {
  return { tools: {} };
}

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: capabilities(),
    serverInfo: serverInfo(),
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
  };
}

function negotiateVersion(requested: unknown): string {
  if (typeof requested === 'string' && (SUPPORTED_VERSIONS as readonly string[]).includes(requested)) return requested;
  return CURRENT_REVISION;
}

function dispatch(store: Store, body: Record<string, unknown>): { status: number; payload: Record<string, unknown> | null } {
  const id: JsonRpcId = typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};

  // Notifications (no id) are fire-and-forget: 202, no body.
  if (body.id === undefined) {
    return { status: 202, payload: null };
  }

  switch (method) {
    case 'server/discover':
      return { status: 200, payload: rpcResult(id, discoverResult()) };
    case 'initialize': {
      const protocolVersion = negotiateVersion(params.protocolVersion);
      return {
        status: 200,
        payload: rpcResult(id, { protocolVersion, capabilities: capabilities(), serverInfo: serverInfo() }),
      };
    }
    case 'ping':
      return { status: 200, payload: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, payload: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (findTool(name) === undefined) {
        return { status: 200, payload: rpcError(id, -32601, `Method not found: unknown tool "${name}"`) };
      }
      const outcome = callTool(store, name, args);
      if (outcome.ok) return { status: 200, payload: rpcResult(id, toolResult(outcome.value)) };
      return { status: 200, payload: rpcResult(id, toolResult({ error: outcome.message }, true)) };
    }
    case 'resources/list':
      return { status: 200, payload: rpcResult(id, { resources: [] }) };
    case 'prompts/list':
      return { status: 200, payload: rpcResult(id, { prompts: [] }) };
    default:
      return { status: 200, payload: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

/**
 * POST /mcp. Returns true when this request is ours (path /mcp); otherwise
 * false without touching the response, so the router can 404 it.
 * Without a matching bearer token the answer is exactly 401. A body that is
 * not JSON is HTTP 400 with JSON-RPC -32700.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let path = '/';
  try {
    path = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    path = '/';
  }
  if (path !== '/mcp') return false;

  // A legacy session DELETE is best-effort teardown: 204, no body.
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' }, requestIdOf(store));
    return true;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' }, requestIdOf(store));
    return true;
  }
  let text: string;
  try {
    text = await readBody(req);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error: could not read the request body'), requestIdOf(store));
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error: request body is not valid JSON'), requestIdOf(store));
    return true;
  }
  if (Array.isArray(body)) {
    // MCP has no batching: answer the first entry's shape as invalid-request.
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request: batch requests are not supported'), requestIdOf(store));
    return true;
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    sendJson(res, 400, rpcError(isRecord(body) && (typeof body.id === 'string' || typeof body.id === 'number') ? body.id : null, -32600, 'Invalid Request'), requestIdOf(store));
    return true;
  }
  const { status, payload } = dispatch(store, body);
  if (payload === null) {
    res.writeHead(status);
    res.end();
    return true;
  }
  sendJson(res, status, payload, requestIdOf(store));
  return true;
}
