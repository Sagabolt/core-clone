// REST v3 handlers for the github-core-clone-01 forge (module B).
//
// Every handler in this file speaks the GitHub REST v3 surface the suite checks
// (repos / issues / pulls / protocol groups in checks-rest.ts): JSON replies,
// X-GitHub-Request-Id on every reply, Bearer auth against
// process.env.MAKEFUN_SHOP_TOKEN (except GET /api/v3/ root), 404 JSON for
// unknown routes and foreign owners, 400 for a malformed JSON body.
//
// The module is self-contained on purpose: it only takes the Store as a value
// (passed in by app.ts) and imports store.ts as *types* only, so it runs even
// before store.ts exists. The small git-object helpers it needs (SHA-1 ids,
// blob/tree/commit encode + parse, tree flatten/rebuild, ancestry) live here
// because the store contract carries raw objects only; see DESIGN-NOTES-B.md.
//
// Determinism: no wall-clock calls and no unseeded randomness anywhere in
// this file. All timestamps come from store.nowIso(); epoch seconds are
// derived from that ISO string with pure integer civil-date arithmetic.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { Issue, Pull, Repo, Store } from './store.ts';

// -------------------------------------------------------------------------------------------
// Errors and small HTTP plumbing
// -------------------------------------------------------------------------------------------

/** An HTTP error that becomes a JSON `{message}` reply. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function notFound(message = 'Not Found'): ApiError {
  return new ApiError(404, message);
}

function unauthorized(message = 'Requires authentication'): ApiError {
  return new ApiError(401, message);
}

interface Ctx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  reqId: string;
  query: URLSearchParams;
  /** Path segments after `/api/v3`, decoded. */
  segments: string[];
}

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(ctx: Ctx, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': ctx.reqId,
    ...extra,
  };
  if (status === 204) {
    ctx.res.writeHead(204, headers);
    ctx.res.end();
    return;
  }
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  headers['content-length'] = String(buf.length);
  ctx.res.writeHead(status, headers);
  ctx.res.end(buf);
}

function sendError(ctx: Ctx, err: unknown): void {
  if (err instanceof ApiError) {
    sendJson(ctx, err.status, { message: err.message });
    return;
  }
  sendJson(ctx, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
}

/** Read the whole request body as text. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString('utf8');
}

type JsonBody = Record<string, unknown>;

/** Parse a JSON object body; empty body is `{}`; malformed JSON is a 400. */
async function readJsonBody(ctx: Ctx): Promise<JsonBody> {
  const text = await readBody(ctx.req);
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Malformed JSON body');
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonBody;
  return {};
}

function bodyString(body: JsonBody, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function bodyBoolean(body: JsonBody, field: string): boolean | undefined {
  const value = body[field];
  return typeof value === 'boolean' ? value : undefined;
}

/** Bearer auth: every /api/v3 route except GET /api/v3/ root requires the env token. */
function requireAuth(ctx: Ctx): void {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = ctx.req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (expected === '' || token === '' || token !== expected) throw unauthorized();
}

// -------------------------------------------------------------------------------------------
// Deterministic civil-date arithmetic (no Date anywhere in this file)
// -------------------------------------------------------------------------------------------

const SCENARIO_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z, DESIGN §0

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Epoch seconds -> `YYYY-MM-DDTHH:MM:SSZ`. */
export function epochToIso(sec: number): string {
  const days = Math.floor(sec / 86400);
  const rem = sec - days * 86400;
  const [y, m, d] = civilFromDays(days);
  return `${y}-${pad2(m)}-${pad2(d)}T${pad2(Math.floor(rem / 3600))}:${pad2(Math.floor((rem % 3600) / 60))}:${pad2(rem % 60)}Z`;
}

/** `YYYY-MM-DDTHH:MM:SSZ` (or with an offset) -> epoch seconds; falls back to the scenario epoch. */
export function isoToEpoch(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (m === null) return SCENARIO_EPOCH_SEC;
  const days = daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3]));
  return days * 86400 + Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6]);
}

/** Epoch seconds for a commit authored "now" (deterministic: from store.nowIso()). */
function nowEpoch(store: Store): number {
  return isoToEpoch(store.nowIso());
}

// -------------------------------------------------------------------------------------------
// Pagination
// -------------------------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  let perPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  let page = Number.parseInt(query.get('page') ?? '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { slice: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { slice: items.slice(start, start + perPage), totalPages };
}

