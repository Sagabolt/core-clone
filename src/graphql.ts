// src/graphql.ts — GraphQL v4 executor (POST /api/graphql) for the forge.
//
// Speaks the exact documents gh and github-mcp-server send (see the kit's
// GRAPHQL_DOCUMENTS in checks-graphql.ts): viewer/repository reads, __type
// introspection, issue / pull-request reads, createIssue / closeIssue /
// createPullRequest / mergePullRequest / addComment mutations, Relay node(id:),
// cursor pagination and batched operation documents in one body.
//
// No GraphQL library: a small hand-rolled tokenizer + recursive-descent parser
// plus a resolver table over the shared Store. Deterministic: timestamps come
// from store.nowIso() only; no Date.now() / new Date() / Math.random() here.
//
// Shared store mutations (createIssue / createPullRequest / mergePullRequest /
// addComment) live here and are exported so src/mcp.ts calls the same code
// instead of duplicating it. Issue / pull-request creation and merging delegate
// to the shared operations in ./rest.ts (the same code REST uses); closing an
// issue and adding a comment have no REST export, so their (tiny) store
// mutations live here.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Pull, Repo, Store } from './store.ts';
import { createIssue as restCreateIssue, createPullRequest as restCreatePullRequest, mergePullRequest as restMergePullRequest } from './rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const VIEWER_PERMISSION = 'ADMIN';

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

/** The bearer token the suite sends, from the process env (same as REST). */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** True when the request carries the suite's bearer token. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (match === null) return false;
  const expected = expectedToken();
  // The env always sets MAKEFUN_SHOP_TOKEN; if it is ever unset, any non-empty
  // bearer still counts as authenticated (the anonymous case is what 401s).
  return expected === '' ? match[1]!.trim() !== '' : match[1] === expected;
}

/** X-GitHub-Request-Id value: deterministic, from the store's request counter. */
function requestId(store: Store): string {
  const counter = typeof store.reqCounter === 'number' ? store.reqCounter : 0;
  return `req-${counter}`;
}

// -------------------------------------------------------------------------------------------
// Global (Relay) ids — opaque, stable across reads (never the plain database id).
// -------------------------------------------------------------------------------------------

export function repoGlobalId(repo: Repo): string {
  return `R_${repo.id}`;
}

export function issueGlobalId(issue: Issue): string {
  return `I_${issue.id}`;
}

export function pullGlobalId(pull: Pull): string {
  return `PR_${pull.id}`;
}

export function commentGlobalId(issue: Issue, commentId: number): string {
  return `IC_${commentId}`;
}

/** Find a repo by a global id (`R_<databaseId>`), a numeric id, or a numeric string. */
export function findRepoByGlobalId(store: Store, id: unknown): Repo | undefined {
  if (typeof id === 'number' && Number.isInteger(id)) return findRepoByDatabaseId(store, id);
  if (typeof id !== 'string') return undefined;
  const relay = /^R_(\d+)$/.exec(id);
  if (relay !== null) return findRepoByDatabaseId(store, Number(relay[1]));
  if (/^\d+$/.test(id)) return findRepoByDatabaseId(store, Number(id));
  return undefined;
}

export function findRepoByDatabaseId(store: Store, databaseId: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.id === databaseId) return repo;
  }
  return undefined;
}

/** Find an issue anywhere in the store by its global id (`I_<numeric id>`). */
export function findIssueByGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | undefined {
  if (typeof id !== 'string') return undefined;
  const match = /^I_(\d+)$/.exec(id);
  if (match === null) return undefined;
  const numeric = Number(match[1]);
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues) {
      if (issue.id === numeric) return { repo, issue };
    }
  }
  return undefined;
}

/** Find a pull request anywhere in the store by its global id (`PR_<numeric id>`). */
export function findPullByGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } | undefined {
  if (typeof id !== 'string') return undefined;
  const match = /^PR_(\d+)$/.exec(id);
  if (match === null) return undefined;
  const numeric = Number(match[1]);
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls) {
      if (pull.id === numeric) return { repo, pull };
    }
  }
  return undefined;
}

