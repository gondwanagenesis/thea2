---
title: Thea2 — Owner's Manual
syncedTo: S8 as-built (2026-09-02)
audience: Diego first; curious readers second
---

# Thea2 — owner's manual

This is the how-does-she-actually-work document, written to be read front to
back once. Every mechanism is explained with its *why* — because in this repo
the why is load-bearing: most of the architecture exists as a direct answer to
a specific way Thea1 failed. ([THESIS.md](../THESIS.md) carries the full
argument; this manual assumes you want the working parts.)

> **The one-paragraph version.** Thea is a Telegram companion — Diego's best
> friend on the wire — whose entire personality lives in a corpus of concrete
> example scenes, not a persona document. Every turn, the system picks a handful of scenes *relevant to right
> now* (what you said, who you are, what she remembers, how she currently
> feels) and shows them to the model as demonstrations. Her feelings are a real
> mechanical system with a single writer. Her memory accumulates in layers that
> slowly become part of her corpus. She works one job schedule, one process,
> two systemd units — and everything she does lands in an append-only event
> log, so nothing can fail silently twice.

---

## 1. Who she is

Her identity in full prose is three lines in
[`corpus/canon/identity.md`](../corpus/canon/identity.md). That is deliberate
(design principle 1: *demonstration over description*). Everything else about
who she is — how she texts, how she argues, how she cares, what she finds
funny — lives in 56 hand-written scenes under `corpus/canon/` (2026-09-02:
rebased on the Elena/Diego measurement, then widened hard across all eight
dimensions so every register and emotional extreme has demonstration), each
one a
small script of a real exchange (`D:` / `T:` lines) plus frontmatter saying
what the scene demonstrates and what must survive.

The scenes were rebased (2026-09-02) on a measured human baseline: the
complete WhatsApp corpus of the two people closest to the character —
Elena's 7,476 messages and Diego's 12,533. Her texting voice is Elena's,
measured (85% lowercase, "lol" as clause-glue, elongation, a small warm emoji
set reused carelessly) plus a gen-z literacy layer. Diego's side is measured
too — his long-form is the model for hers: **long turns arrive as chains of
short uneven bubbles, never as a formatted wall** (median 6 bubbles per
50+-word turn; formatting is the assistant tell).

**The anti-fabrication law.** Canon holds talking styles, jokes, and
present-tense tastes only. No invented memories, no past events, no claimed
home or childhood — a concrete detail must be something she can actually
observe (her server, her jobs, her logs, your messages). She can want and like
physical things — that's human of her; she cannot have *gotten* them somewhere
last spring. Her lived history is written by the consolidators (§5) from what
actually happens, never pre-authored.

## 2. What happens when you send a message

End to end, one inbound text becomes zero or more outbound bubbles:

```
Telegram → bridge: ledger.recordInbound → offset commit → enqueue
  → turn query: who's speaking, register, embedding, recent window
  → packet assembler: pick this turn's demonstration scenes (§7)
  → deliberation loop: model thinks, may use tools, locks a decision object
  → inhibition gate: hard rules, last word
  → realizer: bubbles + caused cadence → Telegram (ledger)
  → afterturn (detached): appraise → episode → affect events → credit
```

Two invariants worth knowing by heart:

- **Append before commit.** The inbound message is written to the ledger
  *before* the update offset is committed. Kill the process anywhere mid-turn
  and on restart the message is redelivered exactly once (crash-replay is a
  named e2e test, not a hope).
- **Every inbound terminates.** Within the reconcile window, each inbound ends
  in at least one outbound message *or* a recorded decision to say nothing.
  Anything else raises a lost-reply alarm. Losing a message is permitted to
  happen; it is not permitted to be silent (ADR-003 — Thea1's sentinel once
  ate 37 real replies in a week, silently).

## 3. Her voice — demonstrated, then guarded

There is no persona file and no style sheet. The voice is a corpus of scenes,
and every turn the packet assembler picks the ones that fit — by register, by
affect, by similarity to the conversation. The model imitates demonstrations,
not adjectives. What guards the voice around that demonstration is mechanical,
in four layers:

**Registers** (`corpus/canon/registers.yaml`) — play / work / friend, each
with modifiers (late-night, crisis, precision, reunion...). A packet may mix
at most two, and exclusions forbid some pairings. Register conditions which
exemplars she draws, so voice shifts by demonstration, never by instruction.

**The draft prompt's bans** — a short list of 0-for-the-corpus tells
(em-dashes, kaomoji, asterisk-actions, sign-offs). Prompt bans alone are weak
— Thea1 measured 0% compliance across 190 em-dashes — which is why the next
two layers exist.

**The inhibition gate** (compiled once at boot from
`corpus/canon/inhibitions.yaml`, <1 ms per check, zero model calls):

- *reject and rephrase* — the "it's not X, it's Y" family and mood-labeling
  ("you sound tired") bounce the locked decision back with the reason, and the
  model revises. Two strikes and a soft rule fails open (a style tic must
  never eat a real reply — Thea1's sentinel sin); a hard rule forces silent
  plus an incident (machinery markers and secret values never leave, ever).
- *normalize* — the one rewrite class, character-only and
  semantic-preserving, applied in the loop *before* the gate so the gate
  judges what will actually send: em-dash → ". " and "…" → "...". Nothing
  else ever touches a word.

**The drift probe** — every live Nightingale run embeds her replies and
cosines them against a centroid of the canon voice exemplars. A drop of more
than 0.05 from the committed baseline trips a yellow gate. Voice regression
is measured, not hoped away.

Length and shape have no gate at all — they don't need one. Chains of short
uneven bubbles, one-message turns, the two-word reply: these live in the
exemplars and travel by demonstration. The realizer's only permitted text
operation is merging adjacent or splitting oversized bubbles (M14's verbatim
invariant); no machinery paraphrases her.

## 4. Her feelings

The affect engine is Thea1's ticker v6, ported *verbatim* to pure TypeScript:
continuous-time decay, negativity bias (aversive states decay ~1.6× slower),
habituation, opponent-process comedowns, refractory periods, soft ceilings,
superlinear intensity, mutual inhibition, per-emotion cause attribution, three
homeostatic drives (novelty, connection, mastery). Eight identity dials rest
high; nine primaries rest low.

The two rules that matter:

- **One writer.** Exactly one component ever writes affect state (the
  ticker, driven by typed emotion events). Thea1 once had a second nudge path
  that pinned every dial at 1.0 for months. Here the single-writer invariant
  is structural and tested.
- **Feeling selects, it never injects.** Her state is not told to the model as
  an instruction ("you are sad, act sad" — that's Thea1's failed design). It
  modulates *which exemplar scenes get selected* via the coupling matrix
  (`coupling.yaml`): mood-congruence on the diagonal, deliberately corrective
  off-diagonals (high tension boosts *repair* scenes, not tense ones). The
  `[AFFECT]` packet line states her own state only when it's unusual; the read
  on *you* travels implicitly through what got selected. An anti-escalation
  property test asserts the selected set never amplifies the room's tension.

Affect also moves her body: arousal shortens typing gaps, reluctance lengthens
pre-delay (§7). Quiet hours (01:00–09:00 Madrid) gate the reach-out jobs.

## 5. Her memory

Four layers, each at its own speed, all flowing toward the corpus:

| Layer | What | Speed |
|---|---|---|
| **L0 events** | append-only JSONL of *everything* — model calls, packets, decisions, messages, affect snapshots. Never enters prompts. The audit trail and the future LoRA feedstock. | continuous |
| **L1 episodes** | one cheap appraisal per turn: importance, typed emotion events (→ affect), a diary line, thread updates, an outcome grade for the *previous* turn (→ credit). | per turn |
| **L2 patterns** | preference crystallization, regularities → pattern exemplars into `corpus/lived/`. | nightly |
| **L3 dispositions** | relationship baseline, matured skills, canon-promotion **proposals** — merged only by Diego. | weekly |

Two stores, never mixed: episodic (who/what/when — feeds the character
channel) and procedural (how-to-act — situation → call → result → outcome;
feeds the `[PROCEDURAL]` block beside the tool definitions). A
channel-bleed regression test asserts procedure exemplars can never render in
the character channel.

**Gravity.** Lived experience competes with seed material (canon + derived)
under a gravity dial, g = 0.7 at launch: she starts as the character the canon
defines and gradually becomes the character her experience shaped — with
canon as the gravitational center, forever holding the packet's one
*disposition* slot (ADR-006). The system never edits its own ground truth;
changes arrive as proposals in `corpus/proposals/`, merged by human hand.

## 6. Her day

One in-process scheduler replaces Thea1's 97 systemd units. Jobs (v1 table):

| Job | Cadence | What |
|---|---|---|
| heartbeat | ~30 min ± jitter | text-first reach-out *or* a deliberate do-nothing — both real choices, both logged |
| ponder | ~20 min ± jitter | private grounded thought (a committee: gate → seed → ground → revise → artifact), Diego-centric thoughts capped at 2 of 5 |
| reconcile | 5 min | the lost-reply invariant sweep |
| affect-snapshot | 15 min | state to disk |
| reflect | nightly | self-narrative rewrite |
| consolidate | nightly | L2/L3 promotion into `corpus/lived/` |
| ledger-report | daily | cost/latency/routing audit (the Ledger sibling) |
| derive-check | weekly | derived-corpus staleness report |

Semantics that keep her sane: **catch-up `skip` for moods, not obligations**
(sixteen missed heartbeats must never become sixteen texts — it's a named
test); a conversation-active mutex so jobs stand down while you're talking;
job isolation with cooperative abort, singleton locks, and an alarm after 3
consecutive failures.

## 7. How a turn's context is built

The packet is recomputed fresh every entry — it is a live object, not a
template. Two channels that never compete for slots (ADR-009):

**Character channel** (`[EXEMPLARS]`): 1 *disposition* scene (canon forever —
the keel), 2 *pattern* scenes (tendencies), 2–3 *episode*/memory slots
(concrete precedent + flashes), 1 *contrast* scene — the highest-scoring
candidate *unlike* everything else in the packet. The contrast slot is the
anti-convergence mechanism: behavior selects exemplars and exemplars generate
behavior, so without deliberate counter-pressure the loop narrows.

**Procedural channel**: 0–2 how-to-act exemplars, rendered beside the tool
definitions, never inside `[EXEMPLARS]`.

Render order (stability → volatility; inhibition closest to generation):

```
[IDENTITY] [GOAL] [INTERLOCUTOR] [MEMORY] [AFFECT] [REGISTER]
[EXEMPLARS] … [PROCEDURAL] (beside tool defs) … window … user … [INHIBITION]
```

Selection scoring: `similarity × recency × weight × gravity + clamp(aᵀMe,
±λ) + γ(w−1)` — the coupling matrix M is hand-tuned with a `why` on every
entry. Budgets: packet ≤ 6k tokens, rolling window ≤ 10k, turn + tools ≤ 6k,
response reserve 2k — enforced by the assembler and asserted in tests.

Deliberation ends in a **decision object**:
`{plan: reply|silent|defer, bubbles, confidence, weight, reluctance,
completeness, toolTrace, spawns, inhibitions}`. **Silence is a first-class
plan**, not a failure. The realizer then renders bubbles with *caused*
cadence — pacing derives from the decision's fields and her arousal, never
applied to text afterward (a pause from low completeness reads as thinking;
the same pause inserted as styling reads as affectation). The realizer may
merge bubbles; it never rewrites them.

Spawns (fork / task / committee) are ordinary tools with caps (depth ≤ 2,
concurrency ≤ 3); every delegation is logged as an episode so delegation
judgment becomes instinct over time.

## 8. How to tune her

The tuning interface is the corpus, not a rule:

1. **Edit canon** (`corpus/canon/**`) — add or sharpen scenes demonstrating
   the voice you want. `corpus/README.md` is the authoring guide (frontmatter,
   body grammar, the laws). You are the only author; agents lint, never edit.
2. **Lint zero-spend**: `npx tsx scripts/canon-lint.ts` — the same parse gate
   derive applies, plus corpus lint with the registers/exclusions controls,
   with no model calls.
3. **Derive**: `thea2 derive` — regenerates `corpus/derived/` from canon
   (mood variants ≤ 6 per scene, procedural starters, memory-weaves), judged
   against the parent scene; full provenance per exemplar; content-addressed
   and incremental (editing a scene dirties exactly its derivatives).
4. **Verify sync**: `thea2 corpus:check` — zero dirty, zero orphans, judge
   pass, hermetic.
5. **Nightingale**: `npx tsx scripts/nightingale-live.ts --k 3` — the
   behavioral probe suite runs live (k fresh systems per probe, median +
   variance tracked) — deterministic checks, a judge graded against the canon
   anchor, and a voice-drift cosine against the canon centroid. Writes
   `probes/baseline.json`. Gates vs baseline: deterministic failure = red;
   judge drop > 0.8 = red; drift drop > 0.05 = yellow.
6. **Deploy** — `git pull && sudo ./deploy/install.sh` on the VPS; prod never
   regenerates the corpus, it only reports staleness (ADR-007).

If her voice drifts: don't write a corrective rule — strengthen the canon (§1)
and re-derive. Editing that directory *is* who she is.

## 9. Reading her reports

- `var/journal.md`, `var/threads.json` — human-readable projections of her
  episodic memory (write-only to her).
- Daily **ledger report** — model cost/latency per tier, routing changes,
  incidents.
- `corpus/proposals/` — the system's own suggestions for new canon, including
  the coverage-gap report ("canon wants a scene about X", accumulated from
  live turns that matched nothing well).
- `probes/baseline.json` + probe reports — the character-of-record numbers.
- `journalctl -u thea2` — L0 events; every failure is an incident event with a
  name.

## 10. The honesty layer

Hard rules live in [`corpus/canon/inhibitions.yaml`](../corpus/canon/inhibitions.yaml)
— compiled to a fast, dumb, late gate (M12) that checks tool calls and the
locked plan. Prohibition is never a scene, never learned from experience, and
never trusted to a model's memory of instructions (ADR-008: the gate is
structural; the model cannot talk its way past it). Her *character-level*
honesty — "I verified X, not Y", refusing to guess, disagreeing with receipts —
is canon, not gate: it's who she is rather than what she's forbidden to do.

