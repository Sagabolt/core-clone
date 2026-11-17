# core-clone — a GitHub-compatible git forge, built from scratch

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Sagabolt/core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Sagabolt/core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge written from scratch in TypeScript on Node 22,
using only the standard library — no git binary, no dependencies, no network
calls outside the trial env. One in-memory store is shared by all four
surfaces, so a repo, issue or pull request created through one of them reads
back identically through the others.

## The four surfaces

- **Git smart HTTP** (`/{owner}/{repo}.git`) — protocol v2 upload-pack
  (`ls-refs`, `fetch`, shallow `deepen`), v0 receive-pack with
  `report-status` / `side-band-64k` / `delete-refs`, per-ref fast-forward
  validation, and packfiles built from whole objects (no deltas).
- **REST v3** (`/api/v3`) — repos, branches, commits, contents, labels,
  issues (+ comments), pull requests (+ files, squash merge), pagination
  with `Link: rel="next"`, and `X-GitHub-Request-Id` on every reply.
- **GraphQL v4** (`POST /api/graphql`) — `repository`, `viewer`, issue /
  pull-request queries and mutations, introspection for `Issue`,
  `PullRequest` and `Repository`, and batched operations in one body.
- **MCP** (`POST /mcp`) — JSON-RPC 2.0 Streamable HTTP, revision
  2026-07-28 plus the legacy `initialize` handshake, with `server/discover`
  and six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`).

Auth is `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` on every surface except
`GET /healthz`. The viewer (token owner) is `adaiversen`. All timestamps are
deterministic (scenario epoch + a request counter), never the wall clock.

## Running it

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the env at
`$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until the
trial ends and exits 0. For local smoke tests, set `MAKEFUN_SHOP_TOKEN`
to any token and point a client at the port it prints:

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts
# in another shell:
curl http://127.0.0.1:<port>/healthz
curl http://127.0.0.1:<port>/api/v3/user/repos -H "Authorization: Bearer test-token"
```

## Layout

```
main.ts            # lifecycle: bind ephemeral port, register, poll /done, exit 0
app.ts             # createApp(): one shared Store, routing, git auth, request ids
src/store.ts       # the shared in-memory store (repos, refs, objects, issues, pulls)
src/viewer.ts      # scenario PRNG + viewer identity (adaiversen)
src/git-objects.ts # SHA-1 objects, pack encode/decode (whole objects, no deltas)
src/git-protocol.ts# pkt-line, upload-pack v2, receive-pack v0, fast-forward checks
src/rest.ts        # REST v3 handlers + shared issue/pull/merge helpers
src/graphql.ts     # GraphQL executor + introspection
src/mcp.ts         # MCP JSON-RPC server + tools
src/util.ts        # JSON body parsing, JSON/raw replies, request ids
```

## License

MIT — see [LICENSE](LICENSE).