// -------------------------------------------------------------------------------------------
// REST-shaped JSON (DESIGN.md §2) — the same objects REST returns, reused by MCP tool results.
// -------------------------------------------------------------------------------------------

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const ownerId = repo.owner === store.viewer.login ? store.viewer.id : 0;
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner, id: ownerId },
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
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const userId = issue.user === store.viewer.login ? store.viewer.id : 0;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: (issue.labels ?? []).map((name) => ({ name })),
    user: { login: issue.user, id: userId },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: `https://github.com/${repo.full_name}/issues/${issue.number}`,
    comments: issue.comments.length,
    comments_url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}/comments`,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const userId = store.viewer.id;
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
    user: { login: store.viewer.login, id: userId },
  };
}

// -------------------------------------------------------------------------------------------
// Shared store mutations. createIssue / createPullRequest / mergePullRequest
// delegate to the shared operations in ./rest.ts (the same code REST uses);
// closeIssue / addComment have no REST export, so their (tiny) store mutations
// live here. MCP imports these wrappers from here.
// -------------------------------------------------------------------------------------------

export function createIssueInStore(store: Store, repo: Repo, input: { title: string; body?: string }): Issue {
  return restCreateIssue(store, repo, {
    title: typeof input.title === 'string' ? input.title : '',
    body: typeof input.body === 'string' ? input.body : '',
  });
}

export function closeIssueInStore(store: Store, repo: Repo, issue: Issue): Issue {
  issue.state = 'closed';
  issue.updated_at = store.nowIso();
  repo.updated_at = issue.updated_at;
  return issue;
}

export function createPullRequestInStore(
  store: Store,
  repo: Repo,
  input: { headRefName: string; baseRefName: string; title: string; body?: string },
): Pull {
  return restCreatePullRequest(store, repo, {
    title: typeof input.title === 'string' ? input.title : '',
    body: typeof input.body === 'string' ? input.body : '',
    head: typeof input.headRefName === 'string' ? input.headRefName : '',
    base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
  });
}

export function mergePullRequestInStore(store: Store, repo: Repo, pull: Pull): Pull {
  return restMergePullRequest(store, repo, pull.number).pull;
}

export function addCommentInStore(
  store: Store,
  repo: Repo,
  issue: Issue,
  body: string,
): { id: number; body: string; created_at: string } {
  if (body === '') throw new Error('body is required');
  const now = store.nowIso();
  const comment = { id: issue.id * 100 + (issue.comments.length + 1), body, created_at: now };
  issue.comments.push(comment);
  issue.updated_at = now;
  repo.updated_at = now;
  return comment;
}

// -------------------------------------------------------------------------------------------
// GraphQL document parser (tokenizer + recursive descent). Only what the gh /
// github-mcp-server documents use: operations, variables, inline input objects,
// inline enum lists, fragment spreads, inline fragments, aliases, directives
// (skipped). A parse failure is reported as a GraphQL error, never a crash.
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface SelectionNode {
  kind: 'field' | 'fragmentSpread' | 'inlineFragment';
  name?: string;
  alias?: string;
  typeCondition?: string;
  arguments?: ArgumentNode[];
  selections?: SelectionNode[];
}

interface OperationNode {
  kind: 'query' | 'mutation';
  name?: string;
  variables: { name: string; defaultValue?: ValueNode }[];
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$&():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        const raw = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw.replace(/\\"""/g, '"""') });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          if (esc === 'u' && j + 5 < source.length) {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      const raw = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: raw } : { kind: 'int', value: raw });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    // Unknown character: skip it rather than failing the whole document.
    i += 1;
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected "${value}" in GraphQL document`);
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected ${what} in GraphQL document`);
    return token.value;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName('a directive name');
      if (this.isPunct('(')) this.parseArguments();
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName('a fragment name');
        const on = this.expectName('"on"');
        if (on !== 'on') throw new Error('Expected "on" in fragment definition');
        const typeCondition = this.expectName('a type name');
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value;
      this.next();
      if (this.peek().kind === 'name') name = this.next().value as string;
    }
    const variables = this.isPunct('(') ? this.parseVariableDefinitions() : [];
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseVariableDefinitions(): { name: string; defaultValue?: ValueNode }[] {
    const variables: { name: string; defaultValue?: ValueNode }[] = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated variable definitions');
      this.expectPunct('$');
      const name = this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      this.skipDirectives();
      variables.push(defaultValue === undefined ? { name } : { name, defaultValue });
    }
    this.expectPunct(')');
    return variables;
  }

  /** Consume a type reference (`String!`, `[IssueState!]`, …) without keeping it. */
  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    if (this.isPunct('!')) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type name');
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        return { kind: 'inlineFragment', typeCondition, selections };
      }
      if (token.kind === 'name') {
        const name = this.next().value as string;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      throw new Error('Expected a fragment name or "on" after "..."');
    }
    let name = this.expectName('a field name');
    let alias: string | undefined;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName('a field name');
    }
    const args = this.isPunct('(') ? this.parseArguments() : undefined;
    this.skipDirectives();
    const selections = this.isPunct('{') ? this.parseSelectionSet() : undefined;
    return { kind: 'field', name, alias, arguments: args, selections };
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated arguments');
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) {
        if (this.peek().kind === 'eof') throw new Error('Unterminated list value');
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct('}')) {
        if (this.peek().kind === 'eof') throw new Error('Unterminated object value');
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('Unexpected token in GraphQL value');
  }
}

/** Resolve a parsed value against the operation variables (defaults apply). */
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArguments(args: ArgumentNode[] | undefined, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args ?? []) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// -------------------------------------------------------------------------------------------
// Introspection schema table: the field / enum names __type must report.
// -------------------------------------------------------------------------------------------

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR';
  fields?: string[];
  enumValues?: string[];
}

const SCHEMA_TYPES: Record<string, TypeInfo> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'user', 'url', 'labels', 'comments'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'body', 'files', 'createdAt', 'updatedAt', 'author', 'user', 'url'],
  },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'url'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'prefix', 'target'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changes', 'status'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'createdAt', 'author', 'url'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  __Schema: { kind: 'OBJECT', fields: ['description', 'types', 'queryType', 'mutationType', 'subscriptionType', 'directives'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues', 'ofType', 'inputFields', 'interfaces', 'possibleTypes'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description', 'isDeprecated', 'deprecationReason'] },
  __InputValue: { kind: 'OBJECT', fields: ['name', 'description', 'type', 'defaultValue'] },
  __Directive: { kind: 'OBJECT', fields: ['name', 'description', 'locations', 'args'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
};

// -------------------------------------------------------------------------------------------
// Execution: resolver nodes carry a __typename plus their source data.
// -------------------------------------------------------------------------------------------

type NodeValue = Record<string, unknown> & { __typename: string };

interface ExecContext {
  store: Store;
  fragments: Map<string, FragmentNode>;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function userNode(store: Store, login: string): NodeValue {
  return { __typename: 'User', login, id: login === store.viewer.login ? store.viewer.id : 0 };
}

function repoNode(store: Store, repo: Repo): NodeValue {
  return { __typename: 'Repository', repo };
}

function issueNode(store: Store, repo: Repo, issue: Issue): NodeValue {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(store: Store, repo: Repo, pull: Pull): NodeValue {
  return { __typename: 'PullRequest', repo, pull };
}

function refNode(name: string): NodeValue {
  return { __typename: 'Ref', name };
}

function pageInfoNode(hasNextPage: boolean, startCursor: string | null, endCursor: string | null): NodeValue {
  return { __typename: 'PageInfo', hasNextPage, hasPreviousPage: false, startCursor, endCursor };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(after: unknown): number | null {
  if (typeof after !== 'string' || after === '') return null;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(-?\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

type IssueFilter = 'open' | 'closed' | null;

function parseStates(states: unknown): IssueFilter {
  if (!Array.isArray(states)) return null;
  const wanted = new Set<string>();
  for (const state of states) if (typeof state === 'string') wanted.add(state);
  if (wanted.has('OPEN') && wanted.has('CLOSED')) return null;
  if (wanted.has('OPEN')) return 'open';
  if (wanted.has('CLOSED')) return 'closed';
  return null;
}

interface OrderSpec {
  field: string;
  direction: 'ASC' | 'DESC';
}

function parseOrderBy(orderBy: unknown): OrderSpec {
  if (!isRecord(orderBy)) return { field: 'CREATED_AT', direction: 'DESC' };
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  return { field, direction };
}

function sortIssues(issues: Issue[], order: OrderSpec): Issue[] {
  const sorted = [...issues];
  const dir = order.direction === 'ASC' ? 1 : -1;
  sorted.sort((a, b) => {
    let cmp = 0;
    if (order.field === 'COMMENTS') cmp = a.comments.length - b.comments.length;
    else if (order.field === 'UPDATED_AT') cmp = a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0;
    else cmp = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
    // Ties break by number in the same direction (CREATED_AT DESC -> number DESC).
    if (cmp === 0) cmp = a.number - b.number;
    return cmp * dir;
  });
  return sorted;
}

function sortPulls(pulls: Pull[]): Pull[] {
  return [...pulls].sort((a, b) => b.number - a.number);
}

/** Slice a sorted list by `first`/`after`, building the connection node. */
function paginate<T>(items: T[], numberOf: (item: T) => number, first: unknown, after: unknown, typename: string): NodeValue {
  let start = 0;
  const cursorNumber = decodeCursor(after);
  if (cursorNumber !== null) {
    const index = items.findIndex((item) => numberOf(item) === cursorNumber);
    if (index >= 0) start = index + 1;
  }
  const limit = typeof first === 'number' && Number.isInteger(first) && first >= 0 ? first : items.length - start;
  const page = items.slice(start, start + limit);
  const hasNextPage = start + page.length < items.length;
  const endCursor = page.length > 0 ? encodeCursor(numberOf(page[page.length - 1]!)) : null;
  const startCursor = page.length > 0 ? encodeCursor(numberOf(page[0]!)) : null;
  return {
    __typename: typename,
    nodes: page,
    pageInfo: pageInfoNode(hasNextPage, startCursor, endCursor),
    totalCount: items.length,
  };
}

function executeSelectionSet(selections: SelectionNode[], source: NodeValue, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name ?? '');
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== source.__typename) continue;
      Object.assign(out, executeSelectionSet(fragment.selections, source, ctx));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== source.__typename) continue;
      Object.assign(out, executeSelectionSet(selection.selections ?? [], source, ctx));
      continue;
    }
    const fieldName = selection.name!;
    const key = selection.alias ?? fieldName;
    const value = resolveField(source, fieldName, selection, ctx);
    out[key] = applySubSelections(value, selection.selections, ctx);
  }
  return out;
}

/** Apply a field's sub-selections to its resolved value (nodes, arrays, connections). */
function applySubSelections(value: unknown, selections: SelectionNode[] | undefined, ctx: ExecContext): unknown {
  if (selections === undefined || selections.length === 0) return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (isRecord(entry) && typeof entry.__typename === 'string') return executeSelectionSet(selections, entry as NodeValue, ctx);
      return entry;
    });
  }
  if (isRecord(value) && typeof value.__typename === 'string') {
    return executeSelectionSet(selections, value as NodeValue, ctx);
  }
  return value;
}

function unknownField(ctx: ExecContext, typeName: string, fieldName: string): null {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

function resolveField(source: NodeValue, fieldName: string, selection: SelectionNode, ctx: ExecContext): unknown {
  const store = ctx.store;
  const args = resolveArguments(selection.arguments, ctx.variables);
  const typeName = source.__typename;

  if (fieldName === '__typename') return typeName;

  switch (typeName) {
    case 'Query': {
      if (fieldName === 'viewer') return userNode(store, store.viewer.login);
      if (fieldName === 'repository') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const repo = store.getRepo(owner, name);
        return repo === undefined ? null : repoNode(store, repo);
      }
      if (fieldName === 'node') {
        const id = args.id;
        const repo = findRepoByGlobalId(store, id);
        if (repo !== undefined) return repoNode(store, repo);
        const issue = findIssueByGlobalId(store, id);
        if (issue !== undefined) return issueNode(store, issue.repo, issue.issue);
        const pull = findPullByGlobalId(store, id);
        if (pull !== undefined) return pullNode(store, pull.repo, pull.pull);
        return null;
      }
      if (fieldName === '__type') {
        const name = typeof args.name === 'string' ? args.name : '';
        const info = SCHEMA_TYPES[name];
        if (info === undefined) return null;
        return {
          __typename: '__Type',
          name,
          kind: info.kind,
          description: null,
          fields: info.fields === undefined ? null : info.fields.map((field) => ({ __typename: '__Field', name: field, description: null })),
          enumValues: info.enumValues === undefined ? null : info.enumValues.map((value) => ({ __typename: '__EnumValue', name: value, description: null })),
        };
      }
      if (fieldName === '__schema') {
        return {
          __typename: '__Schema',
          description: null,
          types: Object.entries(SCHEMA_TYPES).map(([name, info]) => ({ __typename: '__Type', name, kind: info.kind })),
          queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' },
          mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' },
          subscriptionType: null,
          directives: [],
        };
      }
      return unknownField(ctx, typeName, fieldName);
    }

    case 'Mutation': {
      if (fieldName === 'createIssue') return mutateCreateIssue(args, ctx);
      if (fieldName === 'closeIssue') return mutateCloseIssue(args, ctx);
      if (fieldName === 'createPullRequest') return mutateCreatePullRequest(args, ctx);
      if (fieldName === 'mergePullRequest') return mutateMergePullRequest(args, ctx);
      if (fieldName === 'addComment') return mutateAddComment(args, ctx);
      return unknownField(ctx, typeName, fieldName);
    }

    case 'Repository': {
      const repo = source.repo as Repo;
      switch (fieldName) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.full_name;
        case 'owner': return userNode(store, repo.owner);
        case 'defaultBranchRef': {
          return repo.refs.has(`refs/heads/${repo.default_branch}`) ? refNode(repo.default_branch) : null;
        }
        case 'viewerPermission': return VIEWER_PERMISSION;
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'private': return repo.private;
        case 'url': return `https://github.com/${repo.full_name}`;
        case 'createdAt': return repo.created_at;
        case 'updatedAt': return repo.updated_at;
        case 'issue': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const issue = repo.issues.find((entry) => entry.number === number);
          return issue === undefined ? null : issueNode(store, repo, issue);
        }
        case 'issues': {
          const filter = parseStates(args.states);
          const order = parseOrderBy(args.orderBy);
          const filtered = filter === null ? repo.issues : repo.issues.filter((issue) => issue.state === filter);
          const nodes = sortIssues(filtered, order).map((issue) => issueNode(store, repo, issue));
          return paginate(nodes, (node) => (node.issue as Issue).number, args.first, args.after, 'IssueConnection');
        }
        case 'pullRequests': {
          const filter = parseStates(args.states);
          let pulls = sortPulls(repo.pulls);
          if (filter !== null) {
            pulls = pulls.filter((pull) => {
              if (filter === 'open') return pull.state === 'open';
              return pull.state === 'closed';
            });
          }
          const nodes = pulls.map((pull) => pullNode(store, repo, pull));
          return paginate(nodes, (node) => (node.pull as Pull).number, args.first, args.after, 'PullRequestConnection');
        }
        case 'pullRequest': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const pull = repo.pulls.find((entry) => entry.number === number);
          return pull === undefined ? null : pullNode(store, repo, pull);
        }
        default: return unknownField(ctx, typeName, fieldName);
      }
    }

    case 'Issue': {
      const issue = source.issue as Issue;
      const repo = source.repo as Repo;
      switch (fieldName) {
        case 'id': return issueGlobalId(issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return issue.body;
        case 'createdAt': return issue.created_at;
        case 'updatedAt': return issue.updated_at;
        case 'author': return userNode(store, issue.user);
        case 'user': return userNode(store, issue.user);
        case 'url': return `https://github.com/${repo.full_name}/issues/${issue.number}`;
        case 'labels': return { __typename: 'LabelConnection', nodes: (issue.labels ?? []).map((name) => ({ __typename: 'Label', name })) };
        case 'comments': return { __typename: 'IssueCommentConnection', nodes: issue.comments.map((comment) => ({ __typename: 'IssueComment', id: commentGlobalId(issue, comment.id), body: comment.body, createdAt: comment.created_at })) };
        default: return unknownField(ctx, typeName, fieldName);
      }
    }

    case 'PullRequest': {
      const pull = source.pull as Pull;
      const repo = source.repo as Repo;
      switch (fieldName) {
        case 'id': return pullGlobalId(pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return pull.merged;
        case 'mergeable': return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
        case 'headRefName': return pull.head.ref;
        case 'baseRefName': return pull.base.ref;
        case 'headRefOid': return pull.head.sha;
        case 'baseRefOid': return pull.base.sha;
        case 'body': return pull.body;
        case 'createdAt': return pull.created_at;
        case 'updatedAt': return pull.updated_at;
        case 'author': return userNode(store, store.viewer.login);
        case 'user': return userNode(store, store.viewer.login);
        case 'url': return `https://github.com/${repo.full_name}/pull/${pull.number}`;
        case 'files': {
          const nodes = (pull.files ?? []).map((file) => ({
            __typename: 'PullRequestChangedFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            status: file.status,
          }));
          const first = typeof args.first === 'number' && Number.isInteger(args.first) && args.first >= 0 ? args.first : nodes.length;
          const page = nodes.slice(0, first);
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes: page,
            pageInfo: pageInfoNode(nodes.length > page.length, null, null),
            totalCount: nodes.length,
          };
        }
        default: return unknownField(ctx, typeName, fieldName);
      }
    }

    case 'User': {
      switch (fieldName) {
        case 'login': return source.login as string;
        case 'id': return source.id as number;
        case 'name': return source.login as string;
        case 'url': return `https://github.com/${source.login as string}`;
        default: return unknownField(ctx, typeName, fieldName);
      }
    }

    case 'Ref': {
      if (fieldName === 'name') return source.name as string;
      if (fieldName === 'prefix') return 'refs/heads/';
      if (fieldName === 'target') return null;
      return unknownField(ctx, typeName, fieldName);
    }

    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection':
    case 'LabelConnection': {
      if (fieldName === 'nodes') return source.nodes as unknown[];
      if (fieldName === 'edges') {
        const nodes = source.nodes as unknown[];
        return nodes.map((entry) => ({ __typename: 'IssueEdge', node: entry, cursor: '' }));
      }
      if (fieldName === 'pageInfo') return source.pageInfo as NodeValue;
      if (fieldName === 'totalCount') return source.totalCount as number;
      return unknownField(ctx, typeName, fieldName);
    }

    case 'IssueEdge':
    case 'IssueCommentEdge': {
      if (fieldName === 'node') return source.node as unknown;
      if (fieldName === 'cursor') return (source.cursor as string | undefined) ?? '';
      return unknownField(ctx, typeName, fieldName);
    }

    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (fieldName === 'issue') return (source.issue as unknown) ?? null;
      return unknownField(ctx, typeName, fieldName);
    }

    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (fieldName === 'pullRequest') return (source.pullRequest as unknown) ?? null;
      return unknownField(ctx, typeName, fieldName);
    }

    case 'AddCommentPayload': {
      if (fieldName === 'commentEdge') return (source.commentEdge as unknown) ?? null;
      return unknownField(ctx, typeName, fieldName);
    }

    case 'PageInfo': {
      if (fieldName === 'hasNextPage') return source.hasNextPage as boolean;
      if (fieldName === 'hasPreviousPage') return source.hasPreviousPage as boolean;
      if (fieldName === 'startCursor') return (source.startCursor as string | null) ?? null;
      if (fieldName === 'endCursor') return (source.endCursor as string | null) ?? null;
      return unknownField(ctx, typeName, fieldName);
    }

    case 'PullRequestChangedFile': {
      if (['path', 'additions', 'deletions', 'changes', 'status'].includes(fieldName)) return source[fieldName] as unknown;
      return unknownField(ctx, typeName, fieldName);
    }

    case 'IssueComment': {
      if (fieldName === 'id') return source.id as string;
      if (fieldName === 'body') return source.body as string;
      if (fieldName === 'createdAt') return (source.createdAt as string | undefined) ?? null;
      if (fieldName === 'author') return userNode(store, store.viewer.login);
      if (fieldName === 'url') return null;
      return unknownField(ctx, typeName, fieldName);
    }

    case 'Label': {
      if (fieldName === 'name') return source.name as string;
      return unknownField(ctx, typeName, fieldName);
    }

    case '__Type': {
      if (fieldName === 'name') return (source.name as string | undefined) ?? null;
      if (fieldName === 'kind') return source.kind as string;
      if (fieldName === 'description') return null;
      if (fieldName === 'fields') return (source.fields as unknown[] | null) ?? null;
      if (fieldName === 'enumValues') return (source.enumValues as unknown[] | null) ?? null;
      if (fieldName === 'ofType') return null;
      if (fieldName === 'inputFields') return null;
      if (fieldName === 'interfaces') return [];
      if (fieldName === 'possibleTypes') return [];
      return unknownField(ctx, typeName, fieldName);
    }

    case '__Field': {
      if (fieldName === 'name') return source.name as string;
      if (fieldName === 'description') return null;
      if (fieldName === 'args') return [];
      if (fieldName === 'type') return { __typename: '__Type', name: 'String', kind: 'SCALAR' };
      if (fieldName === 'isDeprecated') return false;
      if (fieldName === 'deprecationReason') return null;
      return unknownField(ctx, typeName, fieldName);
    }

    case '__EnumValue': {
      if (fieldName === 'name') return source.name as string;
      if (fieldName === 'description') return null;
      if (fieldName === 'isDeprecated') return false;
      if (fieldName === 'deprecationReason') return null;
      return unknownField(ctx, typeName, fieldName);
    }

    case '__Schema': {
      if (fieldName === 'description') return null;
      if (fieldName === 'types') return source.types as unknown[];
      if (fieldName === 'queryType') return source.queryType as NodeValue;
      if (fieldName === 'mutationType') return source.mutationType as NodeValue;
      if (fieldName === 'subscriptionType') return null;
      if (fieldName === 'directives') return [];
      return unknownField(ctx, typeName, fieldName);
    }

    default:
      return unknownField(ctx, typeName, fieldName);
  }
}