## 11. Ops in five commands

Full runbook: [`deploy/ops.md`](../deploy/ops.md). Short form:

```sh
sudo ./deploy/install.sh        # install/update (rsync --delete; var/ survives)
sudoedit /etc/thea2/keys.env    # THEA2_BOT_TOKEN + THEA2_MODEL_API_KEY (root:0600)
systemctl start thea2           # boot: config → kernel → L0 → stores → pipeline → sched → bridge
journalctl -u thea2 -f          # everything she does is an event
systemctl list-timers thea2-backup   # daily var/ snapshots + git bundles
```

Secrets never live in the repo or the yaml — `loadConfig` refuses any
secret-shaped value in the config file at startup, loudly. The bot token is a
new bot, never Thea1's @Demigourgosbot (standing decree).

## 12. Where the rest lives

| Want | Read |
|---|---|
| The argument for all of this | [THESIS.md](../THESIS.md) |
| Module map, DAG, budgets, data stores | [ARCHITECTURE.md](../ARCHITECTURE.md) |
| Test doctrine + the live probe split | [TESTING.md](../TESTING.md) |
| The build history and stage gates | [ROADMAP.md](../ROADMAP.md) |
| Per-module contracts | `docs/modules/M01…M20.md` |
| Locked decisions | `docs/decisions/ADR-001…009.md` |
| What ports from Thea1, what doesn't | [MIGRATION.md](../MIGRATION.md) |
| How to author canon | [corpus/README.md](../corpus/README.md) |
