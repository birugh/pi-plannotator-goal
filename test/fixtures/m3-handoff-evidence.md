# M3.2 runtime handoff evidence

Sesi: satu TUI nyata di `tmux` session `m3probe`:
`pi --plan --extension /home/biru/.pi/agent/plans/probes/m3-handoff-probe.ts`
(`mode=tui`, `hasUI=true` — dibuktikan baris `session-start` di `m3-handoff-evidence.jsonl`).

Log sesi: `sessions/--home-biru-.pi-agent--/2026-10-04T13-49-56-121Z_01a1072d-ac18-7636-a308-4c1780f00387.jsonl`
(baris `L<n>` di bawah menunjuk file ini). Bukti mesin: `plans/probes/m3-handoff-evidence.jsonl`.

Goal probe yang terbentuk: `mutvvtbc-z24zn2`
(`.pi/goals/active_goal_2026100420555172_mutvvtbc-z24zn2.md`).

---

## Test F — event handoff (`plan-approved` → deferred → `sendUserMessage`)

Payload mentah `m3-handoff-evidence.jsonl`:

```json
{"kind":"plan-approved-sync","planFilePath":"plans/M-90-probe-gate-test.md","feedback":null,"sessionCtxCached":true,"isIdleAtSync":false}
{"kind":"handoff-deferred","isIdleAtDeferred":false,"deliverAs":"steer"}
{"kind":"sendUserMessage-sent","deliverAs":"steer"}
```

FACT:

1. Event tiba saat agent **busy**: `isIdleAtSync=false`. Selaras timing M2 (emit di dalam
   `execute()` submit; `terminate: true` `@plannotator/pi-extension/index.ts:1356`, `:1415`).
2. `setImmediate` masih `isIdleAtDeferred=false` (gap sync→deferred 4 ms) → **defer satu macrotask
   tidak cukup** untuk mendapatkan `isIdle()===true` di jalur ini.
3. `deliverAs` dipilih dari nilai terukur, bukan asumsi → `"steer"`.
4. Pesan benar-benar sampai: transcript `L19` (pesan masuk sebagai user turn) → `L20` assistant
   menjawab `HANDOFF-RECEIVED`. Tidak ada tool dipanggil pada turn itu.

U-2, U-3, U-9 **tertutup**:

- U-2: handler event tidak memanggil UI apa pun; `setImmediate` cukup aman untuk
  `sendUserMessage` (tidak ada deadlock, pesan terkirim, agent melanjutkan).
- U-3: ctx yang di-cache dari `session_start` (`pi.events.on` hanya menerima `data`, lihat
  `plans/probes/m2-probe.ts:115`) punya `isIdle()` yang berfungsi di waktu event.
- U-9: `steer` adalah pilihan yang benar untuk kondisi terukur; `followUp` **belum** terbukti
  diperlukan maupun berbahaya (tidak diuji = tetap UNKNOWN parsial, lihat bawah).

## Test A — `create_goal` → `set_goal_tasks` → konfirmasi manusia → tree persisted

| Langkah | Bukti |
|---|---|
| `create_goal` dipanggil | transcript `L24` (`toolCall create_goal`) |
| goal dibuat + fokus | `L25` custom entry `{"focusedGoalId":"mutvvtbc-z24zn2","reason":"created"}` |
| laporan create | `L26` `"Goal confirmed and created. Finalized goal: ..."` + baris `other open goal remain in .pi/goals — this goal is now the session focus.` |
| `set_goal_tasks` dipanggil | `L29` |
| konfirmasi manusia muncul | capture pane: dialog `Task list confirmation`, daftar `T-01`/`T-01.1`/`T-02`, footer `Confirm task list` \| `Keep current tasks`, `blockCompletion enabled` |
| accept (Enter oleh user) | `L30` toolResult `"Task list set and confirmed. 3 tasks. (blockCompletion enabled)"` |
| tree persisted | file goal: `taskList.tasks = ["T-01","T-02"]` (T-01 punya anak `T-01.1`), `blockCompletion: true` |

FACT: jalur dua tool bekerja end-to-end di sesi ber-UI, dan gate 2 benar-benar manusia
(dialog native pi-goal, bukan auto-confirm; `PI_GOAL_AUTO_CONFIRM` tidak pernah diset —
`env | grep PI_GOAL` kosong).

## Test B — `terminate: true` (U-1) — **tertutup**

Urutan transcript:

```text
L22 user      instruksi "SAME turn, two calls"
L24 assistant toolCall create_goal
L25 custom    focusedGoalId ... reason created
L26 toolResult "Goal confirmed and created..."
L27 system    (boundary)
L28 custom_message <pi_goal_continuation goal_id=mutvvtbc-z24zn2 kind=checkpoint v=2/>
L29 assistant toolCall set_goal_tasks
L30 toolResult "Task list set and confirmed. 3 tasks."
```

FACT: ada `system` boundary + `pi_goal_continuation` checkpoint **di antara** kedua tool call.
Artinya `terminate: true` (`goal-core-tools.ts:228`) mengakhiri batch: `set_goal_tasks` hanya
berjalan setelah checkpoint continuation, **bukan** pada turn/step yang sama.

Konsekuensi untuk adapter (D-12): handoff dua langkah **tidak bisa** dikirim sebagai satu batch
tool; agent wajib melanjutkan lewat continuation, dan dialog task terjadi di step lanjutan.
Jendela "goal active tanpa task tree" (I-1) karenanya nyata dan terukur, bukan teoretis.

