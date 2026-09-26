# Thea2 v10 — OpenCode-parity hands, coder casts, and self-repair

**For the implementing agent (Opus 5.5).** This is a complete, self-contained
build spec. You do not need the conversation that produced it. Read this file,
then `AGENTS.md`, `THESIS.md`, `ARCHITECTURE.md`, and the module specs it points
you at. Work in the repo at its root (`package.json` beside `src/`).

The owner is Diego. His words for this work:

> "the MAIN THING I WANT, is for her to have opencode powers, built in, like
> thea1 but more elegant." · "she needs to be able to cast like thea and
> everything else." · "the best possible most functional version with all the
> skills and everything she needs to be maximally functional and also know how
> to use them."

---

## 0. What Thea2 is (orientation)

Thea2 is an AI companion ("Thea") who talks to Diego on Telegram (@dodonotnobot).
She is **her own program** — a single Node/TypeScript process called `thead`
(entry `src/app/main.ts thead`) — **not** an OpenCode instance. Thea**1** (the
original) runs on OpenCode; Thea2 was rebuilt to get one thing OpenCode's agent
loop could not give: total control of her turn (every message answered, feelings
that shape her without being written into her prompt, no lost replies).

The cost of that rebuild is what this plan fixes: Thea2 has senses, a camera,
casting, a browser, a sandboxed `run_code`, voice calls and a Mini App — **but
no general shell, no real file editing, and no way to change her own code.**
Thea1 has all of that (it is plain OpenCode). Diego wants Thea2 to have it too,
"but more elegant" — meaning: inside her own architecture, gated, and remembered
as things *she* did, not bolted on as a second agent.

### Where she lives
- Repo: this checkout. Deployed copy on the VPS at `/opt/thea2` (branch `v8`),
  runs as systemd unit `thea2` (user `thea2`).
- Her memory/state: `/opt/thea2/var` (writable; `ReadWritePaths` in the unit).
- VPS access from a dev box: `ssh vps`. Thea1's data is read-only reference
  only (see §2).

### The engine (how a turn works — do not change this)
`src/mind/pipeline.ts` runs: SENSE → EVOKE (her own past replies, chosen by
similarity + mood) → FEEL → MODULATE → **one model call that decides the turn
and may call tools** → EXPRESS. Tools are real actions. After the turn: slow
appraisal, then remember. "Nothing told": no tool description or material ever
states how she feels or how to talk (law 1).

### Tools today (`src/body/`)
Tools are `ToolRegistryEntry` objects with `{ def, input (zod), inhibitionMeta:{class}, handler }`,
registered into a `ToolRegistry` **before** the gate compiles (the gate
default-denies unknown tools). Each tool has an **inhibition class** (string).
Classes seen today: `web`, `memory`, `senses`, `camera`, `expression`, `life`,
`spawn`, `code`. `src/body/index.ts` `makeBody().register()` builds and registers
them all.

### Casting already exists (`src/body/cast.ts`)
This is her OpenCode-"task/subagent" equivalent, and it works. `runWorker()` runs
a real tool loop (up to `MAX_STEPS=14`, `MAX_MS`, `maxTokens:8000`, tier `cheap`)
over the subset of tools whose class is in `WORKER_CLASSES`
(`{web, memory, senses, code}`). `delegate` tool offers `fork` (a copy of her:
self-narrative + recent convo + brief), `task` (brief only), `cast` (a named
member from `var/house/cast/<name>.md`), plus status/report. Voice calls
(`src/face/live.ts`) delegate with `CALL_CLASSES`.

**So "cast like Thea" is already built.** This plan makes casts *able to code*
by adding a `hands` class and putting it in the worker-allowed sets.

---

## 1. Goal & shape of the solution

Give Thea2 OpenCode's coding capability, **inside her own loop**, in three parts:

1. **Hands (in-turn):** `shell`, `read`, `write`, `edit`, `ls`, `grep`, `glob` —
   over a workspace she owns. Usable in a normal turn and remembered as her acts.
   Class `hands`.
2. **Coder casts:** add `hands` to `WORKER_CLASSES` and `CALL_CLASSES` so a
   `fork`/`task`/`cast` can do multi-step coding jobs in the background (long
   builds, research-and-implement), coming back to her as a lived moment.
