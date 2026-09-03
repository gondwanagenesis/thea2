---
title: Thea2 — Documentation Truth Inventory (P-DOCS DC.1, W1)
date: 2026-09-03
audience: the M.5 docs landing agent; the main agent (reviewer)
scope: every doc claim that names a count, a job, a file path, a constant, a backend, a model, a stage, or a capability
---

# Documentation truth inventory

Every claim below was checked against the CODE (grep/read of `src/`, `test/`,
`corpus/`, `deploy/`, `probes/`, `.dependency-cruiser.cjs`, `thea2.config.yaml`,
`package.json`, `.github/workflows/ci.yml`), never against other docs. This is
a **point-in-time audit** (2026-09-03, tree @ `b82f7a5` + in-flight W1 work:
P-DOOR had already landed `models.doors` in `thea2.config.yaml` and updated
`docs/modules/M03-model.md`; counts move per commit — the live numbers are
always `npm run docs:check`).

Verdicts:

- **verified in code at file:line** — the doc is right; evidence given.
- **false** — contradicted by code as it exists now. Correction given.
- **future (plan item id)** — describes planned behavior, stated or readable as
  current. Plan of record is **v7** (`thea2-v7-opencode-spine.md`); W1 items
  are v6 §3 specs carried unchanged by v7 PART 4.
- **unverifiable** — no artifact in this repo can prove or refute it (Thea1
  mirror, measurement corpora, live-VPS state). Never guessed.

## Summary

| Verdict | Rows |
|---|---|
| verified in code | 93 |
| false | 61 |
| future (plan) | 3 |
| unverifiable | 10 |
| **total** | **167** |

The 61 false rows are the M.5 work list; the 13 most damaging are marked
**DAMAGE-HIGH** (they misstate what she is or what runs today: backend, tools,
probes, test counts, derived-corpus law, the schemas contract).

---

## README.md

| doc:line | claim | verdict | correction / evidence |
|---|---|---|---|
| README:20 | "Status (2026-09-02): built and live. All twenty modules (S0–S8) landed" | false (date) | Module count verified (20 keys, `.dependency-cruiser.cjs:15-43`); S0–S8 landed per ROADMAP markers. But the status date is stale: deployed code is 2026-09-03 (`b82f7a5`, ws-E §5). |
| README:22-23 | "1,656 hermetic tests green across 111 files" | **false — DAMAGE-HIGH** | `npx vitest list` = 1695 tests; 131 `.test.ts` files (2026-09-03). Was already 1657/125 at ws-E. Now generated: `gen:tests-count` block below this line. |
| README:23 | "five CI gates (typecheck, lint, test, depcruise, schema-verify)" | verified in code at `package.json:23` (`gates` = typecheck+lint+depcruise+verify) + `.github/workflows/ci.yml` (gates job; test runs as chunks test-a/test-b) | Accurate. |
| README:24 | "Running on GLM-5.3-flash (z.ai, Anthropic-compat door, SSE streaming)" | **false — DAMAGE-HIGH** | `thea2.config.yaml:11-43`: doors — voice = Neuralwatt `glm-5.3` (openai wire, effort low, D.6-1), voiceFallback = z.ai `glm-5.3-flash` (anthropic), mind = `deepseek-v4-flash`, judge = `kimi-k3`. Now generated: `gen:doors` block. |
| README:26 | "Elena's 7,476 messages and Diego's 12,533" | unverifiable | The measured WhatsApp corpus is not in the repo (Thea1 backup only). No code reads these numbers. |
| README:60 | "deliberation loop ── model thinks, may call tools (web, memory, spawns)" | **false — DAMAGE-HIGH** | No I/O tools exist: `src/app/compose.ts:216` — `createToolRegistry(); // v1: no I/O tools registered`. Only spawn primitives fork/task/committee (`src/loop/turn.ts:493-537`), and post-FA.3 only on non-user-turn entries. No `web_*`/`memory_search` anywhere in `src/`. |
| README:73 | "heartbeat every ~30 min" | verified in code at `src/life/config.ts:53` (`heartbeatEveryMs: 30 * MIN`) | — |
| README:74 | "ponder every ~20 min" | verified in code at `src/life/config.ts:54` | — |
| README:74-75 | "nightly consolidation promoting lived experience into her corpus" | false (two halves) | Reflect job registered (`src/app/compose.ts:489`, nightly 03:00 UTC `src/life/config.ts:56`) and runs the consolidators (`compose.ts:454-458`) — but outputs go to `var/lived/`, NOT `corpus/` (`compose.ts:392`, M10 round 2), and the loop has never proven `ok` live (var/lived empty at ws-E §2.3). |
| README:75-76 | "Nightingale — the behavioral probe suite that guards her character against drift" | **false — DAMAGE-HIGH** | Nightingale is not registered: `src/app/compose.ts:470-473` installs a `probes/not-built` refusal as the ProbeRunner; `thea2 probe` is a not-built verb (`src/app/cli.ts:25`). 3 probe files exist (`probes/*.probe.yaml`); nothing runs them. Future: v7 W4 P-PROBES. |
| README:85 | "src/ 20 modules … dependency-cruiser enforces the DAG" | verified in code at `.dependency-cruiser.cjs` (20 module rules) + `npm run depcruise` in gates | — |
| README:91 | "docs/decisions/ (9 ADRs — locked decisions and reasoning)" | false | 11 ADR files: ADR-001…009 + 004a + ADR-010-doors (`ls docs/decisions/`; ADR-010 added by P-DOOR). |
| README:92 | "docs/modules/ (M01–M20 specs)" | verified in code at `ls docs/modules/` (20 files) | Will drift when v7 M21–M23 (spine) specs land. |
| README:98 | "canon/ (hand-written scenes, 8 dimensions)" | verified in code at `ls corpus/canon/` (8 dimension dirs) | — |
| README:104 | "test/ 125 files, 1,656 tests" | false | 131 files / (static) 1441 declarations now; contradicts README:22's own numbers too. Covered by the `gen:tests-count` block. |
| README:106-107 | "probes/ … what Nightingale grades live after every change" | false | Nothing grades live: Nightingale unregistered (`compose.ts:470-473`), probe verb not built (`cli.ts:25`). Future: v7 W4 P-PROBES. |
| README:122 | "Production is one process (thead) and a backup timer" | verified in code at `deploy/thea2.service` + `deploy/thea2-backup.timer` | — |
| README:124 | "config file rejects anything secret-shaped at startup" | verified in code at `src/app/config.ts:102-109` (`secretShaped`, `app/config-secret-in-yaml`) | — |
| README:142 | "the plan this repo was built from is locked in docs/decisions/; the ADRs are not suggestions" | false (pointer) | The plan of record is the v7 plan file, which no repo doc references (grep `thea2-v[5-7]\|P-CAST\|P-SPINE` over all .md = 0 hits). Future: v7 DC.5 plan-integration at M.5. |