// -------------------------------------------------------------------------------------------
// Mutations. Each returns a payload node; failures push a GraphQL error and
// return the payload with a null child (HTTP 200, errors array).
// -------------------------------------------------------------------------------------------

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  return isRecord(args.input) ? args.input : {};
}

function mutateCreateIssue(args: Record<string, unknown>, ctx: ExecContext): NodeValue {
  const input = inputOf(args);
  const repo = findRepoByGlobalId(ctx.store, input.repositoryId);
  if (repo === undefined) {
    ctx.errors.push({ message: `Could not resolve to a Repository with the id of "${String(input.repositoryId ?? '')}".` });
    return { __typename: 'CreateIssuePayload', issue: null };
  }
  try {
    const issue = createIssueInStore(ctx.store, repo, {
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
    });
    return { __typename: 'CreateIssuePayload', issue: issueNode(ctx.store, repo, issue) };
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return { __typename: 'CreateIssuePayload', issue: null };
  }
}

function mutateCloseIssue(args: Record<string, unknown>, ctx: ExecContext): NodeValue {
  const input = inputOf(args);
  const found = findIssueByGlobalId(ctx.store, input.issueId);
  if (found === undefined) {
    ctx.errors.push({ message: `Could not resolve to an Issue with the id of "${String(input.issueId ?? '')}".` });
    return { __typename: 'CloseIssuePayload', issue: null };
  }
  const issue = closeIssueInStore(ctx.store, found.repo, found.issue);
  return { __typename: 'CloseIssuePayload', issue: issueNode(ctx.store, found.repo, issue) };
}

