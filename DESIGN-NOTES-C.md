# DESIGN-NOTES-C — GraphQL v4 + MCP (modul C)

Penulis modul: subagent GraphQL/MCP, 2026-11-17. File milik modul ini:
`src/graphql.ts`, `src/mcp.ts`. Uji lokal: `work/dev/server.ts`,
`work/dev/test.mjs`, `work/dev/extra.mjs` (semua di `work/dev/`, untracked,
bukan bagian entry).

## Yang sudah diverifikasi lokal (45/45 lolos)

Perintah: `MAKEFUN_SHOP_TOKEN=test-token-123 node dev/test.mjs`
(37 cek) + `node dev/extra.mjs` (8 cek). Dokumen GraphQL di `test.mjs`
diekstrak persis dari `GRAPHQL_DOCUMENTS` di kit (`checks-graphql.ts`) lewat
regex — bukan ketikan ulang. Stub memakai **Store asli** (`createStore()` dari
`src/store.ts`) dan fungsi bersama `src/rest.ts`.

- GraphQL (20 cek kit): viewer-login, repository-fields
  (`R_5000`, `databaseId` 5000, `defaultBranchRef.main`, `ADMIN`, `true`),
  introspeksi Issue / PullRequest / Repository / SearchType (mencakup ISSUE),
  issues-open-order (nomor menurun, closed terbuang), issue-by-number,
  create-issue, close-issue, pull-requests-list, pull-request-files
  (path `a.txt` terbaca), create-pull-request, merge-pull-request (SQUASH,
  REST membaca `merged:true`, `state:closed`, `merge_commit_sha` terisi dari
  commit squash `rest.ts`), add-comment, invalid-field (HTTP 200 + errors
  menyebut `noSuchFieldOnViewer`), unauthenticated (401), node-repository,
  unknown-repository (`data.repository:null`, tanpa errors), batched-operations
  (2 hasil berurutan), global-id-stability (id opak `R_`/`I_`, stabil),
  issues-pagination (5 + 2, `hasNextPage` true/false, cursor opak).
- MCP (15 cek kit): server-discover (`supportedVersions` berisi `2026-07-28`
  + 4 revisi lama), initialize legacy (`2025-11-25` di-echo, `serverInfo` +
  `capabilities.tools`), notifications/initialized (202, body kosong),
  tools-list (6 tool kanonik, deskripsi + `inputSchema` object),
  tools-list-idempotent (byte-identik), create-issue, list-issues,
  create-pull-request, merge-pull-request, unknown-tool (-32601, bukan 500),
  parse-error (HTTP 400 + -32700), missing-arguments (`isError:true`),
  concurrent-calls (id string masing-masing dipertahankan), rest-parity
  (repo + issue MCP terbaca via REST, id stabil), auth-required (401).
- Ekstra: `__schema`, createIssue/createPullRequest ke repo/branch tak dikenal
  (GraphQL errors, HTTP 200), tool berprefix `github__create_issue`,
  initialize `2026-07-28`, get_repo repo hilang (`isError:true`, HTTP 200),
  token salah (401), body JSON malformed (400).

## Keputusan desain

- **Global id opak**: repo `R_<databaseId>`, issue `I_<numericId>`,
  PR `PR_<numericId>`, komentar `IC_<numericId>`. Cek `global-id-stability`
  menolak id polos (`"5000"` / `"1"`), jadi bentuk ini wajib.
- **Fungsi bersama**: `createIssueInStore` / `createPullRequestInStore` /
  `mergePullRequestInStore` di `src/graphql.ts` adalah wrapper tipis atas
  `createIssue` / `createPullRequest` / `mergePullRequest` dari `src/rest.ts`
  (dipakai juga oleh `src/mcp.ts`). `closeIssueInStore` dan
  `addCommentInStore` tetap lokal — `rest.ts` tidak mengekspor padanannya.
  Bentuk JSON REST (`repoJson` / `issueJson` / `pullJson`) juga lokal di
  `graphql.ts` karena `rest.ts` tidak mengekspor shape helper-nya; isinya
  dicocokkan dengan `rest.ts` dan DESIGN.md §2.
- **Parser GraphQL tulisan tangan** (tokenizer + recursive descent):
  operasi, variabel (+ default), objek/liste inline, enum inline, alias,
  fragment spread + inline fragment (`... on Repository`), directive
  di-skip. Field tak dikenal → HTTP 200 + `errors:[{message:
  'Cannot query field "X" on type "T".'}]`, field itu `null`.