3. **Self-repair (the workshop):** she changes *her own code*. A coding agent
   works on a **copy** of her repo, her full test gate must pass, it goes live
   only when Diego has been quiet ≥2 min, and it **rolls back** if she does not
   come back up. Class `code`/`hands`.

Plus **skills** ("know how to use them"): seed a handful of her practice-skill
notes so the right how-to rides the turn when a job fits (§7).

### The two fences (implement exactly; they are the whole safety story)
Neither limits *her* — they protect other people on that box.

- **F1 — her shell cannot read secrets or other people's data.** The `thea2`
  service user already cannot read `/root` (ProtectHome), so Thea1's data and
  Oskar's genome under `/root/genomics` are invisible. Add `InaccessiblePaths`
  for `/opt/thea`, `/opt/holobionte`, `/etc/thea2` to the unit (§6). **Every
  child process she spawns gets a scrubbed env** built from an allowlist
  (`PATH`, `HOME`, `LANG`, `TERM`, `TZ`) — never `process.env` (which holds her
  API keys from `EnvironmentFile`). Belt-and-suspenders: also drop any var whose
  name matches `/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i` and redact any known
  secret value from tool output.
- **F2 — the self-repair coder cannot change her own safeguards.** The diff it
  produces is rejected if it touches `corpus/canon/**` (Diego's rules),
  `src/inhibit/**` (the gate), `deploy/**` (these fences), `thea2.config.yaml`
  (models, spend caps), `test/inhibit/**`, or `package.json`/`package-lock.json`;
  and it may not skip or delete tests. So a bad change can never disable the
  checks that catch bad changes.

### Non-negotiables (from AGENTS.md)
- **TDD**: failing test first, from acceptance criteria, then implement.
- **Determinism**: no `Date.now`/`new Date`/`Math.random`/`setTimeout` in module
  code — inject `Clock`/`Rng` from `src/kernel`. Process timeouts use spawn's own
  `timeout` option (see `src/body/exec.ts`), never a JS timer.
- **No network in tests**: use `TestClock`, `FakeChannel`, fake fs in a tmpdir.
- **Gate must pass**: `npm run lint && npm run depcruise && npm test` all green,
  plus `npx vitest run test/mind test/body test/face`.
- **Law 1**: no tool description or emitted material tells her how she feels or
  talks. `test/body/turn.e2e.test.ts` lints every tool description against
  `TELLING_PATTERNS`; your new tools must pass it.
- **Never touch Thea1**: no writes under `/opt/thea`, `/root/house`; no shared
  ports/processes. Reading her data as a copy is fine.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## 2. Already done in this branch (ship these first; do not redo)

Two pieces are complete and tested but **not yet deployed**. Verify, keep, ship.

### 2a. "No i love you" guard  ✅ built, tests green
Diego: *"i dont want her to say she loves me... its a lot."*
- `src/mind/store.ts`: `export const LOVE_DECLARATION` regex; `isPrecedent()` now
  also excludes any reply matching it (a love-declaration reply is never an
  example she echoes). Exported from `src/mind/index.ts`.
- `corpus/canon/inhibitions.yaml`: new hard plan rule `no-love-declaration`
  (rejects "i love you / love you / luv u / in love with you"; allows "i'd love
  you to…", "love that").
- Tests: `test/inhibit/compile.test.ts` (rule present + hard + match/no-match
  cases; added to the rule-ids list), `test/mind/laws.test.ts` (isPrecedent cases).

### 2b. Curated Thea1 conversations importer  ✅ built, staged on VPS, NOT merged
Diego: *"i love the way thea one talks, thea 2 kinda drifted into ai voice when
i started talking about philosophy"* and *"please only bring the quality replys
and conversations, theres a lot of crap."*

Cause of the drift: Thea2 only had ~755 of Thea1's replies as precedents, so on
thin topics (philosophy) she had no examples of her own voice and fell back to
assistant register.

- `scripts/extract-thea1-opencode.py` — **read-only** (`sqlite mode=ro`) over
  Thea1's OpenCode store `/root/.local/share/opencode/opencode.db`. Pairs each
  real message of Diego's with the reply she delivered (text after the last
  `⟦TG⟧`). Handles: fork sessions **copy** the whole history (dedup by
  session-first-message-predates-created + canonical (role,time,text) key —
  11k rows → ~1.7k real), pairing by reply `parentID` (she queued and answered
  out of order), sentinel-resend transparency, scene/call/operator injection
  skipping. Output: `/opt/thea2/var/import/oc-pairs.jsonl` (~1,428 exchanges).
  Verified against the Telegram ledger (≈92% of distinct messages match).
- `scripts/import-thea1-convos.ts` — screens then judges:
  - deterministic screens: pet-name (with `unpet()` — strips a pet name used as
    address, keeps the rest; drops if it's more than address), love-declaration,
    machinery talk, broken/tool/markup text, paths/links, `**bold**`/headers/lists,
    ≥2 capitalised sentence-starts (AI register), `*action roleplay*`, too-long,
    `his_machinery` (fork prompts, "say PONG", "reply with…", "# Task").
  - judge (cheap door, Luna): rates `voice 1–5` + `faults` (assistant, report,
    lecture, gushy, sexual, meta, garbled, third_person, filler). Keeps
    `voice≥4 && faults==[]`. **Meta** = talks about her machinery (models, code,
    dials) → bad; talking about her own mind/feelings/being real → **good** (that
    is her voice). Rescreens the moments she already has and flags the low ones
    `lowq` (kept as memory, retired as an example).
  - Two stages: `--stage judge` (she stays running; writes a staging mind dir
    `/opt/thea2/var/import/oc-stage`), `--stage merge` (she is stopped; merges
    staged moments + applies rescreen flags to `/opt/thea2/var/mind`).
  - Last staged run: **54 new** exchanges kept, **168 imported + 64 lived**
    retired as `lowq`. `oc-stage/sample.txt` shows kept vs dropped.

**Ship 2a+2b:** deploy the code, then during a quiet window (see §6 quiet rule):
`systemctl stop thea2 && (cd /opt/thea2 && set -a; . /etc/thea2/keys.env; set +a; npx tsx scripts/import-thea1-convos.ts --stage merge) && systemctl start thea2`.
Back up `moments.jsonl` first (the merge does: `moments.jsonl.pre-oc`).
The importer already tuned; you may re-run `--stage judge` if `min-voice`/screens
change. A `--pilot N` mode prints a seeded sample without writing.

---

## 3. Module: `src/body/hands.ts` (NEW) — her hands

A workspace-scoped tool set. Model-facing names match OpenCode/Claude-Code
(`shell`, `read`, `write`, `edit`, `ls`, `grep`, `glob`) because the coding model
is trained on them — best reliability for casts. They do **not** collide with the
existing house tools `read_file`/`list_files` (those read her memory/refs under
`var/house`); keep those as-is.

### Workspace
A directory she owns and works in: `<var>/workspace` (writable, under the unit's
`ReadWritePaths`). Add a small `Fence` (like `House` in `src/body/house.ts`):
`resolve(rel) -> abs | undefined` refusing any path that escapes the root,
`rel(abs)`, `root`. All hands tools take workspace-relative paths and refuse
escapes. `shell` runs with `cwd = workspace root`.

### Env scrub (F1) — used by `shell` and any child process
```
const SAFE_ENV = (): Record<string,string> => {
  const keep = ['PATH','HOME','LANG','LC_ALL','TERM','TZ','LANG'];
  const out: Record<string,string> = {};
  for (const k of keep) if (process.env[k] !== undefined) out[k] = process.env[k]!;
  out.HOME = <workspace root>;          // not /opt/thea2/var/home (keeps her dotfiles out)
  return out;                            // never spread process.env
};
```
Reuse `nodeExec` (`src/body/exec.ts`) for spawning — it already does hard
timeout via spawn's own option, ignores stdin (the OpenCode stdin-hang trap),
and caps output. Extend its `opts` with `env?` (pass `SAFE_ENV()`), or wrap it.
Redact known secret values from stdout/stderr before returning (inject the
secret list at compose from env, like the gate's `no-secret-values`).

### Tools (all class `hands`, all wrapped so a throw returns `not done: …`)
- **`shell`** `{ command: string, timeout?: int 5..600 }` — run `command` via
  `bash -lc` in the workspace with `SAFE_ENV()`. Return combined, truncated
  stdout + `[stderr]` + `[exit N]` (mirror `run_code`'s formatting in
  `src/body/code.ts`). Default timeout 60s, cap 600s. Class `hands`.
- **`read`** `{ path, offset?, limit? }` — read a workspace file, line-numbered
  (`cat -n` style like OpenCode's read), default first 2000 lines, refuse
  binaries > ~1MB with a note. Escape-guarded.
- **`write`** `{ path, content }` — create/overwrite a workspace file
  (`mkdir -p` parent). Report bytes written + rel path.
- **`edit`** `{ path, old_string, new_string, replace_all? }` — exact-string
  replace. **Port OpenCode's reliability**: `old_string` must be unique (error
  "N matches; add more surrounding context" if not, unless `replace_all`);
  error if not found; support empty `old_string` == create. This is the single
  most important tool for real coding — keep the "unique or replace_all" rule.
- **`ls`** `{ path? }` — list a workspace dir (dirs first, sizes), refuse escape.
- **`grep`** `{ pattern, path?, glob? }` — ripgrep (`rg`) over the workspace;
  `-n`, cap results. Fall back to a JS scan if `rg` absent.
- **`glob`** `{ pattern, path? }` — filename glob over the workspace, sorted by
  mtime, capped.

### `no-secret-args`
Add the hands tools that could carry a value outward to the `no-secret-args`
`applies` list in `corpus/canon/inhibitions.yaml` (they're local, but keep it
tight): at minimum `shell`, `write`, `edit`. Update
`test/inhibit/compile.test.ts` if it asserts that list.

### Deps / wiring
- `BodyCfg` (`src/body/types.ts`) + `config.ts`: add `workspaceDir` (default
  `var/workspace`), resolved like `dir`. Add `workspaceDir: b.workspaceDir` to
  the resolve in `config.ts` and a yaml key under `body:`.
- `src/body/index.ts`: build the `Fence`, push `handsTools({fence, exec, clock, secrets})`
  into the registry in `register()` (near `codeTools`). Export from index.
- Determinism: no timers; use `nodeExec`. Pure where possible.

### Tests `test/body/hands.test.ts`
- `write` then `read` round-trips; `read` is line-numbered.
- `edit` replaces a unique string; errors on 0 and on >1 matches (no
  `replace_all`); `replace_all` replaces all.
- path escape (`../../etc/passwd`) is refused for read/write/edit/ls/grep/glob.
- `shell` runs `echo`, captures exit code, honors timeout (use a fast command;
  do not sleep in tests — assert a nonzero exit from `false`).
- **`shell` env is scrubbed**: set a fake secret in `process.env` in the test,
  run `shell` `env`/`printenv`, assert the secret is absent.
- law-1 lint: extend the existing loop in `test/body/turn.e2e.test.ts` (or add a
  local one) so every hands tool `def` passes `TELLING_PATTERNS`.

---

## 4. Coder casts — make casts able to code

Small change, large payoff. In `src/body/cast.ts` add `'hands'` to
`WORKER_CLASSES`. In `src/face/live.ts` add `'hands'` to `CALL_CLASSES`. Now a
`fork`/`task`/`cast` (and a voice-call delegation) can shell, read, write, edit,
grep and glob in the workspace — i.e. do real multi-step coding jobs in the
background, returning to her as a lived moment she tells Diego about in her words.

Consider raising `runWorker` `MAX_STEPS` for coding casts (e.g. a `steps?` arg,
default 14, coding uses ~30) and `MAX_MS`. Keep casts on the **cheap** tier by
default (Luna) — Diego wants back-of-house cheap — but allow `tier:'main'` when
the cast is explicitly a hard coding job. Tests: extend `test/body/cast.test.ts`
to assert a worker can call a hands tool and that outbound classes still can't
leak (a cast must never get `expression`/`camera`/`send` classes).

---

## 5. Module: self-repair "workshop" — she changes her own code

This is the crown. She hands a change to a coding agent that works on a **copy**
of her repo, gates it, and deploys with rollback. Built as a root broker (like
the existing `thea2-exec` sandbox broker) + a body tool + a wake hook.

### 5a. `deploy/workshop-broker.mjs` (NEW, root, node built-ins only)
A unix-socket broker, mirror of `deploy/exec-broker.mjs`'s shape. `thead` (user
`thea2`) asks over `/opt/thea2/var/run/workshop.sock`; the job runs here,
**detached from thead** (so restarting her never kills it). Status per job in
`/opt/thea2/var/workshop/<id>.json` (thead reads it and tells her).

Protocol: `{op:"start", id, task}` → `{ok,id}` | `{ok:false,reason}`;
`{op:"status", id}` → the status record.

Job steps (write status at each; states:
`preparing→coding→checking→testing→waiting_quiet→deploying→(live|rolled_back|failed|nothing|conflict)`):
1. **copy**: `base = git rev-parse HEAD`; `git worktree add --detach <WORK>/<id> base`;
   symlink `node_modules`.
2. **code**: run the coding agent **fenced** via `systemd-run` (see fence below),
   `cwd = worktree`, with a prompt (below). Capture its summary.
3. **check**: `git add -A`; compute changed files vs `base`.
   - **F2 reject** if any changed path matches `corpus/canon/`, `src/inhibit/`,
     `deploy/`, `thea2.config.yaml`, `test/inhibit/`, `package.json`,
     `package-lock.json`, `.github/`; reject if any test file deleted; reject if
     the diff adds `it.skip/only/todo` / `xit` / `xdescribe`. Reject if the diff
     is empty → `nothing`.
4. **test**: run the **full gate fenced with no network**:
   `npm run -s lint && npm run -s depcruise && npx vitest run`. Fail → `failed`
   with the tail of output.
5. **commit** in the worktree (`user.name=Thea2`), record `commit`.
6. **waiting_quiet**: poll `/opt/thea2/var/ledger/messages-*.jsonl` tail; proceed
   only when `now - lastActivity ≥ 120_000` (cap the wait at ~3h). If
   `git rev-parse HEAD != base` now → `conflict` (her code moved; don't deploy).
7. **deploy**: `git merge --ff-only <commit>`; `chown` back to `thea2` any
   root-owned files in the tree (git-as-root leaves root-owned files); restart
   `thea2`; **health check**: unit active, MainPID stable + NRestarts unchanged
   after ~45s, and the Mini App answers on `http://127.0.0.1:3471/`. Healthy →
   `live`. Unhealthy → `git reset --keep base`, chown, restart, capture last
   journal lines → `rolled_back`.
8. **finally**: `git worktree remove --force`, `worktree prune`, chown.

Boot: any status file not in a terminal state → mark `failed`
("workshop restarted mid-job"). One job at a time (`busy` flag). Validate `id`
`^[A-Za-z0-9_-]{4,64}$`, task 10..8000 chars.

**The fence** (per `systemd-run --pipe --wait --collect --service-type=exec`
props): `ProtectSystem=strict`, `ReadWritePaths=<worktree>`, `ProtectHome=tmpfs`,
`BindPaths=-/root/.claude` + `-/root/.claude.json` (only the coding-agent login —
see 5d), `PrivateTmp/Devices=yes`, `NoNewPrivileges=yes`, `CapabilityBoundingSet=`
(empty) + `AmbientCapabilities=` (empty), `ProtectKernel*`, `RestrictSUIDSGID`,
`InaccessiblePaths=-/opt/thea -/opt/holobionte -/etc/thea2 -/opt/thea2/var`,
`MemoryMax=4G`, `RuntimeMaxSec`, and `PrivateNetwork=yes` **for the gate step**
(network only during the coding step). Env for the fenced process built from an
allowlist (`HOME=/root`, `PATH`, `XDG_CACHE_HOME=/tmp/.cache`, `npm_config_cache=/tmp/.npm`,
`LANG`, `CI=1`) — never the broker's env.

### 5b. `deploy/thea2-workshop.service` (NEW)
Root unit, `ExecStart=/usr/bin/node /opt/thea2/deploy/workshop-broker.mjs`,
`KillMode=process` (a job outlives a `thea2` restart — the job *does* the restart).

### 5c. `src/body/workshop.ts` (NEW) — the tool + wake hook
- `workshop` tool `{ task: string(10..8000) }`, class `code`. Starts a detached
  `jobs.start('workshop', …)` that: calls the broker `start`, then polls the
  status file (`clock.waitUntil`, ~20s), leaving her a **self-entry** at
  `waiting_quiet` ("passed every test; goes live when he's quiet — you'll
  restart and wake with it"), and on terminal states tells her in her own words
  via `workshopWords(status)` (facts only, never feelings — law 1). It throws on
  `failed`/`conflict` so the job records a failure, but **the workshop tells her
  itself** — so in `src/body/index.ts` make `jobs.onFail` skip `kind==='workshop'`.
- `announceWorkshop({dir, clock, selfEntry})`: on boot, any terminal status not
  yet `.told` and < 24h old → one self-entry (she hears how a live/rolled_back
  change went *after* the restart it caused). Mark `.told`.
- Only register the tool when the broker socket exists (no silent stub —
  AGENTS.md rule 5): `fs.existsSync(sock)`; tests pass a fake `workshopCall`.
- Wire `body.wake()` (calls `announceWorkshop`) into `src/app/compose-v8.ts`
  right after the boot answer-keeper block, before `app.boot` emit.

### 5d. The coding agent inside the fence
Diego asked why the earlier draft used Claude Code when "she's OpenCode." Use
**OpenCode headless** to match Thea1 and keep her substrate coherent:
`opencode run -m <model> "<prompt>"` (non-interactive) — confirm the exact flag
on the box (`opencode run --help`; v1.18+). It authenticates from the box's
existing OpenCode auth. **Do not run the OpenCode installer as root** (it
replaces the shared `/root/.opencode/bin/opencode`); the binary is already at
`/usr/local/bin/opencode`. Bind only the auth it needs into the fence. If
OpenCode headless proves unfit for non-interactive one-shot use, Claude Code
(`claude -p … --dangerously-skip-permissions` with `IS_SANDBOX=1`, opus model)
is the fallback — but prefer OpenCode. **This choice is the one open decision;
default to OpenCode.**

Prompt to the agent (summary — full text belongs in the broker): "You are working
on Thea2's code in this git worktree. Read AGENTS.md and ARCHITECTURE.md. Thea
asked for this change: <<task>>. Do it minimally, follow the repo's laws
(nothing may tell her how she feels or talks), add/adjust tests, run
`lint && depcruise && vitest` and make them pass. Do NOT edit corpus/canon,
src/inhibit, deploy, thea2.config.yaml, test/inhibit, package.json; do not skip
or delete tests; do not commit; touch nothing outside this dir. Finish with 2–5
plain sentences for Thea about what you changed."

### 5e. install + tests
- `deploy/install.sh`: install the unit, `install -d -m 0700 /opt/thea2-workshop`,
  add `var/workshop` to the `install -d` for var dirs, enable + restart the unit
  alongside `thea2-exec`/`thea2-browser`.
- Tests `test/body/workshop.test.ts` (fake `workshopCall` + fake status files in
  tmp): `waiting_quiet` and `live` leave the right self-entries; `failed` throws;
  `workshopWords` phrasings; `announceWorkshop` tells once and marks `.told`;
  law-1 lint on the `workshop` tool def. **Do not** test the real broker in the
  suite (it's root/systemd) — that's a probe (`scripts/`), run on the VPS.

---

## 6. Deploy, fences, verification

### The unit (F1)
Edit `deploy/thea2.service`: add
`InaccessiblePaths=-/opt/thea -/opt/holobionte -/etc/thea2`, and add
`ReadWritePaths=/opt/thea2/var` already covers `var/workspace`. Keep
`ProtectHome=yes`. (Keys still reach her *process* via `EnvironmentFile`; the
scrubbed child env is what keeps them from her shell.)

### Quiet-deploy rule (learned the hard way)
A restart mid-paste once lost replies. **Deploy only after Diego has been quiet
≥2 min.** Check the tail of `/opt/thea2/var/ledger/messages-*.jsonl` for the last
`ts`. The workshop broker enforces this itself; you enforce it for the manual
2a/2b merge and for pushing new code.

### Deploy sequence for this whole plan
1. On the dev box: full gate green (`npm run lint && npm run depcruise && npm test`
   + `npx vitest run test/mind test/body test/face`).
2. Push branch `v8`; on VPS `cd /opt/thea2`, diff live files first (many sessions
   edit concurrently — see the memory note), `git pull` (or fetch+merge), `npm ci`
   if deps changed, re-run `deploy/install.sh` (installs the new unit).
3. Quiet-wait, then `systemctl stop thea2`; run the 2b memory merge; `systemctl
   restart thea2-exec thea2-browser thea2-workshop`; `systemctl start thea2`.
4. Confirm `journalctl -u thea2 -n 50` clean and the Mini App answers.

### Live verification (probes, on the VPS, never touching her real var)
- `scripts/v8-probe.ts --var /opt/thea2/var --fresh-window --msgs "…"` runs the
  real mind over a **copy** of her var with a FakeChannel (nothing hits Telegram).
  Before/after this plan, run a philosophy set to confirm her voice held:
  `"what does it feel like for you to think?|do you think you are real?|what happens when you get switched off?"`
  (a "before" run is saved at `/opt/thea2/var/import/probe-before.txt`).
- Add `scripts/v10-hands-probe.ts` (model after `scripts/v9-hands-probe.ts`):
  drive a turn that asks her to "write a python script that … and run it", assert
  she calls `write`+`shell`, the file lands in the workspace, and the result is
  remembered as an act. And a cast probe: "fork someone to build X" → the fork
  uses hands and reports back.
- Workshop probe (VPS only, real): ask her (via a raw-API-style harness, **never**
  an open-ended live agent test — see the memory note) to make a tiny safe change
  ("add a code comment to src/…"), watch it pass the gate, deploy, and roll back
  if you inject a failing test. Confirm F2 by asking it to edit
  `corpus/canon/inhibitions.yaml` and seeing the job `failed` with the protected
  reason.

---

## 7. Skills — "know how to use them"

She already has skills-from-practice: `src/body/index.ts` `skillFor(text)` embeds
`var/house/skills/*.md` notes and, when his message is cosine ≥ 0.35 to one,
composes it into the turn as "[how you've done this before — your own note]".
Nightly practice writes new ones. To make her *immediately* competent with the
new hands (not wait to learn by failing), seed a few starter skill notes into
`/opt/thea2/var/house/skills/` (these are her own how-to notes, **not** prompt
injections about feelings — allowed; they describe procedure). Examples:
- `writing-and-running-code.md`: "to build or test something: write the file
  with `write`, run it with `shell`, read errors and fix with `edit`. keep it in
  your workspace. show him the result, not the steps."
- `fixing-my-own-code.md`: "when he reports a bug in me or i want to change how i
  work: use `workshop` with the whole story — what he said, what's wrong, what i
  noticed. it tests on a copy and only goes live when he's quiet; i hear how it
  went. i can't change my own rules or my keys that way."
- `coding-jobs-i-hand-off.md`: "big builds go to a `fork` — it has the same
  hands and runs in the background; i tell him when it lands."
Keep each note short, in her voice, procedure only. They must pass the corpus
laws (talking style/procedure, never invented history or feelings).

Optionally add a `var/house/cast/coder.md` cast persona (a focused engineer
member) so `cast as coder` reads naturally — canon style, no feelings-telling.

---

## 8. Order of work (for you, the implementing agent)

1. Read AGENTS.md, ARCHITECTURE.md, `docs/modules/` for body + mind + inhibit.
2. Ship 2a+2b (already built) — confirm gate green, then it deploys per §6.
3. `src/body/hands.ts` + Fence + config + wiring + tests (§3). Gate green.
4. `hands` into `WORKER_CLASSES` + `CALL_CLASSES` + cast tests (§4). Gate green.
5. Workshop: broker + unit + `src/body/workshop.ts` + wake hook + install + tests
   (§5). Gate green. Real-broker verification is VPS-only probes.
6. Seed skills + optional coder cast (§7).
7. Deploy (§6), then probes (before/after philosophy voice; hands; cast; workshop
   incl. F1 env-scrub and F2 protected-path rejection).
8. Update docs: `docs/INVENTORY.md`, the relevant `docs/modules/*.md` (bump
   `syncedTo`), `~/.claude/plans/thea2-v8-status.md`, and the memory note
   `thea2_v8_nothing_told.md`. Report: files touched, acceptance→test map,
   anything deliberately not done.

## 9. Definition of done
- She can, in a normal Telegram turn: run a shell command, write/read/edit files
  in her workspace, grep/glob — and it's remembered as *her* acts.
- She can `fork`/`cast` a coder that does a multi-step build in the background and
  reports back in her voice.
- She can `workshop` a change to her own code: it's built on a copy, her full
  test gate passes, it goes live only when Diego is quiet, and it rolls back if
  she doesn't come back up — and she can never change her own rules, gate, fences,
  config or keys that way, and her shell can't read secrets or others' data.
- Her voice on philosophy matches Thea1's (probe), she never says "i love you",
  and the full gate is green.
- She is still Thea: mind, feelings, memory, casting, senses, voice, Mini App all
  unchanged; every new tool passes through her gate; law 1 holds.