function mutateCreatePullRequest(args: Record<string, unknown>, ctx: ExecContext): NodeValue {
  const input = inputOf(args);
  const repo = findRepoByGlobalId(ctx.store, input.repositoryId);
  if (repo === undefined) {
    ctx.errors.push({ message: `Could not resolve to a Repository with the id of "${String(input.repositoryId ?? '')}".` });
    return { __typename: 'CreatePullRequestPayload', pullRequest: null };
  }
  try {
    const pull = createPullRequestInStore(ctx.store, repo, {
      headRefName: typeof input.headRefName === 'string' ? input.headRefName : '',
      baseRefName: typeof input.baseRefName === 'string' ? input.baseRefName : '',
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
    });
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(ctx.store, repo, pull) };
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return { __typename: 'CreatePullRequestPayload', pullRequest: null };
  }
}

function mutateMergePullRequest(args: Record<string, unknown>, ctx: ExecContext): NodeValue {
  const input = inputOf(args);
  const found = findPullByGlobalId(ctx.store, input.pullRequestId);
  if (found === undefined) {
    ctx.errors.push({ message: `Could not resolve to a PullRequest with the id of "${String(input.pullRequestId ?? '')}".` });
    return { __typename: 'MergePullRequestPayload', pullRequest: null };
  }
  try {
    const pull = mergePullRequestInStore(ctx.store, found.repo, found.pull);
    return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(ctx.store, found.repo, pull) };
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return { __typename: 'MergePullRequestPayload', pullRequest: null };
  }
}