- **MCP dua era**: `server/discover` menjawab modern; `initialize` meng-echo
  revisi yang diminta bila ada di daftar dukungan, else `2026-07-28`;
  notifikasi (tanpa `id`) → 202 kosong. `tools/list` dari satu array konstan
  beku. Unknown tool → -32601; argumen wajib hilang → `isError:true`;
  body bukan JSON → HTTP 400 + -32700; tanpa auth → 401.
- **Determinisme**: tidak ada `Date.now()` / `new Date()` / `Math.random()`
  di kedua modul (hanya disebut di komentar). Timestamp dari
  `store.nowIso()`. `X-GitHub-Request-Id` memakai `req-<store.reqCounter>`
  **tanpa** menaikkan counter (counter dinaikkan oleh `store.nowIso()` dan
  `util.sendJson`); nilainya non-empty tapi bisa sama antar respons.

## Gap / risiko untuk integrasi (baca koordinator)

1. **Routing belum tersambung.** `app.ts` saat ini masih starter (hanya
   `/healthz` + root). Integrasi harus memanggil `handleGraphQL(req, res,
   store)` untuk `POST /api/graphql` dan `handleMcp(req, res, store)` untuk
   `POST /mcp` (keduanya mengembalikan `false` bila bukan rutenya, agar
   router bisa 404). Urutan disarankan: GraphQL/MCP dulu, lalu REST, lalu
   git — handler saya membaca body sendiri, jadi jangan ada middleware yang
   sudah mengonsumsi body sebelumnya.
2. **Auth**: token dibaca dari `process.env.MAKEFUN_SHOP_TOKEN` di tiap
   request. Bila env kosong, Bearer non-empty apa pun diterima (fallback
   dev); di trial env selalu ter-set, jadi ini tidak berpengaruh pada skor.
3. **Merge ganda**: `mergePullRequest` dari `rest.ts` melempar 405 bila PR
   sudah closed/merged. GraphQL `mergePullRequest` kedua untuk PR yang sama
   akan menjawab errors (bukan idempotent). Itu konsisten dengan REST;
   suite hanya merge sekali per PR.
4. **`viewerPermission` selalu `ADMIN`** (repo selalu milik viewer). Benar
   untuk semua repo yang dibuat lewat entry; tidak ada konsep kolaborator.
5. **`defaultBranchRef` null bila branch belum di-push.** Sesuai perilaku
   GitHub (repo kosong). Cek kit hanya menegaskan namanya bila fixture git
   sudah mem-push branch tersebut.
6. **Urutan issues tanpa `orderBy`**: default `CREATED_AT DESC` (nomor
   menurun). Cek paginasi tidak menegaskan urutan, hanya disjoin + lengkap.
7. **Tidak ada `__schema` lengkap**: `__schema` menjawab `types` /
   `queryType` / `mutationType` secukupnya; `__type` untuk nama tak dikenal
   menjawab `null` tanpa errors. Tidak ada dokumen kit yang meminta lebih.
8. **MCP `tools/call` memakai `isError:true` (HTTP 200)** untuk argumen
   hilang / repo hilang / branch hilang, bukan -32602 — keduanya diterima
   cek. Satu-satunya -32601 adalah tool/metode tak dikenal; -32700 hanya
   untuk body bukan JSON.
9. **Tidak ada session**: server tidak mengeluarkan `Mcp-Session-Id` dan
   menjawab `DELETE /mcp` dengan 204. Client kit tidak membutuhkannya
   (modern era tanpa session; legacy `close()` hanya DELETE bila ada
   session).
10. **Duplikasi yang sengaja tersisa**: `sendJson`/`readBody`/cek auth
    ditulis ulang kecil di tiap modul (bukan import `util.ts`) agar modul
    tetap berdiri sendiri; `util.sendJson` menaikkan `reqCounter` per
    respons, sementara handler saya tidak — bila koordinator ingin satu
    urutan counter untuk semua permukaan, pindahkan pengiriman JSON ke
    `util.sendJson(res, status, body, {}, store)` di `app.ts` atau di
    handler, dan hapus header manual saya. Jangan lakukan dua-duanya
    (header ganda / counter naik dua kali).
