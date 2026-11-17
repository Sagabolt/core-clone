// src/git-protocol.ts — git smart HTTP, from scratch on node:http.
//
// Routes (all under /{owner}/{repo}.git):
//   GET  /info/refs?service=git-upload-pack|git-receive-pack
//   POST /git-upload-pack      (protocol v2 when `Git-Protocol: version=2`, else v0)
//   POST /git-receive-pack    (v0 only)
//
// upload-pack v2: advertisement (`version 2`, `ls-refs=unborn`, `fetch=shallow wait-for-done`,
// `server-option`, `object-format=sha1`), `command=ls-refs` (ref-prefix / peel / unborn /
// symrefs) and `command=fetch` (want / have / shallow / deepen / done). The fetch answer is
// sectioned — `acknowledgments` (only when the request has no `done`), `shallow-info`
// (always), `packfile` — with the pack inside sideband-64k band 1 and a flush at the
// end. Generated packs hold whole objects only.
//
// receive-pack v0: advertisement `# service=git-receive-pack` + capabilities
// `report-status side-band-64k delete-refs`, then per-ref fast-forward validation and a
// report-status answer (`unpack ok`, one `ok`/`ng` line per ref) inside sideband band 1.
// A refused ref never moves; a mixed push applies only its fast-forward half.
//
// Shallow: `deepen N` sends commits N generations from the wants (tip only for N=1); the
// boundary commits are reported as `shallow`, old boundaries that are now filled in as
// `unshallow`. Objects the client already holds (its `have`s, cut off at its shallow
// boundary) are never re-sent.
//
// Unknown repo -> 404 JSON on info/refs, and the server stays up. A malformed request body
// -> 400 JSON, never a crash. `handleGit` returns true when it owned the route.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo, Store } from './store.ts';
import { readRawBody, sendJson, sendRaw } from './util.ts';
import {
  GitPackError,
  ZERO_OID,
  applyDelta,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
  writePack,
} from './git-objects.ts';
import type { GitObject } from './git-objects.ts';

export const GIT_AGENT = 'forge/1.0';
/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte length. */
export const PKT_LINE_MAX = 65520;
/** Largest sideband payload per pkt-line: max line minus header minus the 1 band byte. */
export const SIDEBAND_CHUNK = PKT_LINE_MAX - 4 - 1;