## ARCHITECTURE.md

| doc:line | claim | verdict | correction / evidence |
|---|---|---|---|
| ARCH:3 | header "1,502 tests, five gates green; live on VPS" | false | 1695 tests / 131 files (vitest list, 2026-09-03). `gen:tests-count` block now carries live numbers. Five gates: verified (`package.json:23`). |
| ARCH:17 | "Two systemd units: thea2.service and thea2-backup.timer" | verified in code at `deploy/` (thea2.service, thea2-backup.service, thea2-backup.timer) | — |
| ARCH:19-41 | module table M01–M20 one-liners | verified in code at `ls src/` (20 dirs) + `.dependency-cruiser.cjs` | Spot-checked M04/M13/M16/M18/M20 rows against src. |
| ARCH:28 | M04 "hash (prod today) / fastembed bge-small (S9)" | verified in code at `thea2.config.yaml:77` (`kind: hash`) + `src/app/embedder.ts:35` (fastembed = `app/not-built` refusal) | — |
| ARCH:57-67 | quota table: disposition 1 (canon only, ADR-006), pattern 2, episode/memory 2–3, contrast 1 | verified in code at `src/assemble/types.ts:192` (quotas) + `src/corpus/nominator.ts:206-210` (`tierFor`: disposition = canon statements or `disposition: true` canon files) | — |
| ARCH:76 | "Procedural channel: 0–2 … from the ProceduralStore" | verified in code at `src/assemble/types.ts:192` (`proceduralMax: 2`) + `src/memory/procedural.ts` | Note: canon `kind: procedure` files never reach packets (`src/corpus/nominator.ts:204` `CORPUS_KINDS = scene|statement`) — the channel currently fills only from `var/lived` (empty). Future: v6 W2 P-KEEL (carried v7). |
| ARCH:80-92 | render order `[IDENTITY][GOAL][INTERLOCUTOR][MEMORY][AFFECT][REGISTER][EXEMPLARS]` + `[PROCEDURAL]` beside tool defs + `[INHIBITION]` trailing | verified in code at `src/assemble/render.ts:2,72-100` | No `[NOW]`/`[WHERE]`/`[RECENT]` blocks exist yet — future: v6 W1 P-TIME / P-ECHO (carried v7). When they land, this render order must be regenerated. |
| ARCH:94 | "λ = 0.25, credit weight γ = 0.15" | verified in code at `coupling.yaml:24` + `src/assemble/score.ts:27` (`CREDIT_GAMMA = 0.15`) | — |
| ARCH:94 | "signature spread ≤ 1.2 per dim" | verified in code at `src/assemble/types.ts:204` (`spreadMax: 1.2`) | — |
| ARCH:100 | budgets "packet ≤ 6k (identity 150 · goal 100 · interlocutor 150 · memory 600 · affect 30 · register 10 · exemplars ≤ 4k · inhibition 300)" | partially false | packet 6000 / memory 600 / exemplars 4000 verified (`thea2.config.yaml:63-66`, `src/assemble/budget.ts:7-13`). The per-section numbers for identity/goal/interlocutor/affect/register/inhibition are **not enforced anywhere in code** — budget.ts passes caller-owned sections verbatim. Correction: mark them as targets, not enforced budgets. |
| ARCH:101 | "rolling window ≤ 10k (min(last 30 msgs, 10k tok)) … 4h silence = session break" | verified in code at `src/memory/window.ts:29-33` (`WINDOW_MAX_MESSAGES 30`, `WINDOW_MAX_TOKENS 10_000`, `SESSION_BREAK_MS 4 * HOURS`) | — |
| ARCH:102 | "current turn + tool observations ≤ 6k" | verified in code at `src/loop/config.ts:81` (`turnTokenBudget: 6000`) | — |
| ARCH:103 | "response reserve 2k" | false | `src/loop/config.ts:78` — `assessMaxTokens: 3072` with the comment "3072, not 2048". Raised for GLM thinking starvation (M03 as-built). |
| ARCH:105 | "Every canon body ≤ 500 tokens hard / 350 warn" | verified in code at `src/corpus/body.ts:17-18` (`BODY_TOKEN_HARD_CAP 500`, `BODY_TOKEN_WARN 350`) | — |
| ARCH:111 | "register (work/friend/play) inference" | verified in code at `src/app/register.ts` (cue tables + local-hour modifier), called for user-turns | — |
| ARCH:119 | decision object fields `{plan, bubbles, confidence, weight, reluctance, completeness, toolTrace, spawns, inhibitions}` | verified in code at `src/loop/decide.ts` (`OUTPUT_CONTRACT`/`decideToolDef`) | — |
| ARCH:119 | "Thea1 voice committee's gear classifier (17/17 fixtures)" | unverifiable | Thea1 artifact; nothing in this repo records the 17 fixtures. |
| ARCH:123 | "Z.ai GLM over the anthropic-compat door … main = glm-5.3-flash, cheap = glm-5.3-flash, reasoning = glm-5.3" | **false — DAMAGE-HIGH** | Superseded by the door registry (`thea2.config.yaml:11-43`, ADR-010): voice = Neuralwatt glm-5.3; mind = deepseek-v4-flash; judge = kimi-k3; z.ai = voiceFallback. `gen:doors` block now carries the live table. The thinking-starvation trap paragraph remains true (`src/model/wire.ts` effort mapping). |
| ARCH:125 | spawn primitives fork/task/committee, depth ≤ 2, concurrency ≤ 3 | verified in code at `src/loop/turn.ts:493-537` + `src/loop/config.ts:76-77` (`maxSpawnDepth: 2`, `maxSpawnConcurrency: 3`) | — |
| ARCH:143-151 | job table (6 registered + derive-check not registered + Nightingale not registered) | verified in code at `src/app/compose.ts:486-493` (six `*Job` entries), `compose.ts:470-473` (probe refusal), cadences `src/life/config.ts:53-56`, `src/app/maintenance-jobs.ts:27,29`, `src/siblings/types.ts:123` | Naming nit: the registered job's name is `ledger-report` (`src/siblings/types.ts:119`), the table says "ledger". No drift — see ws-E #16. Now also generated as `gen:job-table`. |
| ARCH:153 | "skip if inbound < 10 min ago or a turn is in flight" | verified in code at `src/app/compose.ts:363` (`CONVERSATION_QUIET_MS = 10 * 60_000`) + `src/sched/scheduler.ts:303` | — |
| ARCH:153 | "3 consecutive failures → alarm" | verified in code at `src/sched/scheduler.ts:13,98` (`sched.alarm`) | — |
| ARCH:173-183 | data stores table (events/, affect/state.json, memory/episodes.jsonl+embeddings.bin, procedural.jsonl, ledger/, sched/state.json, reports/+routing.json, journal.md+threads.json) | verified in code with one gap | All writers match `src/app/compose.ts` + module code. Gap: the durable thread fold `var/memory/threads.jsonl` (M09 round 2, `src/memory/threads.ts`) and `var/credit/weights.json` (M10) are missing from the table. |
| ARCH:192 | "Voice drift → Nightingale drift gate (cosine drop > 0.05 = yellow)" | false (as built) / future (v7 W4 P-PROBES) | The gate numbers are implemented (`src/probes/baseline.ts`, thresholds pinned in tests) but Nightingale never runs (`compose.ts:470-473`). |
| ARCH:200 | "Embedder in prod is the hash embedder until S9 (fastembed)" | verified in code at `thea2.config.yaml:72-78` + `src/app/embedder.ts:34-35` | Doc says "S9"; the plan of record moved the real embedder to v7 W2 P-EMBED (E.1/E.5). |

