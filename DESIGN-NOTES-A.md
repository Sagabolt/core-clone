# DESIGN-NOTES-A — modul STORE + GIT (subagent A)

Catatan untuk koordinator/integrasi. Kontrak `DESIGN.md` §2 TIDAK diubah sepihak; di bawah ini
yang saya asumsikan / yang kurang di kontrak / yang perlu diputuskan modul lain.

## 1. Asumsi yang saya pakai (sudah diimplementasikan)

1. **Satu counter `seq` untuk issue+pull.** `DESIGN.md` §2 menampilkan `issueSeq`/`pullSeq`
   di interface `Repo` tapi teksnya memerintahkan SATU counter gabungan. Saya simpan ketiganya:
   `seq` adalah counter yang dipakai; `issueSeq`/`pullSeq` selalu disinkronkan ke `seq`
   (`nextNumber()`). Id global = `100000 + repo.id*1000 + number` via `issueGlobalId()`.
2. **`nowIso()` mengonsumsi satu detik per panggilan** (`reqCounter += 1`, lalu
   epoch + counter). Jadi timestamp monoton naik di dalam satu run dan deterministik untuk
   urutan request yang sama. Konsekuensi: `X-GitHub-Request-Id` dari `util.nextRequestId(store)`
   dan `nowIso()` berbagi satu counter — id request bisa "melompat" bila handler memanggil
   `nowIso()` beberapa kali. Itu tidak melanggar apa pun (id hanya harus non-empty).
   Bila app.ts memakai counter util-nya sendiri (tanpa store), tidak ada interferensi.
3. **Label TIDAK di-seed.** `Store.createRepo` membuat `labels` kosong. Label default GitHub
   (`bug`, `enhancement`, …) hanya ada bila dibuat lewat `POST /labels` (modul REST).
   Alasan: cek "label harus dibuat dulu sebelum issue boleh memakainya" + 422 label tak dikenal
   akan salah bila label sudah ada sejak lahir. Bila REST ternyata mengharapkan seed, ubah
   di `createRepo` saja.
4. **`createIssue`/`createPull` tinggal di `store.ts`** (fungsi bersama yang diekspor), sesuai
   opsi di `DESIGN.md` §5 ("di store.ts atau rest.ts"). REST/GraphQL/MCP sebaiknya memanggil
   ini, bukan menduplikasi penomoran.
5. **`handleGit` TIDAK memeriksa auth.** Tanda tangannya `handleGit(req, res, store)` dan ia
   tidak menerima token. Bila app.ts ingin git route ber-auth, app.ts harus memeriksa
   `Authorization` sebelum memanggil `handleGit` (atau meneruskan token). Suite selalu
   mengirim token di git request; tidak ada cek git yang menguji tanpa token.
6. **Ref `HEAD` menunjuk `refs/heads/<default_branch>` repo itu.** Bila default branch
   dihapus via push dan hanya ada branch lain, HEAD di iklan v0 memakai branch head pertama
   yang ada (urutan sort); bila tidak ada branch sama sekali, HEAD = zero oid.
7. **`deepen-since` / `deepen-not` diimplementasikan best-effort** (timestamp committer,
   eksklusi seperti `have`). Tidak ada cek yang memakainya; `filter` diabaikan dengan aman
   (tidak diiklankan, jadi klien tidak akan memintanya).

## 2. Yang diverifikasi melawan git ASLI (bukan hanya kit client)

Aturan wire berikut saya buktikan dengan trace `GIT_TRACE_PACKET` terhadap `git daemon`
(git 2.43) — kit client saja TIDAK cukup, karena kit client menerima jawaban yang git
asli tolak:

- **Fetch v2 dengan `done` di request → TANPA section `acknowledgments`.** Dengan `done`,
  jawaban langsung `shallow-info` + `packfile`. Tanpa `done` (request berisi `have`) →
  `acknowledgments` (ACK + `ready`) + `shallow-info` (selalu ada, boleh kosong) + `packfile`,
  semua dalam SATU respons POST.
- **Report push: di dalam band 1 harus ada paket flush (`0000`) setelah baris report.**
  Tanpa flush dalam-band, git membaca `unpack ok` + `ok …` lalu mati dengan
  "the remote end hung up unexpectedly". Format: band-1 = pkt(`unpack ok`) +
  pkt(`ok|ng …`) + flush; lalu flush luar penutup respons.
- **Fetch v0 stateless butuh kapabilitas `multi_ack_detailed`** (bukan `multi_ack` saja);
  tanpanya git menolak dengan "the option '--stateless-rpc' requires 'multi_ack_detailed'".
