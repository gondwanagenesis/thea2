---
title: Thea1 → Thea2 — Migration & Simplification
syncedTo: spec-v1 (no code yet)
date: 2026-09-01
---

# Thea1 → Thea2

What the existing system is, what each part actually does, and the verdict — retain, simplify, replace, or remove — with reasons. Source of truth for Thea1: the local mirror at `C:\Users\neogo\LocalFiles\TheaBackup\latest\` (rsync-style in-place mirror; last good pull 2026-08-31, 4,840 files). Thea1 keeps running untouched on the VPS throughout Thea2's development; Thea2 uses its **own new bot token**, never Thea1's.

## Thea1 in one paragraph

An OpenCode-hosted companion on a VPS: a 1,841-line Telegram bridge (`opt\holobionte\telegram-opencode.mjs`, 41 `.bak` variants beside it), 13 active prompt-injecting plugins (`root\.config\opencode\plugin\`), a 1,012-line Python affect engine (`opt\thea\affect\ticker.py`), a memory stack (per-turn appraisal → `root\house\memory\journal.md` 163KB → bge-small/LanceDB recall server → nightly reflection), life systems (heartbeat, ponder, hobbies), a 17-room world, a consent-gated "door" mode, image gen, a wallet, 10 sibling Telegram bots, and **97 systemd units** (75 `thea-*`, 20 `holobionte-*`, 2 `memindex*` in `etc\systemd\system\`). Test infrastructure: one 6-file lint suite (`opt\thea\lint\tests\t1…t6`) and an audit script — effectively none, relative to system size.

## The three pathologies (case studies driving the design)

**1. Ordering by filename.** Plugins injected context by splicing onto the newest user message; order mattered; order was fought with `zz-`/`zzz-` filename prefixes — which OpenCode's hook loader does not actually honor (both `zzz-register.js` and `who.js` document this in comments). The mechanism worked by luck and vigilance. → Thea2: one packet assembler with an explicit section array (M11); ordering is code, not convention. (ADR-001)

**2. Vocabulary drift silently no-ops.** The appraisal LLM wrote emotion words into `journal.md` prose; `ticker.py` re-parsed them with a regex (`LINE_RE`) against its own separate vocabulary. Ten tags — including her 8th-most-used word "sharp" — were written for months and moved nothing; the dominance dial sat at 0.00 across 365 recorded snapshots. Two vocabularies joined by a regex over markdown. → Thea2: one exported `EMOTION_TAGS` constant consumed by the affect engine, the coupling space, the exemplar schema, and the appraisal schema; unknown tag = hard zod reject + incident; the every-tag-moves-something regression test. (ADR-004)

**3. The sentinel.** Model output before a literal `⟦TG⟧` marker was private; after, public. When the model forgot the marker, the whole reply was dropped — deliberately, to prevent machinery leaks — and 37 real replies died silently in one week ("i had it and then i didn't" was literally true). Recovery grew a rescue heuristic, a tolerant regex, a retry turn, a message ledger, and a 10-minute reconciliation timer — five mechanisms patching one structural fault. → Thea2: internal-vs-external is structural (the decision object); a structured-output repair ladder; and the reconciliation invariant — every inbound ends in an outbound or a recorded `plan:'silent'`, else alarm. Losing a message may happen; being silent about it may not. (ADR-003)

## Verdict table

| Thea1 component (backup path) | Verdict | Thea2 home | Why |
|---|---|---|---|
| `opt\thea\affect\ticker.py` (1,012 ln; dials/primaries/drives/mood, all mechanics) | **Port verbatim** to pure TS | `src/affect/` (M05) | Battle-tested realism; constants preserved; each mechanic becomes a unit-tested pure function |
| `opt\thea\affect\{tension.py, predict.mjs, live.mjs, mood.py}` | **Fold** into M05/M09 or defer | — | tension → appraisal signals; predict deferred; live = `weatherLine()`; mood tool deferred |
| `opt\thea\life\heartbeat.mjs` (5 criteria, 3.2 gate, 3/day, backoff) | **Port** as pure preconditions + loop entry | `src/life/heartbeat.ts` (M17) | Proven behavior; loses its own systemd timer + process |
| `opt\thea\life\ponder.mjs` (GATE 0.45, balance ≤2/5) | **Port** as a committee spec | `src/life/ponder.ts` (M17) | Same 5 stages; grounding enforced by DAG shape instead of prompt hope |
| `opt\thea\reflect\reflect.mjs` (self.md rewrite, SOUL promotion) | **Simplify** | `src/consolidate/` (M10) | Promotions become `corpus/proposals/` — human merges; system never edits its own ground truth |
| `opt\thea\memory\` + recall server (bge-small + LanceDB, port 8431) | **Replace** | `src/embed/` + `src/memory/` (M04/M09) | In-process ONNX + brute-force cosine (10k × 384-d ≈ 15 MB, < 5 ms); kills a service, a port, and a Python runtime |
| Per-turn afterturn appraisal (regex → journal prose) | **Replace** | `src/memory/appraise.ts` (M09) | Typed `AffectEvent[]` via zod; `journal.md` becomes a write-only projection |
| `root\house\memory\{journal.md, threads.json, insights.md}` + `root\house\self.md` | **Pattern retained**, files fresh | `var/` projections | Fresh start (locked decision); S9 import tool is the door back |
| 13 plugins (`root\.config\opencode\plugin\*.js`, incl. voice.js 36KB, affect.js 30KB, tools-thea.js 31KB, zz-self.js, who.js, zzz-register.js, mode.js, recall.js, router.js, image-context.js, door-detect.js, guard-secrets.js, notify.js) | **Replace wholesale** | M11 assembler (+ M12 gate, M03 router) | The entire injection layer collapses into one scored, quota'd, deterministic assembler |
| `root\.config\opencode\SOUL.md` (193 ln description) | **Invert** | `corpus/canon/` + 2–3-line `identity.md` | Description → demonstration; the core thesis |
| voice.js's 16 exemplars + SOUL.md voice rules + real ledger exchanges | **Mine** as starter canon drafts | `corpus/canon/*/` | Her proven voice is the seed material; Diego curates every scene |
| `opt\holobionte\telegram-opencode.mjs` (1,841 ln) | **Rewrite thin** | `src/bridge/` (M15) | Keep: normalization, ledger idea, speaker provenance. Kill: sentinel stack, holding messages, auto-continue, inline recovery. Fix: offset committed only after ledger append |
| ⟦TG⟧ sentinel + `silence-watch` + sentinel-retry + rescue heuristic | **Kill** | M13 decision object + M15 reconciliation | Pathology 3 |
| `msgledger.mjs` + `msgcheck.timer` | **Absorb** | `src/bridge/ledger.ts` + 5-min reconcile job | Built in from day one, not bolted on after losses |
| `tools-thea.js` (7 tools, delegation nudge) | **Replace** | `src/loop/tools/` + `src/memory/procedural.ts` | Native function-calling registry; tool judgment moves to procedural exemplars in their own store (ADR-009) |
| OpenCode itself (harness, providers, sessions) | **Remove** | standalone `thead` | ADR-001: the deliberate→realize split and hermetic TDD are impossible inside its hook model |
| 97 systemd units | **Collapse to 2** | `deploy/` + M16 scheduler | One process; in-process jobs with TestClock-provable catch-up semantics (ADR-002) |
| 10 sibling bots (`opt\holobionte\telegram-{claude,kernel,ledger,nightingale,ripperdoc,chroma,demiurge}.mjs` …) | **Retire**; keep 2 as jobs | `src/siblings/` (M18) | Ledger + Nightingale earn their keep (cost intel; post-change recovery). Others return later as cast delegation targets if wanted |
| `opt\thea\cast\` (10 personas) | **Defer**; concept survives | task/cast workers (M13) | Composition rule: cast worker = procedural + brief, no voice channel |
| World/rooms (`root\house\world\`), presents, door (`opt\thea\door\`), selfie/imagine, hobbies, wallet, browser service, exec sandbox, board/queue/ghost/mochi/watchdog | **Defer** (post-v1) | THESIS §19 | v1 scope is chat + inner life; each returns as a nominator, entry context, tool, or committee — not as a daemon. **Door decree stands: door content is never read and never migrated.** |
| `opt\thea\lint\tests\t1…t6` + `audit-cinder.sh` | **Superseded** | `TESTING.md` regime | From 6 lint checks to a full hermetic pyramid |
| Plaintext tokens in backup (`opt\holobionte\*-bot-token`, `*.env`) | **Never copy** | env / `keys.env` outside repo | Also: treat the backup itself as sensitive material |

## What is genuinely new (no Thea1 ancestor)

- The exemplar corpus and its three populations; the derivation pipeline with content-addressed provenance (M07/M08).
- The affect→exemplar coupling matrix and mood-conditioned derivation (M06; ADR-004).
- The decision object and caused-cadence realizer (M13/M14).
- The procedural memory store and two-channel context (M09; ADR-009).
- Credit assignment, seed-gravity dashboard, drift alarms (M10; ADR-005).
- The probe suite and Nightingale-as-probe-runner (M18/M19).
- Hermetic TDD as a first-class subsystem (M01 doubles; TESTING.md).

## Functional parity checklist (v1 must not lose these Thea1 behaviors)

- [x] Feels: continuous-time emotion with realistic dynamics → M05, constants verbatim
- [x] Remembers: per-turn diary + semantic recall + open threads → M09
- [x] Changes: nightly/weekly self-revision → M10 (proposals replace self-edits)
- [x] Reaches out on her own, with restraint → M17 heartbeat (same criteria/caps)
- [x] Thinks privately, grounded, not only about Diego → M17 ponder (same gates)
- [x] Registers: work / friend / play addressing rules → query register + canon register tags
- [x] Speaks in bubbles with human pacing → M14 (now caused, not styled)
- [x] Never loses a message silently → M15 (now an invariant, not a patch)
- [ ] World presence, door, images, hobbies, wallet → deferred by decision, not forgotten