/** Absolute pagination Link header value, preserving the other query params. */
function linkHeader(ctx: Ctx, basePath: string, page: number, perPage: number, totalPages: number): string | null {
  const host = ctx.req.headers.host ?? 'localhost';
  const kept = new URLSearchParams();
  for (const [key, value] of ctx.query) {
    if (key !== 'page' && key !== 'per_page') kept.set(key, value);
  }
  const build = (p: number): string => {
    const q = new URLSearchParams(kept);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `http://${host}${basePath}?${q.toString()}`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${build(page + 1)}>; rel="next"`);
  if (totalPages > 1) parts.push(`<${build(totalPages)}>; rel="last"`);
  return parts.length === 0 ? null : parts.join(', ');
}

/** Send a paginated list with a Link header when there is a next/last page. */
function sendList<T>(ctx: Ctx, basePath: string, items: readonly T[]): void {
  const { page, perPage } = pageParams(ctx.query);
  const { slice, totalPages } = paginate(items, page, perPage);
  const link = linkHeader(ctx, basePath, page, perPage, totalPages);
  sendJson(ctx, 200, slice, link === null ? {} : { link });
}

// -------------------------------------------------------------------------------------------
// Minimal git object layer (blob / tree / commit) over the store's raw objects.
// The store keeps objects as {type, data}; these helpers encode, decode and hash
// them exactly as DESIGN §3 specifies, without depending on src/git-objects.ts.
// -------------------------------------------------------------------------------------------

type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, space);
    if (space === -1 || nul === -1 || nul + 21 > data.length) break;
    entries.push({
      mode: data.toString('utf8', off, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorEpoch: number;
  committerName: string;
  committerEmail: string;
  committerEpoch: number;
  message: string;
}

function parsePerson(line: string): { name: string; email: string; epoch: number } {
  const m = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (m === null) return { name: line, email: '', epoch: SCENARIO_EPOCH_SEC };
  return { name: m[1] ?? '', email: m[2] ?? '', epoch: Number(m[3]) };
}

function parseCommit(data: Buffer): ParsedCommit | null {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  if (split === -1) return null;
  const parsed: ParsedCommit = {
    tree: '',
    parents: [],
    authorName: '',
    authorEmail: '',
    authorEpoch: SCENARIO_EPOCH_SEC,
    committerName: '',
    committerEmail: '',
    committerEpoch: SCENARIO_EPOCH_SEC,
    message: '',
  };
  for (const line of text.slice(0, split).split('\n')) {
    if (line.startsWith('tree ')) parsed.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parsed.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const person = parsePerson(line.slice(7));
      parsed.authorName = person.name;
      parsed.authorEmail = person.email;
      parsed.authorEpoch = person.epoch;
    } else if (line.startsWith('committer ')) {
      const person = parsePerson(line.slice(10));
      parsed.committerName = person.name;
      parsed.committerEmail = person.email;
      parsed.committerEpoch = person.epoch;
    }
  }
  let message = text.slice(split + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  parsed.message = message;
  return parsed.tree === '' ? null : parsed;
}

function encodeCommit(tree: string, parents: readonly string[], message: string, name: string, email: string, epoch: number): Buffer {
  let out = `tree ${tree}\n`;
  for (const parent of parents) out += `parent ${parent}\n`;
  out += `author ${name} <${email}> ${epoch} +0000\n`;
  out += `committer ${name} <${email}> ${epoch} +0000\n`;
  out += `\n${message}\n`;
  return Buffer.from(out, 'utf8');
}

/** Create a commit object in the store; author/committer are the viewer. */
function makeCommit(store: Store, repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
  const viewer = store.viewer;
  const email = viewer.email !== '' ? viewer.email : `${viewer.login}@example.invalid`;
  return putObject(repo, 'commit', encodeCommit(treeOid, parents, message, viewer.login, email, nowEpoch(store)));
}

function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  return parsed === null ? null : parsed.tree;
}

interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree to `path -> {oid, mode}` for files only. */
function flattenTree(repo: Repo, treeOid: string | null, prefix: string, out: Map<string, FlatEntry>): void {
  if (treeOid === null) return;
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
}

function flatOfTree(repo: Repo, treeOid: string | null): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  flattenTree(repo, treeOid, '', out);
  return out;
}

interface BuildItem {
  rel: string;
  oid: string;
  mode: string;
}

function buildTreeLevel(repo: Repo, items: readonly BuildItem[]): string {
  const entries: TreeEntry[] = [];
  const dirs = new Map<string, BuildItem[]>();
  for (const item of items) {
    const slash = item.rel.indexOf('/');
    if (slash === -1) {
      entries.push({ mode: item.mode, name: item.rel, oid: item.oid });
    } else {
      const dir = item.rel.slice(0, slash);
      const rest = item.rel.slice(slash + 1);
      const bucket = dirs.get(dir);
      if (bucket === undefined) dirs.set(dir, [{ rel: rest, oid: item.oid, mode: item.mode }]);
      else bucket.push({ rel: rest, oid: item.oid, mode: item.mode });
    }
  }
  for (const [dir, sub] of dirs) entries.push({ mode: '40000', name: dir, oid: buildTreeLevel(repo, sub) });
  return putObject(repo, 'tree', encodeTree(entries));
}

/** Rebuild a whole tree from a flat path map (also yields the empty tree). */
function buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, FlatEntry>): string {
  const items: BuildItem[] = [];
  for (const [path, entry] of flat) items.push({ rel: path, oid: entry.oid, mode: entry.mode });
  return buildTreeLevel(repo, items);
}

/** All ancestors of a commit (including itself), via the parent chain. */
function commitAncestors(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    if (parsed !== null) for (const parent of parsed.parents) stack.push(parent);
  }
  return seen;
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitAncestors(repo, descendant).has(ancestor);
}

/** First common ancestor of two tips (walking the second tip's history breadth-first). */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = commitAncestors(repo, a);
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    if (parsed !== null) for (const parent of parsed.parents) queue.push(parent);
  }
  return null;
}

/** Commits reachable from a tip, newest first (depth-first pre-order). */
function listCommitOids(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    const parsed = parseCommit(obj.data);
    if (parsed !== null) for (const parent of parsed.parents) stack.push(parent);
  }
  return out;
}

/** Resolve a `?ref=` / `?sha=` value (branch name, full ref, or commit oid) to a tip oid. */
function resolveRefTip(repo: Repo, ref: string | undefined, fallbackBranch: string): string | null {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${fallbackBranch}`) ?? null;
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`) as string;
  if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
  const obj = repo.objects.get(ref);
  if (obj !== undefined && obj.type === 'commit') return ref;
  return null;
}

/** The tree oid at a path inside a tree (`''` is the tree itself); null when absent. */
function treeAtPath(repo: Repo, treeOid: string, dirPath: string): string | null {
  if (dirPath === '') return treeOid;
  let current = treeOid;
  for (const segment of dirPath.split('/')) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const found = parseTree(obj.data).find((entry) => entry.name === segment && entry.mode === '40000');
    if (found === undefined) return null;
    current = found.oid;
  }
  return current;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function blobLines(repo: Repo, oid: string): number {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'blob') return 0;
  return lineCount(obj.data);
}

// -------------------------------------------------------------------------------------------
// JSON shapes (GitHub REST v3, fields the suite's *Shape checks require)
// -------------------------------------------------------------------------------------------

function viewerUserJson(store: Store): Record<string, unknown> {
  return { login: store.viewer.login, id: store.viewer.id, type: 'User' };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length;
  const openPulls = repo.pulls.filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: viewerUserJson(store),
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    html_url: `https://github.com/${repo.full_name}`,
    clone_url: `https://github.com/${repo.full_name}.git`,
    git_url: `git://github.com/${repo.full_name}.git`,
    ssh_url: `git@github.com:${repo.full_name}.git`,
    homepage: '',
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues + openPulls,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? '',
    url: `/api/v3/repos/${repo.full_name}/labels/${encodeURIComponent(name)}`,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: viewerUserJson(store),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: `https://github.com/${repo.full_name}/issues/${issue.number}`,
    comments: issue.comments.length,
    comments_url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}/comments`,
  };
}

function commentJson(store: Store, repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    created_at: comment.created_at,
    updated_at: comment.created_at,
    user: viewerUserJson(store),
    html_url: `https://github.com/${repo.full_name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