/** An error in the git wire bytes (malformed pkt-line, bad command, ...). */
export class GitProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitProtocolError';
  }
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) {
    throw new GitProtocolError(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX - 4}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a mixed sequence; 'flush' / 'delim' are the control packets. */
export function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/** Read one pkt-line at `offset`; returns the packet and the offset just past it. */
export function readPktLine(buf: Buffer, offset: number): { pkt: Pkt; next: number } {
  if (offset + 4 > buf.length) throw new GitProtocolError('truncated pkt-line');
  const header = buf.subarray(offset, offset + 4).toString('ascii');
  if (!HEX4.test(header)) throw new GitProtocolError(`invalid pkt-line length ${JSON.stringify(header)}`);
  const length = Number.parseInt(header, 16);
  if (length === 0) return { pkt: { kind: 'flush' }, next: offset + 4 };
  if (length === 1) return { pkt: { kind: 'delim' }, next: offset + 4 };
  if (length === 2) return { pkt: { kind: 'response-end' }, next: offset + 4 };
  if (length === 3 || length > PKT_LINE_MAX) throw new GitProtocolError(`invalid pkt-line length ${length}`);
  if (offset + length > buf.length) throw new GitProtocolError('truncated pkt-line');
  return { pkt: { kind: 'data', payload: buf.subarray(offset + 4, offset + length) }, next: offset + length };
}

/**
 * Decode pkt-lines from `buf` starting at `offset` until the first flush. Returns the data
 * lines (as text) and the offset just past the flush — everything after it is raw pack bytes.
 */
export function readPktLinesUntilFlush(buf: Buffer, offset = 0): { lines: string[]; next: number } {
  const lines: string[] = [];
  let cursor = offset;
  for (;;) {
    const { pkt, next } = readPktLine(buf, cursor);
    cursor = next;
    if (pkt.kind === 'flush') return { lines, next: cursor };
    if (pkt.kind === 'data') lines.push(pkt.payload.toString('utf8'));
    // delim / response-end packets are skipped here; callers that need them use readPktLine.
  }
}

/**
 * Decode a request body that is pkt-lines only (ls-refs / fetch): all packets in order.
 * Stops at the final flush; any trailing bytes after it are returned as `trailing`.
 */
export function decodeRequestPackets(buf: Buffer): { packets: Pkt[]; trailing: Buffer } {
  const packets: Pkt[] = [];
  let cursor = 0;
  while (cursor < buf.length) {
    const { pkt, next } = readPktLine(buf, cursor);
    packets.push(pkt);
    cursor = next;
    if (pkt.kind === 'flush') break;
  }
  return { packets, trailing: buf.subarray(cursor) };
}

/** Split `data` into sideband-64k band-1 packets (one 0x01 byte + up to SIDEBAND_CHUNK bytes). */
export function sidebandWrap(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  if (data.length === 0) {
    parts.push(encodePktLine(Buffer.from([1])));
    return Buffer.concat(parts);
  }
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + SIDEBAND_CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// object helpers (shared with REST: ancestry, peeling, reachability)
// ---------------------------------------------------------------------------------------------

/** Peel `oid` through annotated tags to its commit, or null when it is not a commit/tag. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
}

/** Peel `oid` through tags to the first non-tag object, or null when it cannot be peeled. */
export function peelToNonTag(repo: Repo, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return current;
  }
}

/** True when `ancestor` is `descendant` itself or reachable from it through parent links. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  const ancestorCommit = peelToCommit(repo, ancestor);
  const descendantCommit = peelToCommit(repo, descendant);
  if (!ancestorCommit || !descendantCommit) return false;
  if (ancestorCommit === descendantCommit) return true;
  const seen = new Set<string>();
  const queue = [descendantCommit];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestorCommit) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The commit timestamp (committer line) of `oid`, or null when it is not a commit. */
export function commitTimestamp(repo: Repo, oid: string): number | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const committer = parseCommit(object.data).committer;
  const match = / (\d+) [+-]\d{4}$/.exec(committer);
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------------------------
// fetch planning: which objects to send, and the shallow boundary
// ---------------------------------------------------------------------------------------------

export interface FetchPlanOptions {
  readonly wants: readonly string[];
  readonly haves?: readonly string[];
  /** The client's current shallow boundary (its knowledge stops at these commits' parents). */
  readonly shallow?: readonly string[];
  /** Depth limit (1 = tip only). Undefined = full history. */
  readonly depth?: number;
  readonly deepenSince?: number;
  readonly deepenNot?: readonly string[];
}

export interface FetchPlan {
  /** Objects to send, in deterministic (oid-sorted) order. */
  readonly objects: GitObject[];
  /** New shallow boundary commits (the depth cutoff). */
  readonly shallow: string[];
  /** Old boundaries that are now filled in. */
  readonly unshallow: string[];
  /** Haves the server holds (the ACKs). */
  readonly acks: string[];
}

/**
 * Plan a fetch: reachable objects from the wants, minus what the client already holds,
 * cut off at the depth limit. Depth applies to commits only; a cut-off commit's tree and
 * blobs are always sent whole. A depth-1 fetch of a 200-commit repo therefore touches
 * only the tip commit, its tree and its blobs.
 */
export function planFetch(repo: Repo, options: FetchPlanOptions): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const clientShallow = new Set(options.shallow ?? []);
  const knownHaves = (options.haves ?? []).filter((oid) => repo.objects.has(oid));
  const acks = [...knownHaves];

  // What the client already holds: reachable from its haves, but never past its shallow
  // boundary (the parents of a shallow commit are NOT held).
  const excluded = new Set<string>();
  {
    const queue = [...knownHaves, ...(options.deepenNot ?? []).filter((oid) => repo.objects.has(oid))];
    while (queue.length) {
      const oid = queue.pop()!;
      if (excluded.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      excluded.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!clientShallow.has(oid)) for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
  }

  // Commits to include, by distance from a want. A tag want contributes its tag object plus
  // its target commit at distance 0.
  const commitDist = new Map<string, number>();
  const boundary = new Set<string>();
  const tagObjects = new Set<string>();
  const directObjects = new Set<string>();
  const depth = options.depth;
  const deepenSince = depth === undefined ? options.deepenSince : undefined;
  {
    const queue: Array<[string, number]> = [];
    const enqueue = (oid: string, dist: number): void => {
      if (commitDist.has(oid)) return;
      commitDist.set(oid, dist);
      queue.push([oid, dist]);
    };
    for (const want of options.wants) {
      const object = lookup(want);
      if (!object) continue;
      if (object.type === 'tag') {
        tagObjects.add(want);
        const target = parseTag(object.data).object;
        const targetObject = lookup(target);
        if (!targetObject) continue;
        if (targetObject.type === 'commit') enqueue(target, 0);
        else directObjects.add(target);
      } else if (object.type === 'commit') {
        enqueue(want, 0);
      } else {
        directObjects.add(want);
      }
    }
    for (let index = 0; index < queue.length; index += 1) {
      const [oid, dist] = queue[index];
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      let cutOff = false;
      if (depth !== undefined) {
        cutOff = dist >= depth - 1;
      } else if (deepenSince !== undefined) {
        // deepen-since: a commit is a boundary when any parent is older than the cutoff.
        for (const parent of commit.parents) {
          const parentTs = commitTimestamp(repo, parent);
          if (parentTs !== null && parentTs < deepenSince) cutOff = true;
        }
      }
      if (cutOff) {
        boundary.add(oid);
        continue;
      }
      for (const parent of commit.parents) {
        if (deepenSince !== undefined) {
          const parentTs = commitTimestamp(repo, parent);
          if (parentTs !== null && parentTs < deepenSince) continue;
        }
        enqueue(parent, dist + 1);
      }
    }
  }

  // The full object closure of the included commits: trees and blobs, whole.
  const included = new Set<string>([...tagObjects, ...directObjects]);
  for (const oid of commitDist.keys()) included.add(oid);
  {
    const queue: string[] = [];
    for (const oid of commitDist.keys()) {
      const object = lookup(oid);
      if (object && object.type === 'commit') queue.push(parseCommit(object.data).tree);
    }
    for (const oid of directObjects) {
      const object = lookup(oid);
      if (object && object.type === 'tree') queue.push(oid);
    }
    while (queue.length) {
      const oid = queue.pop()!;
      if (included.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      included.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      }
    }
  }

  const objects: GitObject[] = [];
  for (const oid of [...included].sort()) {
    if (excluded.has(oid)) continue;
    const object = lookup(oid);
    if (object) objects.push({ type: object.type, data: object.data });
  }

  // Old boundaries that are now filled in: reachable within the limit, no longer a boundary.
  const unshallow: string[] = [];
  for (const old of clientShallow) {
    if (boundary.has(old)) continue;
    if (commitDist.has(old)) unshallow.push(old);
    else if (depth === undefined && deepenSince === undefined) {
      // A full fetch fills in every old boundary reachable from the wants.
      try {
        if (collectReachable(options.wants, lookup, { allowMissing: true }).has(old)) unshallow.push(old);
      } catch {
        // collectReachable only throws on missing objects; allowMissing guards it.
      }
    }
  }

  return {
    objects,
    shallow: [...boundary].sort(),
    unshallow: unshallow.sort(),
    acks,
  };
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The v0 capability list for `service` (the symref names the repo's default branch). */
function v0Capabilities(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): string {
  if (service === 'git-receive-pack') return `report-status side-band-64k delete-refs agent=${GIT_AGENT}`;
  return (
    `symref=HEAD:refs/heads/${repo.default_branch} side-band-64k shallow multi_ack_detailed ` +
    `thin-pack ofs-delta object-format=sha1 agent=${GIT_AGENT}`
  );
}

/** The v0 ref advertisement body (after the `# service=…` preamble + flush). */
function v0RefLines(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): string[] {
  const caps = v0Capabilities(repo, service);
  const names = sortedRefNames(repo);
  if (names.length === 0) return [`${ZERO_OID} capabilities^{}\0${caps}\n`];
  const lines: string[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.default_branch}`);
  lines.push(`${headOid ?? ZERO_OID} HEAD\0${caps}\n`);
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    lines.push(`${oid} ${name}\n`);
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const peeled = peelToNonTag(repo, oid);
      if (peeled) lines.push(`${peeled} ${name}^{}\n`);
    }
  }
  return lines;
}

/** GET info/refs for a v0 service. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  return encodePktLines([
    `# service=${service}\n`,
    'flush',
    ...v0RefLines(repo, service),
    'flush',
  ]);
}

/** GET info/refs for upload-pack v2. */
function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'server-option\n',
    'object-format=sha1\n',
    `agent=${GIT_AGENT}\n`,
    'flush',
  ]);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2: ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: Pkt[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !pastDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    // Anything else (e.g. ref-prefix-pattern) is ignored: it only narrows further.
  }
  return args;
}