## THESIS.md

| doc:line | claim | verdict | correction / evidence |
|---|---|---|---|
| THESIS:39 | Thea1 heritage numbers (97 systemd units, 13 plugins, 1,841-line bridge, sentinel ate 37 replies, 193-line SOUL.md) | unverifiable | Thea1 mirror lives outside the repo; nothing here can re-measure. |
| THESIS:103 | canon "50–100 scenes across 8 behavioral dimensions" | verified (as a target range) | 65 canon scene files on disk (excluding 9 TEMPLATE.md + identity.md) — inside the stated range. Count now generated (`gen:canon-scenes` in ARCHITECTURE). |
| THESIS:115 | gravity dial "g = 0.7 at launch" | verified in code at `thea2.config.yaml:68-70` (`gravity.seedWeight: 0.7`) | — |
| THESIS:125 | "~49% of human turns are one message" | unverifiable | Measurement corpus not in repo. |
| THESIS:146 | quotas "1 disposition, 2 patterns, 2–3 episodes/memories, 1 contrast" | verified in code at `src/assemble/types.ts:192` | — |
| THESIS:164 | "Fork, task, and committee are ordinary tools in the same registry (ADR-009)" | verified in code at `src/loop/registry.ts:13-67` + `src/loop/turn.ts:493-537` | — |
| THESIS:170 | affect: eight identity dials, nine primaries, ticker v6 mechanics | verified in code at `src/affect/vocab.ts` (`EMOTION_TAGS:354`, per-mechanic files with Thea1 constants per M05 as-built) | — |
| THESIS:175 | "clamp(aᵀ·M·e + form-rules, ±λ), λ = 0.25" | verified in code at `coupling.yaml:24` | — |
| THESIS:176 | mood variants "≤6, across coarse buckets: bright, tender, low, tense, wanting, flat" | verified in code at `src/derive/types.ts:16` (`MOOD_BUCKETS`) + M08 caps tests | — |
| THESIS:191 | ponder committee GATE→SEED→GROUND→REVISE→ARTIFACT; depth ≤ 2, concurrency ≤ 3 | verified in code at `src/life/jobs.ts` (`PONDER_COMMITTEE_NAME`) + `src/loop/config.ts:76-77` | — |
| THESIS:202 | "Recall is in-process: bge-small embeddings" | **false — DAMAGE-HIGH** | Prod embedder is `hash` (`thea2.config.yaml:77`); `fastembed` is a typed refusal (`src/app/embedder.ts:35`). Brute-force cosine: verified (`src/embed/`). Real embedder: future v7 W2 P-EMBED. |
| THESIS:206 | "v1 tools: web_fetch, web_search, memory_search, remember_thread, set_reminder, plus the spawn primitives" | **false — DAMAGE-HIGH** | None of the five exist: `src/app/compose.ts:216` registers zero I/O tools; `src/loop/registry.ts:6-7` states they appear "only when their handlers exist". Only spawn primitives exist. Web tools: future v7 (P-WEB re-evaluated as MCP). |
| THESIS:212 | "As deployed (2026-09-02): z.ai GLM over the anthropic-compat door — glm-5.3-flash main and cheap, glm-5.3 reasoning" | **false — DAMAGE-HIGH** | Doors now (`thea2.config.yaml:11-43`, ADR-010). Same correction as ARCH:123. |
| THESIS:212 | "Ledger … may only downgrade non-user-facing task classes; `turn` pinned to the main tier in code (ADR-008)" | verified in code at `src/model/router.ts:4,62` (`PINNED_TURN_TIER`, `model.routing_ignored` at :47) | — |
| THESIS:230 | reconciliation invariant (every inbound → outbound or recorded silence, else alarm) | verified in code at `src/bridge/ledger.ts` (LOST_REPLY, failure-silence rule) + `src/app/maintenance-jobs.ts:27` | — |
| THESIS:238 | "16 missed heartbeats must NOT become 16 texts" | verified in code at `test/sched/catchup.test.ts` (the named regression) | — |
| THESIS:246 | stage gate "`pnpm lint && pnpm depcruise && pnpm test`" | **false** | The repo is npm-only (`package.json` scripts; no pnpm lockfile/config; AGENTS and CI use npm). Same error at ROADMAP:9. Correction: `npm run lint && npm run depcruise && npm test`. |
| THESIS:256 | "docs/modules/M01…M20.md — one spec per module" | verified in code at `ls docs/modules/` (20) | — |
| THESIS:257 | "decisions/ADR-001…009.md" | false | 11 ADR files (004a + 010 exist). |
| THESIS:261-262 | "corpus/derived/ GENERATED: exemplars + manifest.json (committed, provenance-stamped)" | **false — DAMAGE-HIGH** | 50 derived `.md` files exist, `corpus/derived/manifest.json` does not, the files are untracked in git, and `corpus:check` exits 1; CI runs it with `continue-on-error: true` (`.github/workflows/ci.yml`, ADR-007 step comment admits "advisory"). Future: v7 M.4 (commit derived + manifest; v6 D.6-7). |
| THESIS:266 | "schemas/ reference schemas (source of truth migrates into src/)" | false (as stated) | The migration inverted: `src/` imports the schemas at runtime (5+ files, e.g. `src/affect/store.ts:11` imports `schemas/events.js`; `src/consolidate/cluster.ts:9`, `src/assemble/types.ts:12` import `schemas/exemplar.js`). See schemas/README rows. Future: v6 DC.6 (regenerate or delete; carried v7). |
| THESIS:268 | "test/ 111 hermetic test files" | false | 131. Covered by `gen:tests-count`. |
| THESIS:282 | "launch requires only ~15 canon scenes" | verified (historical S2 launch condition, marked as such in §17) | — |
| THESIS:288-294 (§18) | validation criteria 3 (corpus:check proves sync) and 4 (Nightingale runs probes after a change) | false (as of today) | (3) corpus:check exits 1 — no manifest; (4) probes never run automatically. Criteria 1/2/5 are met by the suite (gates green pre-W1); 6-7 are live/VPS claims — unverifiable from this tree. Future: v7 M.4 / W4. |