## Test C — depth (U-4) — **tertutup**

| Call | Hasil |
|---|---|
| `L39` `T-01`, `T-01.1`, `T-01.1.1` | `L40` toolResult `Task "T-01" has subtask nesting depth 2, exceeding the configured maximum of 1` — tanpa dialog, tanpa mutasi |
| `L41` `T-01`, `T-01.1` | dialog muncul (`L42` menunggu keputusan manusia) |

FACT: `subtaskDepth=1` menolak `T-01.1.1` di runtime; pesan error pi-goal persis seperti yang
diprediksi dari source (`goal-task-tools.ts:135-137`). Tidak ada setting yang diubah.

## Test D — dialog reject — **tertutup**

`L41` `set_goal_tasks` (2 task) → dialog tampil → **Esc = `Keep current tasks`** oleh user.

- `L42` toolResult: `"Task list kept unchanged."`
- File goal setelah reject: `taskList.tasks = ["T-01","T-02"]`, `blockCompletion: true`,
  `revision: 20`, `status: paused`.

FACT: reject = nol mutasi (bukan sebagian). Selaras `goal-task-tools.ts:336-340`.

Catatan penting (bukan bug, tapi fakta UX): agent **tidak melihat** dialog reject. Hasil
tool datang sebagai `Task list kept unchanged.` tanpa penanda "dialog ditolak manusia", dan agent
menyimpulkan "no dialog appeared". Adapter tidak boleh bergantung pada agent untuk membedakan
"manusia menolak" vs "dialog tidak tersedia" — pesan yang sama bisa berarti kedua hal
(bandingkan `goal-task-confirmation.ts:41` `ui.select` tidak ada → `cancel`).

Timing: `L41` 14:02:07.551 → `L42` 14:03:33.448 = **86 detik** menunggu keputusan manusia;
durasi keputusan tak terbatas (U-11 dari M2 tetap berlaku: adapter tidak boleh timeout).

## Test E — existing goal terdeteksi (U-10) — **tertutup**

Tiga jalur publik, semuanya teramati:

1. Banner `pi-goal-x` saat sesi mulai: `1 open goal is available. Run /goal-focus to choose the
   goal for this session.` dengan status bar `goal: unfocused [1 open]`.
2. Laporan `create_goal` (`L26`): `other open goal remain in .pi/goals — this goal is now the
   session focus.`, dan status bar probe goal: `(+1 open)`.
3. Operator `/goal-list` (dijalankan di sesi probe):

```text
Open goals: 2
  mutt0yeo-txzlrv — running · goal · 45m45s · 933K
  Selesaikan M3 Goal Adapter (M3.1→M3.5, STOP+report ...)
  ...activePath
```

FACT: kondisi "existing open goal yang bukan milik plan ini" dapat dideteksi tanpa API privat:
banner/prompt fokus, laporan create, dan `/goal-list` semuanya permukaan yang sah. D-14
(STOP + REPORT + user memilih) karenanya bisa ditegakkan dengan data di atas, termasuk
`activePath` yang dibutuhkan untuk laporan.

INFERENCE (batas jalur): adapter **tidak** bisa membaca pool goal sendiri (tanpa `_goalCore`).
Jadi langkah 1–2 D-14 dijalankan oleh **agent** atas instruksi adapter (pesan memuat perintah
"laporkan goal terbuka lain sebelum create"), atau oleh adapter hanya sebagai instruksi
teks — bukan pembacaan state oleh adapter. Ini adalah konsekuensi boundary, bukan kekurangan
sementara.

## U-5 — merge saat struktur berubah: belum diuji

Tidak dijalankan (bukan bagian Test A–E; biaya token sesi tinggi). Status: **UNKNOWN** dibawa
ke M3.3/M4; jalur source tetap `mergeTasksWithExisting` (`goal-task-tools.ts:148-185`,
`tasks.ts` panggilan `:350-351`) dan D-10 tidak terpengaruh karena plan approve bersifat beku.

## U-11 — `deliverAs: followUp` belum pernah diuji

`steer` terbukti bekerja untuk kondisi terukur. `followUp` tidak diuji → tetap UNKNOWN.
Aturan adapter sementara: `ctx.isIdle() ? "followUp" : "steer"` (pola `goal-drafting.ts:182`),
dengan catatan bahwa di jalur `plan-approved` nilai terukur selalu `false` (Test F).

---

## Perintah reproduksi

```bash
tmux new-session -d -s m3probe "pi --plan --extension /home/biru/.pi/agent/plans/probes/m3-handoff-probe.ts"
# Test F: submit plans/M-90-probe-gate-test.md, approve di http://127.0.0.1:<port acak>/
#   port: ss -ltnp | grep "pid=$(tmux list-panes -t m3probe -F '#{pane_pid}'),"
#   (dua port: 73xx = pi-web-ui, 35xxx = review browser)
# Test A/B/C/D: instruksi tool di pane yang sama; dialog dijawab user (Enter / Esc)
# Test E: /goal-list di pane yang sama
```

Batas: mudah lapuk bila port/prompt berubah; angka yang dikutip (revision, task id, timestamp)
diambil dari file/sesi saat M3.2 dan tidak di-hardcode di kode.