function lsRefsV2(repo: Repo, packets: Pkt[]): Buffer {
  const args = parseLsRefsArgs(packets);
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.default_branch}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid) {
      lines.push(`${headOid} HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}\n`);
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') {
        const peeled = peelToNonTag(repo, oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  return encodePktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------------------------------------
// upload-pack: fetch (v2 sections, v0 plain lines)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
  /** The client sent `done`: negotiation is over, so no `acknowledgments` section. */
  done: boolean;
}

function parseFetchArgs(packets: Pkt[], v2: boolean): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepenNot: [], done: false };
  let pastDelim = v2 ? false : true;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind === 'flush') {
      // v0 splits want/deepen from have/done with a flush; v2 ends with one flush.
      continue;
    }
    if (packet.kind !== 'data') continue;
    if (v2 && !pastDelim) continue; // command= / agent= / object-format= lines
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      if (isObjectId(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).split(' ')[0];
      if (isObjectId(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).split(' ')[0];
      if (isObjectId(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isSafeInteger(n) && n > 0) args.depth = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number.parseInt(line.slice('deepen-since '.length), 10);
      if (Number.isSafeInteger(n) && n > 0) args.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) {
      const oid = line.slice('deepen-not '.length).split(' ')[0];
      if (isObjectId(oid)) args.deepenNot.push(oid);
    } else if (line === 'done') {
      args.done = true;
    }
    // thin-pack / no-progress / ofs-delta / filter / include-tag / command= are accepted and ignored.
  }
  return args;
}

