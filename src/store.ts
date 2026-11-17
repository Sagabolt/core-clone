// src/store.ts — the one in-memory store shared by git, REST, GraphQL and MCP.
//
// Determinism: no Date.now() / new Date() / Math.random() anywhere in state. Every timestamp
// comes from nowIso(), which is SCENARIO_EPOCH_SEC (2025-01-01T00:00:00Z) plus a counter of
// seconds, so two runs that serve the same requests produce the same timestamps.
//
// Numbering (GitHub-compatible): issues and pull requests share ONE counter per repo
// (`seq`, starting at 1). `issueSeq` / `pullSeq` are kept in sync with `seq` so the shape
// from DESIGN.md §2 is preserved while the numbering stays shared. The global id of an
// issue or pull is `100000 + repo.id * 1000 + number`, unique and stable across surfaces.
// Repository ids start at 5000 (`repoSeq`).

import { SCENARIO_EPOCH_SEC, VIEWER } from './viewer.ts';

export interface GitObject {
  /** Raw object bytes, without the "<type> <len>\0" header. */
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

/** ref -> commit oid (hex, 40 chars). */
export interface RefMap {
  [ref: string]: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  /** oid -> object. */
  objects: Map<string, GitObject>;
  /** 'refs/heads/main' -> oid. */
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string; description: string }>;
  issues: Issue[];
  pulls: Pull[];
  /** Next shared issue/pull number (starts at 1). */
  seq: number;
  /** Kept in sync with `seq` (same shared counter, exposed under both names). */
  issueSeq: number;
  /** Kept in sync with `seq` (same shared counter, exposed under both names). */
  pullSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; body: string; created_at: string }[];
  created_at: string;
  updated_at: string;
  user: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  mergeable: boolean;
  merge_commit_sha: string | null;
  merged_at: string | null;
  files: { filename: string; status: string; additions: number; deletions: number; changes: number }[];
  created_at: string;
  updated_at: string;
}

/** First repository id. Scenario repos use 5000.. as well; entry repos start here. */
export const FIRST_REPO_ID = 5000;
/** Base of the global issue/pull id space: 100000 + repo.id * 1000 + number. */
export const ISSUE_ID_BASE = 100000;

export class Store {
  /** The viewer (token owner): adaiversen / 1000. */
  viewer: { login: string; id: number; email: string };
  /** Key `${owner}/${name}`. */
  repos: Map<string, Repo>;
  /** Next repository id (starts at 5000). */
  repoSeq: number;
  /** Request/timestamp counter: drives X-GitHub-Request-Id and nowIso(). */
  reqCounter: number;

  constructor() {
    this.viewer = { login: VIEWER.login, id: VIEWER.id, email: VIEWER.email };
    this.repos = new Map();
    this.repoSeq = FIRST_REPO_ID;
    this.reqCounter = 0;
  }

  /**
   * Deterministic timestamp: SCENARIO_EPOCH_SEC + reqCounter seconds, as ISO.
   * Each call consumes the next second, so timestamps are monotonic within a run
   * and identical across runs that serve the same requests in the same order.
   */
  nowIso(): string {
    this.reqCounter += 1;
    return new Date((SCENARIO_EPOCH_SEC + this.reqCounter) * 1000).toISOString();
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(
    name: string,
    opts: { description?: string; private?: boolean; default_branch?: string } = {},
  ): Repo {
    const owner = this.viewer.login;
    const id = this.repoSeq;
    this.repoSeq += 1;
    const created = this.nowIso();
    const repo: Repo = {
      id,
      owner,
      name,
      full_name: `${owner}/${name}`,
      description: opts.description ?? '',
      private: opts.private ?? false,
      default_branch: opts.default_branch ?? 'main',
      created_at: created,
      updated_at: created,
      pushed_at: created,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      seq: 1,
      issueSeq: 1,
      pullSeq: 1,
    };
    this.repos.set(repo.full_name, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }
}

export function createStore(): Store {
  return new Store();
}

/** The global id for an issue/pull `number` in `repo`. */
export function issueGlobalId(repo: Repo, number: number): number {
  return ISSUE_ID_BASE + repo.id * 1000 + number;
}

/** Take the next shared issue/pull number from `repo` and keep all counters in sync. */
export function nextNumber(repo: Repo): number {
  const number = repo.seq;
  repo.seq += 1;
  repo.issueSeq = repo.seq;
  repo.pullSeq = repo.seq;
  return number;
}

/** Shared issue creation (REST, GraphQL and MCP all call this one function). */
export function createIssue(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; labels?: string[] },
): Issue {
  const number = nextNumber(repo);
  const now = store.nowIso();
  const issue: Issue = {
    id: issueGlobalId(repo, number),
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...(input.labels ?? [])],
    comments: [],
    created_at: now,
    updated_at: now,
    user: store.viewer.login,
  };
  repo.issues.push(issue);
  return issue;
}

/** Shared pull-request creation (REST, GraphQL and MCP all call this one function). */
export function createPull(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; head: { ref: string; sha: string }; base: { ref: string; sha: string } },
): Pull {
  const number = nextNumber(repo);
  const now = store.nowIso();
  const pull: Pull = {
    id: issueGlobalId(repo, number),
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    head: { ref: input.head.ref, sha: input.head.sha },
    base: { ref: input.base.ref, sha: input.base.sha },
    merged: false,
    mergeable: true,
    merge_commit_sha: null,
    merged_at: null,
    files: [],
    created_at: now,
    updated_at: now,
  };
  repo.pulls.push(pull);
  return pull;
}
