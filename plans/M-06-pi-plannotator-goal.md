# M-06 Pi Plannotator Goal as a standalone repository

Goal: `~/dev/pi-plannotator-goal` is a standalone repo holding one adapter split into modules, all tests green, while `~/.pi/agent` loads it.

## Context

Adapter `plannotator:plan-approved` menuju pi-goal sekarang satu file 349 baris,
`extensions/goal-adapter.ts`, dan hidup di dalam repo dotfiles `~/.pi/agent`. Ia
mencampur pemuatan config, logging, parsing teks `PLAN.md`, perakitan IR, pembacaan pool
goal, penyusunan pesan handoff, dan registrasi extension. Semua keputusan desain sudah
difinalkan lewat sesi grilling; file ini adalah rencana eksekusinya, bukan tempat
membuka ulang keputusan itu.

## Current Architecture

- `~/.pi/agent` sudah repo git (16 commit, tanpa remote). Adapter sudah ter-commit
  1-per-1 di sana: `75f2c1f`, `5861a76`, `5b3cecd`.
- `extensions/goal-adapter.ts` memakai `as` buta di dua batas tak terpercaya: payload
  event `const event = (data ?? {}) as {...}` dan `isEnabled` yang mengurai JSON lalu
  menegakkan `as { enabled?: unknown }`.
- `findOpenGoals(cwd)` membaca `join(cwd, ".pi", "goals")` dan `.../archived` secara
  hardcode, mengabaikan relokasi pool pi-goal-x lewat `goalsRoot` atau `PI_GOAL_ROOT`.
- `RejectError` dipakai lintas batas oleh `m3-adapter-check.ts:7,86` dan
  `m3-failure-cases.ts:4,53` (13 kasus `instanceof`).
- Kill switch ada di `goal-adapter.json` root agent dir dan sudah ter-track dotfiles.
- Loader pi: `package.json` field `pi.extensions` dulu, lalu `index.ts`, lalu `index.js`;
  symlink diterima; subdirektori `extensions/*/` ikut dipindai.
- `plans/validate.mjs` dipanggil lewat path absolut dari `plannotator.json` dan
  `prompts/milestone.md`, dan satu kali lagi oleh adapter sebelum handoff.

## Proposed Architecture

Repo baru `~/dev/pi-plannotator-goal` berisi `index.ts` tipis plus delapan modul
sejajar di root: `types.ts`, `config.ts`, `log.ts`, `plan-text.ts`, `ir.ts`,
`goals-pool.ts`, `goals.ts`, `handoff.ts`. Semua batas tak terpercaya (file config dan
payload event) divalidasi runtime dengan schema `typebox`, lalu tipe TS diturunkan dari
schema itu, bukan ditulis dua kali. `RejectError` diganti union `RejectReason` dan
`buildGoalIR` mengembalikan `Result<GoalIR, RejectReason>`, jadi penolakan adalah nilai
biasa, bukan lemparan. `goals-pool.ts` meresolusi `goalsRoot` setia untuk satu key itu
saja: env `PI_GOAL_ROOT`, lalu project `pi-goal-x-settings.json`, lalu global agent dir,
lalu default `cwd/.pi/goals`; malformed atau nilai invalid berarti berhenti aman, bukan
diam-diam kembali ke default.

## Scope

- Membuat repo baru dan memindahkan kode adapter ke sana.
- Memecahnya menjadi sembilan modul, menambah tes, lalu cutover dotfiles.

## Out of Scope

- Menyentuh source `@plannotator/pi-extension` atau `pi-goal-x`.
- Memindahkan atau menghapus `validate.mjs`, dokumen historis M0-M3, dan `plans/fixtures`.

## Technical Approach

Urutan wajib, karena setiap langkah harus bisa dibuktikan hijau sebelum langkah
berikutnya:

1. Rekam baseline: jalankan tiga probe lama terhadap kode sekarang, simpan outputnya.
2. Buat direktori repo baru dan commit init yang berisi `goal-adapter.ts` verbatim plus
   `.gitignore` saja.