## TESTING.md

| doc:line | claim | verdict | correction / evidence |
|---|---|---|---|
| TESTING:3 | header "1,502 tests / 111 files green" | false | 1695/131 now. `gen:tests-count` in README/ARCHITECTURE carries the moving truth. |
| TESTING:27 | "Five gates run in CI: typecheck, lint, npm test, depcruise, verify" | verified in code at `package.json:23` + `.github/workflows/ci.yml` | — |
| TESTING:33 | "every canon file parses and validates inside the suite … body ≤ 500 hard / 350 warn" | verified in code at `test/corpus/parse.test.ts` + `src/corpus/body.ts:17-18` | — |
| TESTING:40 | "prod embedder is `hash` until S9 (fastembed) — fastembed swap is config + index rebuild" | verified in code at `thea2.config.yaml:77` + `src/app/embedder.ts:35` | Plan pointer changed: real embedder is v7 W2 P-EMBED, not "S9". |
| TESTING:47 | "The live runner is `scripts/nightingale-live.ts` (env: THEA2_BOT_TOKEN + THEA2_MODEL_API_KEY …)" | verified in code at `scripts/nightingale-live.ts` (file exists) | Env-pair detail not re-verified line-by-line (out of my lane to run it — model spend). |
| TESTING:51 | "the baseline is currently the v5 rebase … 2026-09-02" | verified in code at `probes/baseline.json` (`"committedAtStage":"S8"`, `"version":5`, one probe `voice-cold-open`) | Note: baseline carries ONE probe of the three definitions. |
| TESTING:59 | "`thea2 corpus:check` — derived↔manifest sync (hermetic)" | verified as a command; currently failing | `package.json:24`; exits 1 today (no manifest). Correction: the doc should say the gate is red until derived+manifest land (v7 M.4). |
| TESTING:61 | "`npx tsx scripts/nightingale-live.ts --k 3`" | verified in code at `scripts/nightingale-live.ts` | — |
| TESTING:70-83 | chunk doctrine: `test` = `test:a` + `test:b`, guarded by `test:cover` | verified in code at `package.json:13,19-20` + `scripts/test-chunks-cover.ts` | ws-E gap stands: `test:cover` is in neither `gates` nor CI. Future: v6 T.2 (carried v7). |

## MIGRATION.md

| doc:line | claim | verdict | correction / evidence |
|---|---|---|---|
| MIGRATION:3 | `syncedTo: spec-v1 (no code yet)` | false | Code landed through S8 (all 20 modules). Header must bump at M.5. |
| MIGRATION:13 | Thea1 numbers (1,841-line bridge, 13 plugins, 1,012-line ticker.py, 97 units, 10 siblings) | unverifiable | Thea1 mirror is outside the repo. |
| MIGRATION:29 | heartbeat home "`src/life/heartbeat.ts` (M17)" | false (path) | No such file: heartbeat lives in `src/life/jobs.ts` (with policy in `src/life/policy.ts`). `ls src/life`: config, events, jobs, policy, ponder, thought. |
| MIGRATION:30 | ponder home "`src/life/ponder.ts` (M17)" | verified in code at `ls src/life/ponder.ts` | — |
| MIGRATION:33 | appraisal home "`src/memory/appraise.ts` (M09)" | false (path) | Actual: `src/memory/appraisal.ts`. |
| MIGRATION:38 | bridge home "`src/bridge/` (M15)" | verified in code at `ls src/bridge/` | — |
| MIGRATION:41 | tool registry home "`src/loop/tools/`" | false (path) | No such dir: the registry is `src/loop/registry.ts`; spawn handlers in `src/loop/turn.ts`. |
| MIGRATION:43 | "97 systemd units collapse to 2 … `deploy/` + M16 scheduler" | verified in code at `deploy/thea2*.service,timer` + `src/sched/` | (Thea1 count itself unverifiable.) |