- **ls-refs v2: git mengirim `ref-prefix HEAD` juga**, dan `peel`/`symrefs`/`unborn`
  selalu dikirim (kecuali dimatikan eksplisit). Implementasi sudah menanganinya.

## 3. Gap / risiko untuk integrasi

- **`tsconfig.json` di work/ hanya `include: ["*.ts"]`** (root). `src/*.ts` tidak termasuk
  cakupan kompilasi — `tsc --noEmit` proyek tidak memeriksa modul ini. Runtime memakai
  type-stripping jadi tidak berpengaruh ke jalan; tapi koordinator sebaiknya menambahkan
  `"src/*.ts"` ke `include` bila ingin typecheck penuh. (Di VM ini juga tidak ada `tsc`
  terpasang; verifikasi sintaks dilakukan via import `node --experimental-strip-types`.)
- **Performa clone ~1,3× lebih lambat dari T_ref** (352 ms vs 266,94 ms untuk 50 shallow
  clone konkuren, diukur in-process dengan GitClient kit). Penyebab utama: 3 round-trip
  HTTP per clone (info/refs + ls-refs + fetch) + overhead `node:http`; pack depth-1
  sendiri sudah O(tip). Push justru ~1,6× lebih cepat dari T_ref (1045 ms vs 1640,82 ms).
  Bila perlu: satu-satunya penghematan server-side yang tersisa adalah mengurangi alokasi
  Buffer per request; tidak ada cache pack (sesuai DESIGN §6, jangan dulu).
- **Pack yang dikirim SELALU tanpa delta.** Itu legal dan lolos semua cek (cek `pack-deltas`
  hanya menuntut delta — bila ada — ter-resolve; 0 delta lolos). Konsekuensi: clone penuh
  repo besar memakai bandwidth lebih besar dari reference; bukan masalah skor kecuali
  perf clone memburuk di repo 200-commit (tidak — tip-only untuk depth-1).
- **`readPack` melempar bila trailer checksum salah.** Push dengan pack korup → jawaban
  `unpack <detail>` + `ng … unpack failed` per ref. Belum ada cek untuk itu; perilaku ini
  sesuai git.
- **Push yang gagal unpack TETAP menyimpan objek yang berhasil di-parse sebelum gagal?**
  Tidak — `readPack` bersifat atomik (gagal → tidak ada objek yang disimpan). Git asli
  juga tidak menyimpan objek dari pack korup. Perilaku ini aman.
- **Objek dari push yang ditolak (non-FF) TETAP disimpan** di `repo.objects` (seperti git:
  unpack dulu, validasi ref sesudahnya). Objek itu tidak terjangkau dari ref mana pun,
  jadi tidak ikut terkirim saat clone/fetch. Aman.
- **Validasi `oldOid` pada push**: bila `oldOid` tidak sama dengan ref saat ini →
  `ng <ref> old value does not match`. Bila ref tidak ada saat update/delete, atau sudah
  ada saat create → `ng` dengan alasan yang sesuai. Tidak ada cek untuk jalur ini.
- **Repo di bawah owner lain → 404** dijamin oleh `getRepo` (key `${owner}/${name}` dan
  `createRepo` selalu memakai viewer). Bila suatu saat ada repo org/stranger di store,
  kontrak ini harus ditinjau ulang.
- **Dua `Date` di `store.ts`/`git-objects.ts` adalah `new Date(epoch…)`** — itu BUKAN
  `Date.now()`; nilainya murni fungsi counter deterministik. Tidak ada `Date.now()`,
  `new Date()` tanpa argumen, atau `Math.random()` di modul ini (grep-able).
- **Header `X-GitHub-Request-Id` pada respons git**: `sendRaw` ikut menambahkan
  `req-<n>` (tidak mengganggu git; git mengabaikan header ekstra). Bila app.ts kelak
  mengirim git response tanpa header itu, tidak ada cek yang menuntutnya di permukaan git.

## 4. Yang BUKAN milik modul ini (jangan ditagih ke saya)

- `app.ts`/`main.ts`, router REST, GraphQL, MCP, dan isi `README.md`/`package.json`.
- Pembuatan repo lewat REST yang sebenarnya (stub di `dev/` hanya untuk pengujian).
- `.gitignore` untuk `dev/` — direktori `work/dev/` berisi skrip uji dan HARUS dikeluarkan
  dari repo entri saat push (untracked). Bila koordinator membuat repo, tambahkan `dev/`.