3. Tambah `package.json`, `tsconfig.json`, lalu install devDependencies (`typebox` hanya
   devDependency untuk tipe; runtime-nya bundled host versi 1.3.27 persis).
4. Pecah modul satu per satu, tiap commit meninggalkan `node --test` hijau.
5. Setelah semua modul hijau, hapus `goal-adapter.ts` dan pasang `pi.extensions` di manifest.
6. Migrasikan probe ke `test/` sebagai `node:test`, salin fixture yang dibutuhkan, dan
   tulis `test/EVIDENCE.md` berisi output lama berdampingan dengan output baru.
7. Baru lakukan cutover dotfiles dalam satu commit, lalu bersihkan `plans/probes`.
8. Terakhir, dokumentasi: `README.md` root plus `docs/CONFIG.md`, `docs/PIPELINE.md`,
   `docs/GOALS-POOL.md`, `docs/DEVELOPMENT.md`, `docs/FINDINGS.md`.

`plans/validate.mjs` tidak disalin. Adapter menerima path-nya lewat kunci config
`validatePath` dengan default di agent dir, sehingga kepemilikannya tetap di dotfiles.

## Risks / Constraints

- Resolver `goalsRoot` bisa menyimpang bila pi-goal-x mengubah precedence atau validasinya.
- Fixture plan hidup di dua repo, dan tes tidak boleh menyentuh agent dir asli.

## S-01 Bootstrap the repository and its toolchain

- Scope: hanya membuat repo, commit init verbatim, dan scaffolding tooling; belum ada perubahan perilaku
- [ ] T-01 Create `~/dev/pi-plannotator-goal` and commit `init: Initialize repository` with `goal-adapter.ts` verbatim
- [ ] T-01.1 Add a `.gitignore` for `node_modules` and editor noise only, never for the settings file
- [ ] T-02 Add `package.json` with name `pi-plannotator-goal`, `private`, `type: module`, and `pi.extensions` under `./index.ts`
- [ ] T-02.1 Pin devDependencies `@earendil-works/pi-coding-agent` 0.87.1, `typescript` 5, `@types/node` 24, `typebox` 1.3.27
- [ ] T-03 Add `tsconfig.json` with `noEmit`, `nodenext`, `strict`, and include of root modules plus `test`
- [ ] T-04 Confirm the baseline is green with `npx tsc --noEmit` and `node --test`

## S-02 Config and logging as validated boundaries

- Scope: memuat config dua scope dan menulis log; hanya `config.ts` dan `log.ts` baru
- [ ] T-05 Implement `config.ts` with a `typebox` schema for the config file and for the `plan-approved` payload
- [ ] T-05.1 Resolve config per file, project `plannotator-goal.json` over global agent dir file, missing or invalid falls back
- [ ] T-05.2 Default `validatePath` to the agent dir validator and `logPath` to the agent dir probe log, relative `logPath` resolved against `cwd`
- [ ] T-06 Add `test/config.test.ts` covering the `enabled` truth table, scope precedence, malformed JSON, and a bad payload
- [ ] T-07 Add `log.ts` writing JSONL with `mkdirSync` recursive and timestamp injected at call time

## S-03 Pure plan parsing and IR assembly

- Scope: memisahkan parsing teks dari perakitan IR; hanya `plan-text.ts`, `ir.ts`, dan tesnya
- [ ] T-08 Extract `plan-text.ts` with `parsePlanText` reading the Goal line, task checkboxes, requirement bullets, execution order, and context sections
- [ ] T-09 Extract `ir.ts` with `buildGoalIR(parsed, source)` returning `Result<GoalIR, RejectReason>`
- [ ] T-09.1 Keep the guards `MAX_TASKS` 50, `MAX_DEPTH` 1, `MAX_OBJECTIVE` 1400, `MAX_CONTRACT` 700 as named constants
- [ ] T-10 Add `test/plan-text.test.ts` and `test/ir.test.ts` covering every reject reason with string inputs only

## S-04 Goal pool resolution and open-goal detection

