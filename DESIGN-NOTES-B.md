# DESIGN-NOTES-B — modul REST v3 (`src/rest.ts`)

Ditulis 2026-11-17 oleh subagent modul B. Baca bersama `DESIGN.md` §2/§4 dan
`checks-rest.ts` (ground truth; tidak disalin ke entry).

## Yang ditulis

- `src/rest.ts` (1.398 baris, ~54 KB) — semua handler REST v3 + fungsi bersama
  untuk MCP. Ekspor: `handleRest(req, res, store): Promise<boolean>`,
  `createIssue(store, repo, input)`, `createPullRequest(store, repo, input)`,
  `mergePullRequest(store, repo, number, opts)`, plus `ApiError`,
  `computePullFiles`, `pullIsConflicted`, `epochToIso`, `isoToEpoch`.
- `work/dev/` (untracked, BUKAN bagian entry): `server.mjs` (server stub
  node:http + handleRest + stub Store), `stub-store.mjs` (Store minimal sesuai
  kontrak DESIGN §2), `test.sh` (80 cek curl). `dev/` juga berisi file dari
  subagent paralel lain (`server.ts`, `stub.ts`, `test.mjs`) — bukan buatan
  modul B, jangan dihapus/ditimpa tanpa koordinasi.

## Keputusan implementasi (di luar yang eksplisit di DESIGN.md)

- **Store/util belum ada saat modul ini ditulis** (`work/src/` masih kosong).
  Karena itu `rest.ts` hanya `import type` dari `./store.ts` (dihapus saat
  type-stripping, jadi modul jalan mandiri) dan TIDAK mengimpor `./util.ts`:
  body-parse, pagination Link, dan error diimplementasikan inline di sini.
  Bila koordinator mau, helper itu bisa dideduplikasi ke `util.ts` nanti —
  tapi jangan jadikan `rest.ts` bergantung pada `util.ts` sebelum file itu
  ada dan stabil.
- **Helper git-object minimal diduplikasi di dalam `rest.ts`** (SHA-1 id,
  encode/parse blob/tree/commit, flatten/rebuild tree, ancestry/merge-base).
  Modul git (`git-objects.ts`) belum ada saat penulisan; `rest.ts` tidak
  mengimpornya agar tetap bisa diuji sendiri. Dedup opsional belakangan.
- **Penomoran issue+pull berbagi satu counter** via `nextSharedNumber()`:
  ambil max(`issueSeq`, `pullSeq`, nomor issue/pull yang sudah dipakai, 1),
  lalu set KEDUA counter ke n+1. Tahan terhadap modul lain yang hanya
  menaikkan satu counter. Id = `100000 + repo.id*1000 + number`.
- **`pull.base.sha` di-refresh ke tip branch base saat dibaca/di-merge**
  (perilaku GitHub). Ini yang membuat cek konflik bekerja: PR kedua yang
  base-nya sudah maju karena merge pertama terdeteksi conflicted (405).
- **Konflik** = head dan base sama-sama mengubah path yang sama (relatif ke
  merge-base) ke isi berbeda, DAN base tip bukan ancestor head tip. Bila
  ragu (tidak ada path tumpang tindih / base ancestor head / tanpa
  merge-base) → mergeable.
- **Squash merge**: tree = tree base tip + perubahan head (relatif ke
  merge-base); parent = tip base; pesan
  `Merge pull request #N from <head-ref>` (+ body). Ref base dimajukan ke
  commit merge; pull → closed, merged, `merged_at`, `merge_commit_sha`.
- **Files PR** = diff merge-base → head tip. `additions`/`deletions` dihitung
  dari jumlah baris (bukan diff baris-per-baris) — cukup untuk cek
  (`additions >= 1`), tapi angkanya aproksimasi untuk file yang dimodifikasi.
- **Contents PUT**: repo unborn (tanpa refs) menerima commit pertama di
  branch default. Branch yang tidak ada padahal repo sudah punya commit →
  422. Update tanpa `sha` → 422; `sha` stale → 409; DELETE dengan `sha`
  salah → 409. Setiap PUT/DELETE membuat commit git sungguhan (blob + tree
  + commit, parent = tip branch, author `adaiversen <adaiversen@example.invalid>`).