/** The fetch answer for protocol v2: acknowledgments, shallow-info, packfile sections.
 * Section rules, as a real git server answers them (verified against git 2.43):
 *   - when the request carries `done` there is NO `acknowledgments` section;
 *   - otherwise the `acknowledgments` section comes first (ACKs + `ready`, or NAK);
 *   - the `shallow-info` section is always present (it may be empty);
 *   - the pack follows in the `packfile` section, sideband band 1, then a flush. */
function fetchResponseV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, {
    wants: args.wants,
    haves: args.haves,
    shallow: args.shallow,
    depth: args.depth,
    deepenSince: args.deepenSince,
    deepenNot: args.deepenNot,
  });
  const parts: Buffer[] = [];
  if (!args.done) {
    parts.push(encodePktLine('acknowledgments\n'));
    if (plan.acks.length) {
      for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
      parts.push(encodePktLine('ready\n'));
    } else {
      parts.push(encodePktLine('NAK\n'));
    }
    parts.push(pktDelim());
  }
  parts.push(encodePktLine('shallow-info\n'));
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(pktDelim());
  parts.push(encodePktLine('packfile\n'));
  const pack = writePack(plan.objects);
  parts.push(sidebandWrap(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The fetch answer for protocol v0: NAK/ACK + shallow lines, then the sideband pack. */
function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, {
    wants: args.wants,
    haves: args.haves,
    shallow: args.shallow,
    depth: args.depth,
    deepenSince: args.deepenSince,
    deepenNot: args.deepenNot,
  });
  const parts: Buffer[] = [];
  if (plan.acks.length) {
    for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  const pack = writePack(plan.objects);
  parts.push(sidebandWrap(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack v0: push
// ---------------------------------------------------------------------------------------------

export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function parsePushCommands(lines: string[]): PushCommand[] {
  const commands: PushCommand[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\n$/, '');
    // The first command may carry capabilities after a NUL: "<old> <new> <ref>\0<caps>".
    const nul = line.indexOf('\0');
    const command = nul >= 0 ? line.slice(0, nul) : line;
    const parts = command.split(' ');
    if (parts.length !== 3 || !isObjectId(parts[0]) || !isObjectId(parts[1]) || !parts[2].startsWith('refs/')) {
      throw new GitProtocolError(`bad receive-pack command ${JSON.stringify(command.slice(0, 80))}`);
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) throw new GitProtocolError('receive-pack sent no commands');
  return commands;
}

/** Validate one ref update; returns null when it may be applied, else the `ng` reason. */
function validatePushCommand(repo: Repo, command: PushCommand): string | null {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return 'ref does not exist';
    if (current !== command.oldOid) return 'old value does not match';
    return null;
  }
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return 'ref already exists';
  } else {
    // Update.
    if (current === undefined) return 'ref does not exist';
    if (current !== command.oldOid) return 'old value does not match';
    if (command.oldOid === command.newOid) return null; // no-op update
  }
  const object = repo.objects.get(command.newOid);
  if (!object) return 'missing object';
  if (object.type !== 'commit' && object.type !== 'tag') return 'not a commit';
  if (command.oldOid !== ZERO_OID && !isAncestor(repo, command.oldOid, command.newOid)) {
    return 'non-fast-forward';
  }
  return null;
}

function pushReportLines(unpack: string, results: ReadonlyArray<{ ref: string; ok: boolean; reason: string }>): Buffer {
  const lines = [`unpack ${unpack}\n`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  // The report stream inside band 1 is terminated by its own flush packet: without it
  // the client's report reader sees end-of-stream instead of end-of-report and reports
  // "the remote end hung up unexpectedly" (verified against git 2.43).
  return sidebandWrap(Buffer.concat([encodePktLines(lines), pktFlush()]));
}

function receivePack(repo: Repo, store: Store, body: Buffer): Buffer {
  const { lines, next } = readPktLinesUntilFlush(body, 0);
  const commands = parsePushCommands(lines);
  const packBytes = body.subarray(next);

  // Unpack first: objects land in the store even when a ref update is refused, as git does.
  if (packBytes.length > 0) {
    let parsed;
    try {
      parsed = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
    } catch (err) {
      const detail = err instanceof Error ? err.message.replace(/\n/g, ' ') : 'unpack failed';
      const results = commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' }));
      return Buffer.concat([pushReportLines(detail, results), pktFlush()]);
    }
    for (const [oid, object] of parsed.objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: object.data });
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let applied = false;
  for (const command of commands) {
    const reason = validatePushCommand(repo, command);
    if (reason !== null) {
      results.push({ ref: command.ref, ok: false, reason });
      continue;
    }
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
    applied = true;
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  if (applied) {
    const now = store.nowIso();
    repo.pushed_at = now;
    repo.updated_at = now;
  }
  return Buffer.concat([pushReportLines('ok', results), pktFlush()]);
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/**
 * Handle a git smart-HTTP request. Returns true when the route was a git route (even when
 * the repo is unknown or the body malformed — those are answered, not passed on); false
 * when the path is not a git route at all, so the caller can try another router.
 * Never throws: a malformed request is answered 400 and the server stays up.
 */
export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let match: RegExpExecArray | null = null;
  try {
    const path = new URL(req.url ?? '/', 'http://entry').pathname;
    match = GIT_ROUTE.exec(path);
    if (!match) return false;
    // decodeURIComponent can throw on a malformed escape; treat that as "not a git route".
    decodeURIComponent(match[1]);
    decodeURIComponent(match[2]);
  } catch {
    return false;
  }
  const owner = decodeURIComponent(match[1]);
  const repoName = decodeURIComponent(match[2]);
  const endpoint = match[3];
  const method = req.method ?? 'GET';

  try {
    const repo = store.getRepo(owner, repoName);

    if (endpoint === 'info/refs') {
      if (method !== 'GET') {
        sendJson(res, 405, { message: 'Method Not Allowed' }, {}, store);
        return true;
      }
      const service = new URL(req.url ?? '/', 'http://entry').searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'Missing or unknown service' }, {}, store);
        return true;
      }
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' }, {}, store);
        return true;
      }
      const wantsV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
      const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
      sendRaw(res, 200, body, `application/x-${service}-advertisement`, {}, store);
      return true;
    }

    if (endpoint === 'git-upload-pack') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' }, {}, store);
        return true;
      }
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' }, {}, store);
        return true;
      }
      const body = await readRawBody(req);
      const { packets } = decodeRequestPackets(body);
      const firstLine =
        packets.find((packet) => packet.kind === 'data')?.kind === 'data'
          ? (packets.find((packet) => packet.kind === 'data') as { payload: Buffer }).payload.toString('utf8')
          : '';
      const isV2 = req.headers['git-protocol'] === 'version=2' || firstLine.startsWith('command=');
      const args = parseFetchArgs(packets, isV2);
      if (isV2 && firstLine.startsWith('command=ls-refs')) {
        const out = lsRefsV2(repo, packets);
        sendRaw(res, 200, out, 'application/x-git-upload-pack-result', {}, store);
        return true;
      }
      if (isV2 && !firstLine.startsWith('command=fetch')) {
        throw new GitProtocolError(`unknown upload-pack command ${JSON.stringify(firstLine.slice(0, 40))}`);
      }
      const out = isV2 ? fetchResponseV2(repo, args) : fetchResponseV0(repo, args);
      sendRaw(res, 200, out, 'application/x-git-upload-pack-result', {}, store);
      return true;
    }

    // git-receive-pack
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' }, {}, store);
      return true;
    }
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' }, {}, store);
      return true;
    }
    const body = await readRawBody(req);
    const out = receivePack(repo, store, body);
    sendRaw(res, 200, out, 'application/x-git-receive-pack-result', {}, store);
    return true;
  } catch (err) {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        // The socket is already gone; nothing left to do.
      }
      return true;
    }
    if (err instanceof GitProtocolError || err instanceof GitPackError) {
      sendJson(res, 400, { message: err.message }, {}, store);
      return true;
    }
    sendJson(res, 500, { message: 'Internal Server Error' }, {}, store);
    return true;
  }
}

// Re-exported for callers that build packs or verify hashes without importing git-objects.
export { buildTree, collectReachable, hashObject, readPack, verifyPackChecksum, writePack, applyDelta };