## ROADMAP.md

| doc:line | claim | verdict | correction / evidence |
|---|---|---|---|
| ROADMAP:3 | header "1502 tests, five gates green" | false | Count (1695/131). Gates: verified. |
| ROADMAP:3 | header "backend = z.ai anthropic door per Diego 2026-09-02" | **false — DAMAGE-HIGH** | Superseded same day by the doors registry (D.6-1, `thea2.config.yaml:11-43`): voice = Neuralwatt glm-5.3; z.ai = fallback. |
| ROADMAP:9 | "the repo is green at the gate — `pnpm lint && pnpm depcruise && pnpm test`" | false | npm, not pnpm (`package.json`). Same as THESIS:246. |
| ROADMAP:20 | starter canon "~15 scenes" (S2 gate) | verified (historical condition, correctly marked as the S2 gate) | Today: 65 scene files. |
| ROADMAP:31 | S5 landed — "live smoke done on z.ai GLM-5.3-flash, streaming SSE" | unverifiable | Live-run claim; no artifact in the repo records it beyond this line and STATUS. |
| ROADMAP:36 | S7 landed — "derive re-running live on z.ai 2026-09-02 — the first run starved: 0/106 parse-failed" | unverifiable | Same — live-run history. |
| ROADMAP:39 | S8 — "Nightingale baseline v6 of record: det green, judge median 5.00 (var 0.00), voice drift 0.43, k=3 live on z.ai" | verified in code at `probes/baseline.json` (judgeMedian 5, judgeVariance 0, drift.voice 0.4308, version 5) | Baseline holds exactly one probe entry; "k=3 live" is unverifiable. |
| ROADMAP:42-43 | "S9 — optional, later … `thea2 import` … not built" | verified in code at `src/app/cli.ts:25` (import = not built) | The whole S0–S9 frame is superseded: plan of record is v7 waves/packages. Future: v7 DC.5 (ROADMAP replaced at M.5). |
| ROADMAP:52 | post-v1 deferrals "world/rooms, door, image gen, voice, hobbies, wallet, skills, LoRA" | verified (absence) | Zero occurrences of wallet/brave/house machinery in `src/` (ws-E §2.2 still holds). Mapped to v5/v7 package ids at M.5. |

## AGENTS.md

| doc:line | claim | verdict | correction / evidence |
|---|---|---|---|
| AGENTS:3 | `syncedTo: S8 as-built (2026-09-02)` | false (stale) | The 2026-09-03 landings (and W1 in flight) are not reflected. ws-E #13. Bump at M.5. |
| AGENTS:16 | "`docs/modules/MNN-<name>.md` — YOUR module's contract" | verified in code at `ls docs/modules/` | — |
| AGENTS:26 | rule 3 determinism (no Date.now/Math.random/setTimeout in module code; no network in tests) | verified in code at `eslint.config.js` (`noTimeOrEntropy` on src/schemas/scripts; network ban on `test/**/*.test.ts`) | — |
| AGENTS:36 | rule 8 "`corpus/lived/` only by M10's consolidators. `corpus/proposals/` only by M10, merged only by the human" | false (paths moved) | Since M10 round 2 the consolidators write `var/lived/` and `var/proposals/` (`src/app/compose.ts:392-393`); `corpus/lived/` is empty and unwritten. `corpus/proposals/` now holds only human/agent DRAFTS (e.g. `drafts-short.md`). |
| AGENTS:43-44 | syncedTo law: "bump its header in the same change" | false (as practiced) | No top-level doc was bumped for any 2026-09-03 landing (headers all read S8 / 2026-09-02). ws-E #13. M.5 must bump every touched doc. |
| AGENTS:62 | "Stages list safe parallel groups (ROADMAP)" | false (pointer) | ROADMAP's S-stages no longer describe the working plan; the v7 wave/package table does. Future: v7 DC.5. |

## corpus/README.md

| doc:line | claim | verdict | correction / evidence |
|---|---|---|---|
| corpus/README:3 | `syncedTo: spec-v1 (no code yet)` | false | M07 corpus is built (`src/corpus/`, `test/corpus/`). |
| corpus/README:13 | canon "50–100 scenes" | verified (target range) | 65 scene files — in range. |
| corpus/README:18 | "every scene rewritten in the measured voice … (Elena 7,476 + Diego 12,533 …)" | unverifiable | Measurement corpora not in repo; the 2026-09-02 rebase is a human-action claim. |
| corpus/README:29 | "≤ 350 tokens per body (hard fail at 500)" | verified in code at `src/corpus/body.ts:17-18` | — |
| corpus/README:36 | "weight: default 1.0 … credit system will drift it ±" | verified in code at `src/consolidate/credit.ts` (clamp [0.5,2.0], η 0.02) + `src/assemble/score.ts:27` (γ 0.15) | — |
| corpus/README:46 | "no kaomoji, no tildes, no em-dashes … (all 0/7,476 in the human corpus)" | verified (ban) / unverifiable (measurement) | Bans enforced by lint/gate rules (`src/corpus/lint.ts`, inhibit normalize class); the 0/7,476 measurement is outside the repo. |
| corpus/README:54 | "seed weight g = 0.7 at launch; ADR-005" | verified in code at `thea2.config.yaml:69` | — |
| corpus/README:58-60 | special files canon/identity.md, inhibitions.yaml, registers.yaml, exclusions.yaml | verified in code at `ls corpus/canon/` | — |

## deploy/ops.md