function mutateAddComment(args: Record<string, unknown>, ctx: ExecContext): NodeValue {
  const input = inputOf(args);
  const body = typeof input.body === 'string' ? input.body : '';
  const found = findIssueByGlobalId(ctx.store, input.subjectId);
  if (found === undefined) {
    ctx.errors.push({ message: `Could not resolve to an Issue with the id of "${String(input.subjectId ?? '')}".` });
    return { __typename: 'AddCommentPayload', commentEdge: null };
  }
  try {
    const comment = addCommentInStore(ctx.store, found.repo, found.issue, body);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: { __typename: 'IssueComment', id: commentGlobalId(found.issue, comment.id), body: comment.body, createdAt: comment.created_at },
      },
    };
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return { __typename: 'AddCommentPayload', commentEdge: null };
  }
}

// -------------------------------------------------------------------------------------------
// One operation -> one {data, errors?} envelope. Batching: a JSON array body is
// answered by an array of envelopes, in request order.
// -------------------------------------------------------------------------------------------

function executeOperation(doc: DocumentNode, operation: OperationNode, body: Record<string, unknown>, store: Store): Record<string, unknown> {
  const variables: Record<string, unknown> = {};
  const given = isRecord(body.variables) ? body.variables : {};
  for (const def of operation.variables) {
    if (given[def.name] !== undefined) variables[def.name] = given[def.name];
    else if (def.defaultValue !== undefined) variables[def.name] = resolveValue(def.defaultValue, {});
  }
  const ctx: ExecContext = { store, fragments: doc.fragments, variables, errors: [] };
  const root: NodeValue = operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelectionSet(operation.selections, root, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

function executeBody(body: unknown, store: Store): { status: number; payload: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') {
        return { data: null, errors: [{ message: 'Each batched operation must be an object with a query string.' }] };
      }
      return executeOne(entry, store);
    });
    return { status: 200, payload: results };
  }
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { status: 400, payload: { message: 'GraphQL body must be an object with a query string.' } };
  }
  return { status: 200, payload: executeOne(body, store) };
}

function executeOne(body: Record<string, unknown>, store: Store): Record<string, unknown> {
  let doc: DocumentNode;
  try {
    doc = new Parser(tokenize(body.query as string)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation: OperationNode | undefined;
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  if (operationName !== undefined) {
    operation = doc.operations.find((entry) => entry.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'The document holds no operation.' }] };
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name when there are multiple operations.' }] };
  }
  return executeOperation(doc, operation, body, store);
}

/**
 * POST /api/graphql. Returns true when this request is ours (path + POST);
 * otherwise false without touching the response, so the router can 404 it.
 * Without a matching bearer token the answer is exactly 401.
 */
export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let path = '/';
  try {
    path = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    path = '/';
  }
  if (req.method !== 'POST' || path !== '/api/graphql') return false;
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' }, requestId(store));
    return true;
  }
  let text: string;
  try {
    text = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'Could not read the request body' }, requestId(store));
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    sendJson(res, 400, { message: 'Request body is not valid JSON' }, requestId(store));
    return true;
  }
  const { status, payload } = executeBody(body, store);
  // X-GitHub-Request-Id: deterministic, from the store's request counter.
  const text2 = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text2),
    'x-github-request-id': requestId(store),
  });
  res.end(text2);
  return true;
}