- **Label duplikat** → 201 idempotent (mengembalikan label yang ada).
  Tidak dicek suite; GitHub asli memberi 422 — bila mau strict, ubah satu
  baris di `routeLabels`.
- **Merge PR yang sudah closed** → 405. **PR/issue tak dikenal** → 404.
- **Root `GET /api/v3/` tanpa auth**, semua route lain wajib Bearer token
  `MAKEFUN_SHOP_TOKEN`. `X-GitHub-Request-Id: req-<store.reqCounter>`,
  counter naik 1x per request di `handleRest`.
- **Tidak ada `Date` / wall-clock / `Math.random` di file ini** (grep
  terverifikasi). Epoch commit diturunkan dari `store.nowIso()` lewat
  aritmetika tanggal-sipil integer murni.

## Hasil uji lokal (stub server, token `test-token`)

- `bash dev/test.sh`: **80/80 PASS** — root/meta/user, create/duplikat/
  patch/delete repo, 401 tanpa & salah token, 404 repo tak dikenal & owner
  lain, contents create/get/update/stale-409/directory/delete,
  branches/commits (`?sha=` branch vs default, `/:sha` + parent),
  labels, issue create/label-422/numbers-increment/sort asc+desc/
  state filter/patch-close/comments, pull create (head/base sha, nomor
  berbagi counter: 3 issue → PR no. 4)/files/merge-squash (commit &
  konten di default branch, `merge_commit_sha`)/404/405 conflict,
  pagination 30 repo per_page=10 (3+ halaman, tanpa duplikat, semua
  terlihat), unknown-route 404 JSON, malformed body 400, request-id di
  semua reply yang dicek.
- **Determinisme**: urutan request yang sama di dua server fresh memberi
  commit sha identik (`1293712f…`).
- **Smoke test ekspor** (node langsung): `createIssue` nomor 1/2 + id
  `5100001/5100002`; label tak dikenal → 422; branch head tak dikenal →
  422; merge PR tak dikenal → 404.

## Gap / risiko untuk integrasi (baca koordinator)

1. **`app.ts` BELUM diintegrasikan (bukan file modul B). PENTING:**
   `app.ts` starter saat ini menjawab `GET /api/v3/` sendiri TANPA header
   `X-GitHub-Request-Id` — cek `protocol.request-id` menuntut header itu
   di root. `app.ts` HARUS mendelegasikan SEMUA `/api/v3/*` (termasuk root)
   ke `handleRest(req, res, store)` dengan SATU Store bersama, dan memakai
   nilai kembalian `false` untuk lanjut ke git/GraphQL/MCP/healthz.
2. **Asumsi kontrak store** (belum bisa diverifikasi karena `store.ts`
   belum ada saat penulisan): `createRepo(name, opts)` memakai
   `default_branch` `'main'` bila opts kosong; `issueSeq`/`pullSeq` mulai
   1 (kode tahan bila mulai 0); `repo.labels/issues/pulls/objects/refs`
   terinisialisasi; `viewer.email` terisi (fallback
   `<login>@example.invalid` bila kosong); `nowIso()` deterministik dari
   `reqCounter`. Bila `store.ts` final menyimpang, yang pecah pertama
   adalah penomoran dan timestamp — cek dengan `dev/test.sh` memakai
   store asli.
3. **`reqCounter` naik hanya untuk request REST** (di `handleRest`).
   Bila GraphQL/MCP/git juga perlu `X-GitHub-Request-Id` dengan counter
   yang sama, naikkan counter di `app.ts` sebelum dispatch, bukan di
   tiap modul — kalau tidak, dua modul bisa memberi id yang sama.
4. **Performa**: `pullJson()` menghitung ulang `mergeable` (tree walk)
   tiap GET pull — murah untuk repo kecil, tapi jangan dipakai di path
   read 2000x (workload read memakai GET issue, yang hanya lookup array).
5. File `src/rest.ts` memakai `import type` dari `./store.ts`; dengan
   `node --experimental-strip-types` (Node ≥22.18, sesuai
   `package.json`) ini terhapus dan tidak butuh `store.ts` di runtime
   untuk modul ini sendiri — tapi `tsc --noEmit` (bila dijalankan
   koordinator) tetap butuh `store.ts` ada agar tipenya ter-resolve.