| doc:line | claim | verdict | correction / evidence |
|---|---|---|---|
| ops:3 | `syncedTo: Phase 1` | false (stale) | Same ws-E #13 family: nothing bumped for 09-03. |
| ops:19-23 | thead pid lock at `var/thead.pid`; `derive --allow-live-derive` + `derive.live_override` | verified in code at `src/app/main.ts:92-102` | — |
| ops:25-27 | "`bin/thea2` … verbs (`status`, `reconcile`, `corpus:check`, `derive`) resolve through `/opt/thea2/bin/thea2`" | verified in code at `src/app/cli.ts:64-72` + `deploy/bin/` | Incomplete: `proposals:export` also exists (`cli.ts:72`). |
| ops:36-39 | "The scheduler runs SIX registered jobs: heartbeat, ponder, reflect, reconcile, affect-snapshot, ledger … Nightingale stays unregistered" | verified in code at `src/app/compose.ts:486-493,470-473` | Exact match. (`gen:job-table` now carries it.) |
| ops:41-42 | "timezone: Europe/Madrid with quiet hours [1, 9] local" | verified in code at `thea2.config.yaml:56-60` + `src/life/policy.ts` (local-hour gates) | ws-E #15: resolved, no drift. |
| ops:30-31 | "`thea2.service` carries `SuccessExitStatus=143` … `TimeoutStopSec=120`" | verified in code at `deploy/thea2.service` | — |
| ops:36 | "Nightingale stays unregistered until the Phase-4 probe suite" | verified in code at `src/app/compose.ts:470-473` | Phase-4 = v7 W4 P-PROBES. |

## schemas/README.md

| doc:line | claim | verdict | correction / evidence |
|---|---|---|---|
| schemas/README:5 | "They are **not** imported by `src/` at runtime and never will be" | **false — DAMAGE-HIGH** | `src/affect/store.ts:11` imports `../../schemas/events.js`; `src/consolidate/cluster.ts:9`, `src/consolidate/credit.ts:10`, `src/consolidate/run.ts:21`, `src/assemble/types.ts:12` import `../../schemas/exemplar.js`. The schemas are live runtime code, not documentation artifacts. |
| schemas/README:8-12 | sync rule: "at the owning module's build stage, source of truth migrates to `src/<module>/`" | false (never happened) | The named migration stages (S1–S8) all landed; the schemas stayed the shared source and `src/` now imports them. The "mirror in the same PR" rule is unenforced by any gate. |
| schemas/README:18-22 | table: exemplar→M7 migrates at S2; appraisal→M9 at S3; decision→M13 at S4; events→M2 at S1; probe→M19 at S8 | false (stale frame) | Same as above. Note: decision/probe mirrors are NOT imported by src (src/loop owns decision schema; src/probes owns probe shape) — the table is wrong in both directions. Future: v6 DC.6 (regenerate from `src/` or delete, keep `exemplar.ts` decision explicit; carried v7). |
| schemas/README:28 | "AFFECT_DIMS … defined in `exemplar.ts` here; canonical home will be `src/affect/vocab.ts`" | false | `src/affect/vocab.ts` defines `EMOTION_TAGS` but NOT `AFFECT_DIMS`; the canonical constant is `schemas/exemplar.ts`, re-exported through `src/coupling/space.ts`. |
| schemas/README:29 | "EMOTION_TAGS canonical list is ported from Thea1 ticker.py into `src/affect/vocab.ts`" | verified in code at `src/affect/vocab.ts:354` (`EMOTION_TAGS`) | — |

## probes/README.md

| doc:line | claim | verdict | correction / evidence |
|---|---|---|---|
| probes/README:3 | `syncedTo: spec-v1 (no code yet)` | false | M19 built: `src/probes/`, `test/probes/` (M19 doc: "83 tests green"). |
| probes/README:29 | "k=3, median-aggregated; variance tracked" | verified in code at `src/siblings/types.ts` (`PROBE_K`) + M19 acceptance tests | — |
| probes/README:45-50 | gates: det fail ⇒ red; judge median drop > 0.8 ⇒ red; drift drop > 0.05 ⇒ yellow | verified in code at `src/probes/baseline.ts` (boundary tests per M19) | Thresholds true; the runner that would enforce them live is unregistered (compose.ts:470-473). |
| probes/README:52-54 | "A routing change … wakes Nightingale (M18)" | **false** | Nightingale is never registered (`src/app/compose.ts:470-473`); no deploy-marker watcher runs. Future: v7 W4 P-PROBES. |
| probes/README:66 | "Target suite at maturity: ~25 probes" | future (v7 W4 P-PROBES, ≥24 with controls) | Today: 3 probe files (`probes/*.probe.yaml`). |
| probes/README:16 | "baseline.json — scores + drift centroids; recommitted after each accepted change" | verified (file exists) / false (practice) | `probes/baseline.json` exists (version 5, one probe). No machinery recommits it automatically, and no live runner updates it. |

## docs/modules (drift rows; each doc's own "As built" section supersedes its spec body — M.5 reconciles per doc)