- Scope: menghormati relokasi pool pi-goal-x; hanya `goals-pool.ts`, `goals.ts`, dan tesnya
- [ ] T-11 Implement `goals-pool.ts` resolving `goalsRoot` from `PI_GOAL_ROOT`, project settings, global settings, then default `cwd/.pi/goals`
- [ ] T-11.1 Honor the file path overrides `PI_GOAL_SETTINGS_FILE` and `PI_GOAL_GLOBAL_SETTINGS_FILE`
- [ ] T-11.2 Refuse to hand off with a typed reason when settings JSON is malformed or the value is not absolute, contains NUL, or is a symlink
- [ ] T-12 Implement `goals.ts` with `findOpenGoals(poolRoot)` over the pool and its archived directory plus `buildExistingGoalReport`
- [ ] T-13 Add `test/goals-pool.test.ts` as a decision table over env, project, global, default, malformed, and invalid inputs

## S-05 Handoff message and thin factory

- Scope: memindahkan penyusunan pesan dan registrasi; `handoff.ts` plus `index.ts`, lalu hapus file lama
- [ ] T-14 Extract `handoff.ts` with `buildHandoffMessage(ir)` and the rejection message builder
- [ ] T-15 Rewrite `index.ts` as a factory registering `session_start` and the approved-plan event, orchestration only
- [ ] T-15.1 Delete `goal-adapter.ts` and confirm no module still imports it
- [ ] T-16 Add `test/factory.test.ts` running the factory end to end against `PI_CODING_AGENT_DIR` and a temp `cwd`

## S-06 Migrate probes and capture the evidence

- Scope: memindahkan tiga probe adapter ke `test/` plus fixture yang dibutuhkan, tanpa mengubah perilaku
- [ ] T-17 Port `m3-adapter-check.ts`, `m3-failure-cases.ts`, `m3-adapter-skip-check.ts` to `test/*.test.ts` on `node:test`
- [ ] T-18 Move `m3-handoff-probe.ts` and copy the fixtures `m3-basic-plan.md`, `m3-handoff-only-plan.md`, `m3-handoff-evidence.md`, `m3-handoff-evidence.jsonl` into `test/fixtures`
- [ ] T-19 Write `test/EVIDENCE.md` pairing the recorded baseline output with the post-refactor output for each probe

## S-07 Documentation for the standalone repo

- Scope: dokumentasi baru di repo baru; tidak menghapus atau memindahkan dokumen M0 sampai M3
- [ ] T-20 Write root `README.md` as the GitHub face: purpose, install, config, pipeline summary, and backticked links to `docs`
- [ ] T-21 Write `docs/CONFIG.md`, `docs/PIPELINE.md`, `docs/GOALS-POOL.md`, `docs/DEVELOPMENT.md` in English ASCII
- [ ] T-22 Write `docs/FINDINGS.md` as numbered findings with claim, evidence, decision, and consequence, including rejected options

## S-08 Dotfiles cutover and cleanup

- Scope: satu commit cutover di `~/.pi/agent` plus pembersihan `plans/probes`; tidak menyentuh dokumen historis
- [ ] T-23 Cut over: remove `extensions/goal-adapter.ts`, rename the kill switch to `plannotator-goal.json`, register the new repo in `settings.json`, delete `tsconfig.json`
- [ ] T-24 Remove `plans/probes`, keep `validate.mjs`, `WORKFLOW.md`, `PLAN-CONTRACT.md`, `fixtures`, and the nine historical documents
- [ ] T-25 Verify pi loads the extension from `/home/biru/dev/pi-plannotator-goal` and the adapter rejects and hands off identically

## Completion Requirements

- CR-001: init commit holds goal-adapter.ts verbatim, later deleted
- CR-002: nine root modules exist; tsc --noEmit exits 0 under strict
- CR-003: node --test exits 0; migrated probes pass
- CR-004: EVIDENCE.md shows pre and post refactor output matching
- CR-005: no blind type assertion on the event payload or config JSON
- CR-006: project config overrides global; an invalid file falls back to global
- CR-007: goals-pool resolves env, project, global, default; malformed refuses
- CR-008: validate.mjs unchanged, reached via config key validatePath
- CR-009: dotfiles load the new repo; old adapter and tsconfig gone
- CR-010: README and docs exist in English ASCII without em dashes