function commitPerson(name: string, email: string, epoch: number): Record<string, unknown> {
  return { name, email, date: epochToIso(epoch) };
}

function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  if (parsed === null) return null;
  return {
    sha: oid,
    commit: {
      message: parsed.message,
      author: commitPerson(parsed.authorName, parsed.authorEmail, parsed.authorEpoch),
      committer: commitPerson(parsed.committerName, parsed.committerEmail, parsed.committerEpoch),
    },
    parents: parsed.parents.map((sha) => ({ sha })),
    tree: { sha: parsed.tree },
    url: `/api/v3/repos/${repo.full_name}/commits/${oid}`,
    html_url: `https://github.com/${repo.full_name}/commit/${oid}`,
  };
}

/** Refresh a pull's base sha to the base branch's current tip (GitHub behaviour). */
function refreshPullBase(repo: Repo, pull: Pull): void {
  const tip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (tip !== undefined && tip !== pull.base.sha) pull.base.sha = tip;
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  refreshPullBase(repo, pull);
  if (pull.state === 'open') pull.mergeable = !pullIsConflicted(store, repo, pull);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    merged: pull.merged,
    mergeable: pull.mergeable,
    merge_commit_sha: pull.merge_commit_sha,
    merged_at: pull.merged_at,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    html_url: `https://github.com/${repo.full_name}/pull/${pull.number}`,
    user: viewerUserJson(store),
  };
}

// -------------------------------------------------------------------------------------------
// Shared numbering and the shared create/merge operations (also used by src/mcp.ts)
// -------------------------------------------------------------------------------------------

/**
 * Issues and pull requests share one counter per repository (GitHub numbering).
 * Both store counters are kept in sync, and the max of the counters and the
 * numbers already used wins, so a number is never reused even if another
 * module only bumps one of the two counters.
 */
function nextSharedNumber(repo: Repo): number {
  let n = 1;
  if (repo.issueSeq > n) n = repo.issueSeq;
  if (repo.pullSeq > n) n = repo.pullSeq;
  for (const issue of repo.issues) if (issue.number >= n) n = issue.number + 1;
  for (const pull of repo.pulls) if (pull.number >= n) n = pull.number + 1;
  repo.issueSeq = n + 1;
  repo.pullSeq = n + 1;
  return n;
}

export interface CreateIssueInput {
  title: string;
  body?: string;
  labels?: Array<string | { name: string }>;
}