| doc:line | claim | verdict | correction / evidence |
|---|---|---|---|
| M03:15-17 | Tiers `main\|cheap\|reasoning`; TaskClass union (9 classes) | verified in code at `src/model/tiers.ts` + `src/model/types.ts` | — |
| M03:43 | "Tier registry from config: `{ main: 'glm-5.2', cheap: 'deepseek-v4-flash', reasoning: <config> }`" | false | `glm-5.2` never shipped anywhere; the config is the door registry (`thea2.config.yaml:11-43`): voice glm-5.3 / mind deepseek-v4-flash / judge kimi-k3. Spec-era sentence superseded by M03's own v6-W1 "As built" section. |
| M03:52 | "No streaming in v1" | false (superseded in-doc) | The same file's "As built (S8)" section documents always-on SSE streaming (`src/model/anthropic.ts`). M.5: fold the spec body to the as-built truth. |
| M03:123 | "Pinned in test/model/toolchoice.test.ts; emit-tool goldens in wire.test.ts / anthropic.test.ts" | verified in code at `ls test/model/` | — |
| M03:131 | "Kill-switch `models.thinking: 'off'` remains the emergency lever (P-A.2)" | false | No `models.thinking` key exists in `src/app/config.ts` or `thea2.config.yaml` (only per-door `thinkingBudget`). P-A.2 never landed; P-DOOR replaced THINKING_DEFAULTS with `REASONING_BY_CLASS` (src/model/tiers.ts). |
| M03:133-143 | v6-W1 as-built: door schema, `tierFor` main→voice/cheap→mind/reasoning→judge, `REASONING_BY_CLASS`, forcing, DR.4-DR.7 | verified in code at `src/model/tiers.ts`, `src/model/router.ts:31`, `src/model/client.ts`, `src/model/wire.ts` (spot-checks; P-DOOR is the owning agent) | Consistent with `thea2.config.yaml`. |
| M07:70 | "the current 17 DRAFT canon scenes + controls pass" | false (stale count) | 65 canon scene files today. Historical S2 acceptance text — mark as historical or regenerate. |
| M07:86 | "`disposition: true` … un-commenting the six canon files … is the author's hand" | future (v6 K0.1, in flight) | The six flags were still commented at ws-E; K0 (main agent) owns the un-commenting. Canon files show in-flight edits in git status. |
| M08:54 | "Manifest at `corpus/derived/manifest.json` (committed)" | false (as of today) | No manifest exists; 50 derived files untracked; `corpus:check` exits 1. Future: v7 M.4. |
| M08:60 | "the scheduler's weekly `derive-check` job (M16, wired by M20)" | false (as built) | Not registered — `compose.ts:486-493` has exactly six jobs; ARCHITECTURE:150 correctly says "not registered". Future: v5 P-LIFE/W4 or drop. |
| M09:98 | "`openPersistedThreadIndex(dir)` persists the fold to `var/memory/threads.jsonl`" | verified in code at `src/memory/threads.ts` + `src/app/compose.ts` (openPersistedThreadIndex wiring) | — |
| M09:114 | "Call sites left for round 3 (compose opens the index …)" | false (stale) | Round 3 landed: compose folds appraisal threads and passes `dueThreadNotes` (see M20:115 "Standing intent is real" + `src/app/compose.ts`). M09's own header (round 2) predates it. |
| M10:11 | "canon-promotion proposals only — `var/proposals/`, human merges via `thea2 proposals:export`" | verified in code at `src/app/compose.ts:393` + `src/app/cli.ts:72` | — |
| M16:44-47 | job table (heartbeat 30 / ponder 20 / reconcile 5 / affect-snapshot 15, lanes, catch-up) | verified in code at `src/life/config.ts:53-56`, `src/app/maintenance-jobs.ts:27,29` | Matches compose registration exactly. |
| M17:44 | heartbeat: 30 min, 3.2 threshold, five criteria, 3/day cap, 3h doubling backoff | verified in code at `src/life/policy.ts:20,36,43` (`HEARTBEAT_THRESHOLD 3.2`, `HEARTBEAT_DAILY_CAP 3`, `HEARTBEAT_BACKOFF_BASE_H 3`) | — |
| M17:47 | ponder: GATE 0.45 pure, no model | verified in code at `src/life/policy.ts:189,222` (`PONDER_GATE 0.45`, `ponderGate`) | — |
| M18:39 | Nightingale trigger "deploy-marker change, watched every 1 min … or manual `thea2 probe run`" | false (as built) | The watcher and job exist in code (`src/siblings/nightingale.ts:288`) but are never registered; `thea2 probe` is not built (`src/app/cli.ts:25`). Future: v7 W4. |
| M19:4 | "83 tests green" (header) | unverifiable (moving count) | test/probes exists; the exact number moves with concurrent work — docs should not carry bare test counts outside gen blocks. |
| M20:24 | config schema `embedder: { kind: 'fastembed' \| 'api' \| 'hash' }` | verified in code at `src/app/embedder.ts:10` | — |
| M20:52 | "`prod` — real everything: fastembed embedder, Neuralwatt client" | **false — DAMAGE-HIGH** | Embedder is `hash` (`thea2.config.yaml:77`); the model side is the door registry (Neuralwatt voice/mind/judge + z.ai fallback), not a single "Neuralwatt client". Both halves need the M20 as-built rewrite. |
| M20:56 | verbs list: "`thea2 probe run [--dry]` (S8)" | false | `probe` is a staged, not-built verb (`src/app/cli.ts:14,25`). Registered verbs: thead, reconcile, status, derive, corpus:check, proposals:export. |
| M20:60 | live smoke "real Telegram + real Neuralwatt" | false (history) | The S5 smoke ran against z.ai (ROADMAP:31); Neuralwatt arrives with P-DOOR doors. Mark the historical backend correctly at M.5. |
| M20:92 | "Embedder interim: `hash`, not `fastembed` — kind `fastembed` composes a loud `app/not-built` failure" | verified in code at `src/app/embedder.ts:34-35` | — |
| M20:122 | "The Ledger is registered — six jobs on a real boot. Nightingale stays unregistered … `probes/not-built` refusal" | verified in code at `src/app/compose.ts:470-473,486-493` | — |

## docs/decisions (ADR status + drift)