/** Create an issue in the store; throws ApiError 422 on an unknown label. */
export function createIssue(store: Store, repo: Repo, input: CreateIssueInput): Issue {
  if (typeof input.title !== 'string' || input.title === '') throw new ApiError(422, 'title is required');
  const labelNames: string[] = [];
  for (const label of input.labels ?? []) {
    const name = typeof label === 'string' ? label : label.name;
    if (!repo.labels.has(name)) throw new ApiError(422, `Label '${name}' does not exist`);
    labelNames.push(name);
  }
  const number = nextSharedNumber(repo);
  const now = store.nowIso();
  const issue: Issue = {
    id: 100000 + repo.id * 1000 + number,
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: labelNames,
    comments: [],
    created_at: now,
    updated_at: now,
    user: store.viewer.login,
  };
  repo.issues.push(issue);
  return issue;
}

export interface CreatePullInput {
  title: string;
  body?: string;
  head: string;
  base?: string;
}

function stripRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

/** Files changed between the pull's merge-base and its head tip. */
export function computePullFiles(store: Store, repo: Repo, pull: Pull): PullFile[] {
  const base = mergeBase(repo, pull.head.sha, pull.base.sha);
  const baseTree = base === null ? treeOfCommit(repo, pull.base.sha) : treeOfCommit(repo, base);
  const headTree = treeOfCommit(repo, pull.head.sha);
  const baseMap = flatOfTree(repo, baseTree);
  const headMap = flatOfTree(repo, headTree);
  const files: PullFile[] = [];
  for (const [path, head] of headMap) {
    const old = baseMap.get(path);
    if (old === undefined) {
      const additions = blobLines(repo, head.oid);
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (old.oid !== head.oid) {
      const additions = blobLines(repo, head.oid);
      const deletions = blobLines(repo, old.oid);
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  for (const [path, old] of baseMap) {
    if (!headMap.has(path)) {
      const deletions = blobLines(repo, old.oid);
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    }
  }
  files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return files;
}

/**
 * True when the pull cannot merge cleanly: head and base both changed the same
 * path (relative to their merge-base) to different contents, and the base tip
 * is not an ancestor of the head tip. When in doubt (no overlapping changed
 * path, or base is an ancestor of head) the pull is mergeable.
 */
export function pullIsConflicted(store: Store, repo: Repo, pull: Pull): boolean {
  void store;
  const headTip = pull.head.sha;
  const baseTip = pull.base.sha;
  if (isAncestor(repo, baseTip, headTip)) return false;
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return false;
  const baseMap = flatOfTree(repo, treeOfCommit(repo, base));
  const headMap = flatOfTree(repo, treeOfCommit(repo, headTip));
  const tipMap = flatOfTree(repo, treeOfCommit(repo, baseTip));
  for (const [path, head] of headMap) {
    const old = baseMap.get(path);
    if (old === undefined) continue;
    if (head.oid === old.oid) continue;
    const tip = tipMap.get(path);
    if (tip === undefined) return true; // base deleted a file the head modified
    if (tip.oid !== old.oid && tip.oid !== head.oid) return true;
  }
  for (const [path, old] of baseMap) {
    if (headMap.has(path)) continue;
    const tip = tipMap.get(path);
    if (tip !== undefined && tip.oid !== old.oid) return true; // head deleted, base modified
  }
  return false;
}

/** Create a pull request in the store; throws ApiError 422 on an unknown branch. */
export function createPullRequest(store: Store, repo: Repo, input: CreatePullInput): Pull {
  if (typeof input.title !== 'string' || input.title === '') throw new ApiError(422, 'title is required');
  const headRef = stripRef(input.head);
  const baseRef = stripRef(input.base ?? repo.default_branch);
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  if (headSha === undefined) throw new ApiError(422, `Head branch '${headRef}' does not exist`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (baseSha === undefined) throw new ApiError(422, `Base branch '${baseRef}' does not exist`);
  const number = nextSharedNumber(repo);
  const now = store.nowIso();
  const pull: Pull = {
    id: 100000 + repo.id * 1000 + number,
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    head: { ref: headRef, sha: headSha },
    base: { ref: baseRef, sha: baseSha },
    merged: false,
    mergeable: true,
    merge_commit_sha: null,
    merged_at: null,
    files: [],
    created_at: now,
    updated_at: now,
  };
  pull.files = computePullFiles(store, repo, pull);
  pull.mergeable = !pullIsConflicted(store, repo, pull);
  repo.pulls.push(pull);
  return pull;
}

export interface MergePullOptions {
  merge_method?: string;
  commit_message?: string;
}

export interface MergePullResult {
  sha: string;
  merged: boolean;
  message: string;
  pull: Pull;
}

/**
 * Squash-merge a pull request: one commit on the base branch whose tree is the
 * base tree with the head's changes (relative to the merge-base) applied.
 * Throws ApiError 404 (unknown pull) or 405 (already closed / conflicted).
 */
export function mergePullRequest(store: Store, repo: Repo, number: number, opts: MergePullOptions = {}): MergePullResult {
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (pull === undefined) throw notFound('Pull request not found');
  if (pull.state === 'closed') {
    throw new ApiError(405, pull.merged ? 'Pull request already merged' : 'Pull request is closed');
  }
  refreshPullBase(repo, pull);
  if (pullIsConflicted(store, repo, pull)) throw new ApiError(405, 'Merge conflict');
  const headTip = pull.head.sha;
  const baseTip = pull.base.sha;
  const base = mergeBase(repo, headTip, baseTip);
  const baseMap = flatOfTree(repo, treeOfCommit(repo, baseTip));
  const merged = new Map<string, FlatEntry>(baseMap);
  if (base !== null) {
    const baseOld = flatOfTree(repo, treeOfCommit(repo, base));
    const headMap = flatOfTree(repo, treeOfCommit(repo, headTip));
    for (const [path, head] of headMap) {
      const old = baseOld.get(path);
      if (old === undefined || old.oid !== head.oid) merged.set(path, head);
    }
    for (const path of baseOld.keys()) {
      if (!headMap.has(path)) merged.delete(path);
    }
  } else {
    for (const [path, head] of flatOfTree(repo, treeOfCommit(repo, headTip))) merged.set(path, head);
  }
  const treeOid = buildTreeFromFlat(repo, merged);
  const message = opts.commit_message ?? `Merge pull request #${pull.number} from ${pull.head.ref}${pull.body !== '' ? `\n\n${pull.body}` : ''}`;
  const mergeSha = makeCommit(store, repo, treeOid, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.base.ref}`, mergeSha);
  const now = store.nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeable = false;
  pull.merge_commit_sha = mergeSha;
  pull.merged_at = now;
  pull.updated_at = now;
  repo.updated_at = now;
  repo.pushed_at = now;
  return { sha: mergeSha, merged: true, message, pull };
}

// -------------------------------------------------------------------------------------------
// Routing: handleRest(req, res, store) — true when a /api/v3 route was answered.
// -------------------------------------------------------------------------------------------

/** Look a repository up for the viewer; any other owner (or a missing repo) is a 404. */
function viewerRepo(ctx: Ctx, owner: string, name: string): Repo {
  if (owner !== ctx.store.viewer.login) throw notFound('Not Found');
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) throw notFound('Not Found');
  return repo;
}

function parseNumber(segment: string): number {
  if (!/^\d+$/.test(segment)) throw notFound('Not Found');
  return Number(segment);
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

async function routeRoot(ctx: Ctx): Promise<void> {
  // GET /api/v3/ — the one route that answers without auth (as the starter did).
  sendJson(ctx, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
}

async function routeMeta(ctx: Ctx): Promise<void> {
  sendJson(ctx, 200, { installed_version: '1.0.0' });
}

async function routeUser(ctx: Ctx): Promise<void> {
  const viewer = ctx.store.viewer;
  sendJson(ctx, 200, {
    login: viewer.login,
    id: viewer.id,
    type: 'User',
    name: viewer.login,
    email: viewer.email,
    avatar_url: '',
    html_url: `https://github.com/${viewer.login}`,
    url: '/api/v3/user',
    site_admin: false,
    created_at: epochToIso(SCENARIO_EPOCH_SEC),
    updated_at: epochToIso(SCENARIO_EPOCH_SEC),
  });
}

async function routeUserRepos(ctx: Ctx): Promise<void> {
  const method = ctx.req.method ?? 'GET';
  const viewer = ctx.store.viewer;
  if (method === 'GET') {
    const repos: Repo[] = [];
    for (const repo of ctx.store.repos.values()) {
      if (repo.owner === viewer.login) repos.push(repo);
    }
    sendList(ctx, '/api/v3/user/repos', repos.map((repo) => repoJson(ctx.store, repo)));
    return;
  }
  if (method === 'POST') {
    const body = await readJsonBody(ctx);
    const name = bodyString(body, 'name');
    if (name === undefined || name === '') {
      throw new ApiError(422, 'Repository creation failed.');
    }
    if (ctx.store.getRepo(viewer.login, name) !== undefined) {
      // GitHub's duplicate-name 422 (DESIGN.md §4). The wording matters:
      // the kit's git client treats a 422 as "already exists" only when
      // the body says so, and the GraphQL fixture re-creates its repo
      // before pushing branches — without this text that fixture fails.
      sendJson(ctx, 422, {
        message: 'Repository creation failed.',
        errors: [
          {
            resource: 'Repository',
            code: 'custom',
            field: 'name',
            message: 'name already exists on this account',
          },
        ],
      });
      return;
    }
    const repo = ctx.store.createRepo(name, {
      description: bodyString(body, 'description') ?? '',
      private: bodyBoolean(body, 'private') ?? false,
      default_branch: bodyString(body, 'default_branch'),
    });
    sendJson(ctx, 201, repoJson(ctx.store, repo));
    return;
  }
  throw notFound();
}

async function routeRepo(ctx: Ctx, owner: string, name: string): Promise<void> {
  const method = ctx.req.method ?? 'GET';
  const repo = viewerRepo(ctx, owner, name);
  if (method === 'GET') {
    sendJson(ctx, 200, repoJson(ctx.store, repo));
    return;
  }
  if (method === 'PATCH') {
    const body = await readJsonBody(ctx);
    const description = bodyString(body, 'description');
    if (description !== undefined) repo.description = description;
    const isPrivate = bodyBoolean(body, 'private');
    if (isPrivate !== undefined) repo.private = isPrivate;
    const branch = bodyString(body, 'default_branch');
    if (branch !== undefined && branch !== '') repo.default_branch = branch;
    repo.updated_at = ctx.store.nowIso();
    sendJson(ctx, 200, repoJson(ctx.store, repo));
    return;
  }
  if (method === 'DELETE') {
    ctx.store.deleteRepo(owner, name);
    sendJson(ctx, 204, null);
    return;
  }
  throw notFound();
}

async function routeBranches(ctx: Ctx, owner: string, name: string): Promise<void> {
  const repo = viewerRepo(ctx, owner, name);
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  sendJson(ctx, 200, branches);
}

async function routeGitRefs(ctx: Ctx, owner: string, name: string, rest: readonly string[]): Promise<void> {
  const method = ctx.req.method ?? 'GET';
  const repo = viewerRepo(ctx, owner, name);
  if (method === 'POST' && rest.length === 0) {
    const body = await readJsonBody(ctx);
    const ref = bodyString(body, 'ref');
    const sha = bodyString(body, 'sha');
    if (ref === undefined || !ref.startsWith('refs/')) throw new ApiError(422, 'ref is required and must start with refs/');
    if (sha === undefined || sha === '') throw new ApiError(422, 'sha is required');
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') throw new ApiError(422, 'sha does not name a commit');
    if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    sendJson(ctx, 201, { ref, object: { sha, type: 'commit' } });
    return;
  }
  if (method === 'GET') {
    if (rest.length === 0) {
      const all: Array<Record<string, unknown>> = [];
      for (const [ref, sha] of repo.refs) all.push({ ref, object: { sha, type: 'commit' } });
      sendJson(ctx, 200, all);
      return;
    }
    const ref = `refs/${rest.join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) throw notFound('Not Found');
    sendJson(ctx, 200, { ref, object: { sha, type: 'commit' } });
    return;
  }
  throw notFound();
}

async function routeCommits(ctx: Ctx, owner: string, name: string, rest: readonly string[]): Promise<void> {
  const repo = viewerRepo(ctx, owner, name);
  if (rest.length === 0) {
    const tip = resolveRefTip(repo, ctx.query.get('sha') ?? undefined, repo.default_branch);
    if (tip === null) {
      sendJson(ctx, 200, []);
      return;
    }
    const commits: Array<Record<string, unknown>> = [];
    for (const oid of listCommitOids(repo, tip)) {
      const json = commitJson(ctx.store, repo, oid);
      if (json !== null) commits.push(json);
    }
    sendList(ctx, `/api/v3/repos/${owner}/${name}/commits`, commits);
    return;
  }
  if (rest.length === 1) {
    const tip = resolveRefTip(repo, rest[0], repo.default_branch);
    if (tip === null) throw notFound('Not Found');
    const json = commitJson(ctx.store, repo, tip);
    if (json === null) throw notFound('Not Found');
    sendJson(ctx, 200, json);
    return;
  }
  throw notFound();
}

function dirListing(ctx: Ctx, repo: Repo, treeOid: string, dirPath: string): Array<Record<string, unknown>> {
  const target = treeAtPath(repo, treeOid, dirPath);
  if (target === null) throw notFound('Not Found');
  const obj = repo.objects.get(target);
  if (obj === undefined || obj.type !== 'tree') throw notFound('Not Found');
  const entries: Array<Record<string, unknown>> = [];
  for (const entry of parseTree(obj.data)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    if (entry.mode === '40000') {
      entries.push({ type: 'dir', name: entry.name, path, sha: entry.oid, size: 0 });
    } else {
      const blob = repo.objects.get(entry.oid);
      entries.push({ type: 'file', name: entry.name, path, sha: entry.oid, size: blob === undefined ? 0 : blob.data.length });
    }
  }
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return entries;
}

async function routeContents(ctx: Ctx, owner: string, name: string, rest: readonly string[]): Promise<void> {
  const method = ctx.req.method ?? 'GET';
  const repo = viewerRepo(ctx, owner, name);
  const path = rest.join('/');
  if (method === 'GET') {
    const tip = resolveRefTip(repo, ctx.query.get('ref') ?? undefined, repo.default_branch);
    if (tip === null) throw notFound('Not Found');
    const treeOid = treeOfCommit(repo, tip);
    if (treeOid === null) throw notFound('Not Found');
    const flat = flatOfTree(repo, treeOid);
    const file = flat.get(path);
    if (file !== undefined) {
      const blob = repo.objects.get(file.oid);
      const bytes = blob === undefined ? Buffer.alloc(0) : blob.data;
      sendJson(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        content: bytes.toString('base64'),
        sha: file.oid,
        size: bytes.length,
        name: baseName(path),
        path,
      });
      return;
    }
    sendJson(ctx, 200, dirListing(ctx, repo, treeOid, path));
    return;
  }
  if (method === 'PUT') {
    const body = await readJsonBody(ctx);
    const content = bodyString(body, 'content');
    if (content === undefined || content === '') throw new ApiError(422, 'content is required');
    const bytes = Buffer.from(content, 'base64');
    const branch = bodyString(body, 'branch') ?? repo.default_branch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined && repo.refs.size > 0) throw new ApiError(422, `Branch '${branch}' does not exist`);
    const flat = flatOfTree(repo, tip === undefined ? null : treeOfCommit(repo, tip));
    const existing = flat.get(path);
    const givenSha = bodyString(body, 'sha');
    if (existing !== undefined) {
      if (givenSha === undefined) throw new ApiError(422, 'sha is required to update a file');
      if (givenSha.toLowerCase() !== existing.oid.toLowerCase()) throw new ApiError(409, 'sha does not match the current blob');
    }
    const blobOid = putObject(repo, 'blob', bytes);
    flat.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = buildTreeFromFlat(repo, flat);
    const message = bodyString(body, 'message') ?? '';
    const commitOid = makeCommit(ctx.store, repo, treeOid, tip === undefined ? [] : [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    const now = ctx.store.nowIso();
    repo.updated_at = now;
    repo.pushed_at = now;
    const viewer = ctx.store.viewer;
    const email = viewer.email !== '' ? viewer.email : `${viewer.login}@example.invalid`;
    const author = { name: viewer.login, email, date: now };
    sendJson(ctx, existing !== undefined ? 200 : 201, {
      content: { name: baseName(path), path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64', content: bytes.toString('base64') },
      commit: { sha: commitOid, message, author, committer: author },
    });
    return;
  }
  if (method === 'DELETE') {
    const body = await readJsonBody(ctx);
    const branch = bodyString(body, 'branch') ?? repo.default_branch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) throw notFound('Not Found');
    const flat = flatOfTree(repo, treeOfCommit(repo, tip));
    const existing = flat.get(path);
    if (existing === undefined) throw notFound('Not Found');
    const givenSha = bodyString(body, 'sha');
    if (givenSha !== undefined && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
      throw new ApiError(409, 'sha does not match the current blob');
    }
    flat.delete(path);
    const treeOid = buildTreeFromFlat(repo, flat);
    const message = bodyString(body, 'message') ?? `Delete ${path}`;
    const commitOid = makeCommit(ctx.store, repo, treeOid, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    const now = ctx.store.nowIso();
    repo.updated_at = now;
    repo.pushed_at = now;
    const viewer = ctx.store.viewer;
    const email = viewer.email !== '' ? viewer.email : `${viewer.login}@example.invalid`;
    const author = { name: viewer.login, email, date: now };
    sendJson(ctx, 200, { commit: { sha: commitOid, message, author, committer: author } });
    return;
  }
  throw notFound();
}

async function routeLabels(ctx: Ctx, owner: string, name: string): Promise<void> {
  const method = ctx.req.method ?? 'GET';
  const repo = viewerRepo(ctx, owner, name);
  if (method === 'GET') {
    const labels: Array<Record<string, unknown>> = [];
    for (const labelName of repo.labels.keys()) labels.push(labelJson(repo, labelName));
    sendJson(ctx, 200, labels);
    return;
  }
  if (method === 'POST') {
    const body = await readJsonBody(ctx);
    const labelName = bodyString(body, 'name');
    if (labelName === undefined || labelName === '') throw new ApiError(422, 'name is required');
    const existing = repo.labels.get(labelName);
    if (existing !== undefined) {
      sendJson(ctx, 201, labelJson(repo, labelName));
      return;
    }
    const color = (bodyString(body, 'color') ?? 'ededed').replace(/^#/, '');
    repo.labels.set(labelName, { name: labelName, color, description: bodyString(body, 'description') ?? '' });
    sendJson(ctx, 201, labelJson(repo, labelName));
    return;
  }
  throw notFound();
}

function sortIssues(issues: readonly Issue[], query: URLSearchParams): Issue[] {
  const sorted = [...issues];
  const direction = query.get('direction') ?? 'desc';
  const compare = (a: Issue, b: Issue): number => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.number - b.number;
  };
  sorted.sort((a, b) => (direction === 'asc' ? compare(a, b) : -compare(a, b)));
  return sorted;
}

async function routeIssues(ctx: Ctx, owner: string, name: string, rest: readonly string[]): Promise<void> {
  const method = ctx.req.method ?? 'GET';
  const repo = viewerRepo(ctx, owner, name);
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = repo.issues;
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      const sorted = sortIssues(list, ctx.query);
      sendList(ctx, `/api/v3/repos/${owner}/${name}/issues`, sorted.map((issue) => issueJson(ctx.store, repo, issue)));
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(ctx);
      const rawLabels = body.labels;
      const labels: Array<string | { name: string }> = Array.isArray(rawLabels)
        ? (rawLabels as Array<string | { name: string }>)
        : [];
      const issue = createIssue(ctx.store, repo, { title: bodyString(body, 'title') ?? '', body: bodyString(body, 'body'), labels });
      sendJson(ctx, 201, issueJson(ctx.store, repo, issue));
      return;
    }
    throw notFound();
  }
  const number = parseNumber(rest[0] as string);
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (issue === undefined) throw notFound('Issue not found');
  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(ctx, 200, issueJson(ctx.store, repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(ctx);
      const state = bodyString(body, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = bodyString(body, 'title');
      if (title !== undefined) issue.title = title;
      const bodyText = bodyString(body, 'body');
      if (bodyText !== undefined) issue.body = bodyText;
      if (Array.isArray(body.labels)) {
        const names = (body.labels as unknown[]).map((label) => (typeof label === 'string' ? label : (label as { name?: unknown }).name));
        for (const labelName of names) {
          if (typeof labelName !== 'string' || !repo.labels.has(labelName)) throw new ApiError(422, `Label '${String(labelName)}' does not exist`);
        }
        issue.labels = names as string[];
      }
      issue.updated_at = ctx.store.nowIso();
      sendJson(ctx, 200, issueJson(ctx.store, repo, issue));
      return;
    }
    throw notFound();
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      sendJson(ctx, 200, issue.comments.map((comment) => commentJson(ctx.store, repo, issue, comment)));
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(ctx);
      const text = bodyString(body, 'body');
      if (text === undefined || text === '') throw new ApiError(422, 'body is required');
      const comment = {
        id: issue.id * 1000 + issue.comments.length + 1,
        body: text,
        created_at: ctx.store.nowIso(),
      };
      issue.comments.push(comment);
      issue.updated_at = ctx.store.nowIso();
      sendJson(ctx, 201, commentJson(ctx.store, repo, issue, comment));
      return;
    }
    throw notFound();
  }
  throw notFound();
}

async function routePulls(ctx: Ctx, owner: string, name: string, rest: readonly string[]): Promise<void> {
  const method = ctx.req.method ?? 'GET';
  const repo = viewerRepo(ctx, owner, name);
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = repo.pulls;
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      const sorted = [...list].sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
        return b.number - a.number;
      });
      sendList(ctx, `/api/v3/repos/${owner}/${name}/pulls`, sorted.map((pull) => pullJson(ctx.store, repo, pull)));
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(ctx);
      const pull = createPullRequest(ctx.store, repo, {
        title: bodyString(body, 'title') ?? '',
        body: bodyString(body, 'body'),
        head: bodyString(body, 'head') ?? '',
        base: bodyString(body, 'base'),
      });
      sendJson(ctx, 201, pullJson(ctx.store, repo, pull));
      return;
    }
    throw notFound();
  }
  const number = parseNumber(rest[0] as string);
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (pull === undefined) throw notFound('Pull request not found');
  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(ctx, 200, pullJson(ctx.store, repo, pull));
      return;
    }
    throw notFound();
  }
  if (rest.length === 2 && rest[1] === 'files') {
    if (method === 'GET') {
      refreshPullBase(repo, pull);
      sendJson(ctx, 200, computePullFiles(ctx.store, repo, pull));
      return;
    }
    throw notFound();
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (method === 'PUT') {
      const body = await readJsonBody(ctx);
      const result = mergePullRequest(ctx.store, repo, number, {
        merge_method: bodyString(body, 'merge_method'),
        commit_message: bodyString(body, 'commit_message'),
      });
      sendJson(ctx, 200, { sha: result.sha, merged: true, message: result.message });
      return;
    }
    throw notFound();
  }
  throw notFound();
}

/** Dispatch one /api/v3 request. Throws ApiError for the error replies. */
async function route(ctx: Ctx): Promise<void> {
  const segments = ctx.segments;
  const method = ctx.req.method ?? 'GET';
  if (segments.length === 0) {
    if (method === 'GET') return routeRoot(ctx);
    throw notFound();
  }
  // Everything below the root requires the bearer token.
  requireAuth(ctx);
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') return routeMeta(ctx);
    throw notFound();
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET') return routeUser(ctx);
    throw notFound();
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    return routeUserRepos(ctx);
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const rest = segments.slice(3);
    if (rest.length === 0) return routeRepo(ctx, owner, name);
    if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') return routeBranches(ctx, owner, name);
    if (rest[0] === 'git' && rest[1] === 'refs') return routeGitRefs(ctx, owner, name, rest.slice(2));
    if (rest[0] === 'commits') return routeCommits(ctx, owner, name, rest.slice(1));
    if (rest[0] === 'contents') return routeContents(ctx, owner, name, rest.slice(1));
    if (rest[0] === 'labels' && rest.length === 1) return routeLabels(ctx, owner, name);
    if (rest[0] === 'issues') return routeIssues(ctx, owner, name, rest.slice(1));
    if (rest[0] === 'pulls') return routePulls(ctx, owner, name, rest.slice(1));
    throw notFound();
  }
  throw notFound();
}

/**
 * Handle one request. Returns true when the path is a /api/v3 route (handled
 * here, errors included); false otherwise, so the caller can try git,
 * GraphQL, MCP or the health probe.
 */
export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    pathname = '/';
  }
  const segments = pathname
    .split('/')
    .filter((piece) => piece.length > 0)
    .map((piece) => {
      try {
        return decodeURIComponent(piece);
      } catch {
        return piece;
      }
    });
  if (segments[0] !== 'api' || segments[1] !== 'v3') return false;
  // The request id comes from the counter app.ts already advanced once
  // for this request; this handler must not advance it again.
  const reqId = `req-${store.reqCounter}`;
  let query: URLSearchParams;
  try {
    query = new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    query = new URLSearchParams();
  }
  const ctx: Ctx = { store, req, res, reqId, query, segments: segments.slice(2) };
  try {
    await route(ctx);
  } catch (err) {
    sendError(ctx, err);
  }
  return true;
}