| doc:line | claim | verdict | correction / evidence |
|---|---|---|---|
| ADR-001:4 | status: accepted ("standalone agentic loop over an OpenAI-compatible API") | verified (frontmatter) / false (framing) | The as-built client speaks BOTH wires (src/model/anthropic.ts, src/model/wire.ts) and the plan of record admits OpenCode as the spine behind SpineRunner (v7 D.7-1 amends ADR-001). Amendment lands with v7 M21/P-SPINE-1, not before. |
| ADR-001:24 | "Direct OpenAI-compatible chat client (M3) against the Neuralwatt tiers" | false (superseded twice) | S8 moved to the z.ai anthropic door; W1 moved to doors (Neuralwatt openai voice/mind/judge + z.ai anthropic fallback). ADR-010 + M03 as-built are the truth. |
| ADR-002:4 | status: accepted; "one thead process, two systemd units" | verified in code at `deploy/` + compose architecture | v7 D.7-1 adds one pinned supervised spine child (W2) — amendment is future (v7 M21). |
| ADR-003:4 | status: accepted (no sentinel; ledger reconciliation) | verified in code at `src/bridge/ledger.ts` + `src/app/maintenance-jobs.ts` | v6 DC.4 adds the terminal-state rule (abandoned rows) at M.5 — future (v6 P-CLOSE, carried v7). |
| ADR-004a:4 | status: **proposed** | verified (frontmatter) | Still `proposed` though the config-backed dominance baseline shipped (`src/affect/vocab.ts`); v6 DC.4 resolves to accepted/rejected at M.5. |
| ADR-005:4 | status: accepted; seed gravity dial | verified in code at `thea2.config.yaml:69` (seedWeight 0.7) + `src/consolidate/gravity.ts` | v6 DC.4: update for `var/lived` (lived competes from var/, not corpus/lived) at M.5. |
| ADR-006:4 | status: accepted; disposition slot canon-only | verified in code at `src/corpus/nominator.ts:206-210` | — |
| ADR-007:4 | status: accepted; derived output committed with manifest, corpus:check green in CI | **false — DAMAGE-HIGH** (as built) | 50 untracked derived files, no manifest, `corpus:check` exits 1, CI step `continue-on-error: true` (`.github/workflows/ci.yml`). The ADR's invariant is unmet; either land derived+manifest (v7 M.4) or the ADR carries a status note until then. |
| ADR-008:4,11 | status: accepted; "downgrading user-facing turns to the cheap tier (deepseek-v4-flash)" | verified in code at `src/model/router.ts:4,62` (turn pinned; routing_ignored) | deepseek-v4-flash is indeed the mind/cheap door's model now (`thea2.config.yaml:33`) — the example is accidentally current again. |
| ADR-009:4 | status: accepted; two channels | verified in code at `src/assemble/render.ts` + `src/memory/procedural.ts` | — |
| ADR-010:4,17-18 | status: accepted; door schema + shipped defaults (voice Neuralwatt glm-5.3 low/none; voiceFallback z.ai glm-5.3-flash budget 512; mind deepseek-v4-flash; judge kimi-k3; tierFor mapping) | verified in code at `thea2.config.yaml:11-43` + `src/model/tiers.ts` + `src/model/router.ts:31` | Newest ADR; matches config line for line. |

## Cross-cutting rows (seed §4 items that are themselves claims)

| doc:line | claim | verdict | correction / evidence |
|---|---|---|---|
| ws-E §4 #10 / all docs | "No repo document references the plan of record (v5/v6/v7) at all" | verified (still true) | grep `thea2-v[5-7]|P-CAST|P-SPINE|P-EMBED` over *.md + docs/** = 0 hits. Future: v7 DC.5 — every doc pointing at S0–S9 gains wave/package ids at M.5. |
| all top-level docs | every `syncedTo:` header reflects the current stage | false | All still `S8`/`Phase 1`/`spec-v1`/2026-09-02 except M03 (bumped to v6-W1 by P-DOOR). ws-E #13. M.5 bumps every touched doc. |
| README vs ARCHITECTURE vs TESTING vs ROADMAP | four docs, four different test counts (1,656 / 1,502 / 1,502 / 1502) and two different file counts (111 / 125) | false — now structurally fixed | Counts move per commit; only the `gen:tests-count` blocks (README+ARCHITECTURE) are checked against code by `npm run docs:check`. M.5: delete hand-typed counts everywhere else. |
| docs/MANUAL.md:33 | "56 hand-written scenes" | false | 65 canon scene files today (excl. TEMPLATE/identity). MANUAL is not in the W1 sweep list (M.5 owner); row recorded here because it seeds the same correction as THESIS:103. |
| docs/WHITEPAPER.md §1.5 | binding welfare clause "honored in Parts 2–4" | future (v7: D.9 removal at M.5 / v6 DC.4) | v5 D.9 removed the welfare list; the whitepaper was never amended. WHITEPAPER is not in the W1 sweep list; recorded as the seed requires. |
| docs/WHITEPAPER.md (link graph) | whitepaper is orphaned — not linked from README/ARCHITECTURE/ROADMAP/AGENTS/THESIS | verified (still true) | Not in README's read-order table (README:63-76) or any top doc's pointers. M.5 links or delinks it deliberately. |

---

## What M.5 must rewrite first (priority order)

1. **Backend/model truth** — ARCHITECTURE:123, THESIS:212, README:24-26, ROADMAP:3, M20:52/60, M03:43, ADR-001:24. One story: doors (ADR-010) — voice = Neuralwatt glm-5.3, mind = deepseek-v4-flash, judge = kimi-k3, z.ai = voiceFallback; hash embedder until P-EMBED.
2. **Capability claims that don't exist** — README:60/75-76/106-107, THESIS:202/206, probes/README:52-54, M18:39, M20:56: no I/O tools, no live Nightingale, no bge-small recall, no probe verb. Rewrite as "absent registration (AGENTS rule 5)" + plan pointer.
3. **Numbers** — every hand-typed test/scene/ADR count (README:22/104, ARCH:3, TESTING:3/27, ROADMAP:3, THESIS:257/268, README:91, M07:70). Rule: numbers only inside `gen:` blocks; `npm run docs:check` is the arbiter.
4. **ADR-007 vs derived corpus reality** — THESIS:261, M08:54, ADR-007: either derived+manifest land (v7 M.4) or every doc claiming "committed derived corpus / corpus:check green" gets an explicit "not yet" until it does.
5. **Path corrections** — MIGRATION:29/33/41, AGENTS:36 (var/lived, not corpus/lived), schemas/README (schemas ARE runtime imports — DC.6 regenerate-or-delete), ARCH data-stores table (add threads.jsonl, credit/weights.json).
6. **Plan integration (DC.5)** — replace S0–S9 pointers with v7 wave/package ids; link the plan files from README; fix pnpm→npm (THESIS:246, ROADMAP:9).
7. **syncedTo bumps** — every touched doc, in the same change (AGENTS law).
