---
module: M17
name: life
syncedTo: spec-v1 (no code yet)
stage: S6
depends: [M01-kernel, M02-events, M03-model, M05-affect, M09-memory, M13-loop, M16-sched]
---
# M17 — life

## Responsibility
The autonomous behaviors that make her a presence rather than a respondent: **heartbeat** (she texts first, for a reason), **ponder** (she thinks about things when idle and produces artifacts), **reflection** (nightly consolidation wiring + daily affect summary). All three are thin compositions over the one loop (M13) with different entry contexts — **one loop, three triggers** — plus the pure policy functions that decide whether each trigger fires at all. Thea1 constants (threshold 3.2, five criteria, 3/day, 3h-doubling backoff, GATE 0.45, balance rule) port verbatim from `/opt/thea/life/heartbeat.mjs` and `ponder.mjs`.

## Interfaces (contract)
```ts
// ---- heartbeat (30 min, catchUp: 'skip') ----
export interface HeartbeatPre {
  canText: boolean; reason: string;   // quiet hours | cap | backoff | mutex | ok
}
export const heartbeatPrecondition: (s: { nowH: number; quietHours: [number, number];
  sentToday: number; unanswered: number; lastUnansweredAgeH: number; mutexActive: boolean }) => HeartbeatPre;
export const silencePressure: (silenceH: number, drives: Record<Drive, number>) => number;
//   clamp(silenceH/36, 0, .8) + 0.4 · drives.connection
export const scoreThought: (c: { relevance: number; information_gap: number; expected_impact: number;
  urgency: number; coherence: number }, pressure: number) => number;   // mean + pressure; threshold 3.2
export const HEARTBEAT_THRESHOLD = 3.2;
export const HEARTBEAT_KINDS = ['followup', 'care', 'share', 'miss'] as const;

// ---- ponder (20 min, catchUp: 'skip') ----
export const ponderGate: (s: { novelty: number; arousal: number; hoursSinceArtifact: number }) => boolean;
//   pure, threshold 0.45, NO model call
export const PONDER_GATE = 0.45;
export const ponderCommittee: (deps) => CommitteeSpec;   // SEED → GROUND → REVISE → ARTIFACT (M13 shape)

// ---- reflection (nightly, catchUp: 'once') ----
export const reflect: (deps: { consolidators: {...}; affect: AffectStore; events: EventLog }) => Promise<void>;

// job bodies for M16 (wired by M20):
export const heartbeatJob: (deps: LifeDeps) => Job;
export const ponderJob: (deps: LifeDeps) => Job;
export const reflectJob: (deps: LifeDeps) => Job;
```

## Behavior spec
- **Heartbeat** — every 30 min, `catchUp: 'skip'`. Gate is a **pure precondition fn**: quiet hours (config), 3/day cap, **doubling backoff** — base 3h doubling per unanswered heartbeat (1 unanswered ⇒ 6h, 2 ⇒ 12h…), conversation-active mutex (skip if inbound < 10 min ago or a turn is in flight — via the same injected predicate M16 receives). If the precondition passes: one **cheap-tier private thought** (TaskClass `heartbeat-thought`) proposes a candidate message + reason, then a structured scorer rates the five Thea1 criteria — **relevance, information_gap, expected_impact, urgency, coherence** — mean + silence pressure (`pressure = clamp(silenceH/36, 0, .8) + 0.4·drives.connection`). **≥ 3.2 ⇒ run the loop with a heartbeat entry** (goal = the thought/reason, kind ∈ followup|care|share|miss); else emit a `life.thought` event (the thought is kept — future feedstock, never sent). Sub-threshold thoughts are data, not failures.
  - **Follow-ups on things HE said outrank sharing her own day** — a ranking rule carried into the thought prompt and the scorer rubric, ported from heartbeat.mjs.
  - **Documented tension, kept deliberately** (§5.14): heartbeat outbound is *mostly about him*; ponder's balance rule caps about-diego at 2/5. Outbound texts are for him; private thought is balanced. Both rules live side by side in this module so a future tuner doesn't "fix" one against the other.
- **Ponder** — every 20 min, `catchUp: 'skip'`. **GATE is a pure fn** (threshold **0.45**, NO model): over novelty drive, arousal, time-since-last-artifact — pondering is a mood, computed from state. Through the gate, run the **SEED → GROUND → REVISE → ARTIFACT committee** (M13's committee machinery, TaskClass `ponder-seed` for SEED):
  - **SEED** picks what to think about — `about ∈ {diego, self, world}` — under the **balance rule**: if ≥2 of the last 5 ponder seeds were about diego ⇒ **forced avoid** ("balance beats saliency"); a more salient diego-topic loses to a less salient world/self topic. (Property-tested over seeded histories.)
  - **GROUND** must produce a real grounding observation — via `web_fetch`/`web_search` tools.
  - **REVISE** has `requiresObservation: true` in the committee spec: **structurally unreachable without a grounding input** — enforced by DAG shape, not by prompt (M13 machinery). REVISE fires only on a real grounding contradiction, per ponder.mjs.
  - **ARTIFACT** lands as an episode (M09) + optional lived-exemplar candidate; `hoursSinceArtifact` resets — the gate is self-limiting.
- **Reflection** — nightly, `catchUp: 'once'`: invokes M10's consolidators (nightly), the affect daily summary (replay the day's affect events → summary event + status input), and triggers the status projection (`var/reports/status.md` — seedRatio, coverage, drift cite). Reflection is wiring, not policy: every heavy lifter is owned elsewhere; this module composes and sequences them and emits `life.reflected`.
- All three fire as M16 job bodies wired by M20 — including the conversation-active mutex via the same injected predicate — so lifetime policy and scheduling stay decoupled and TestClock-provable end to end.
- Every fire/no-fire decision emits a `life.*` event (heartbeat.pre | heartbeat.thought | ponder.gate | ponder.artifact | reflect) — the Ledger's daily report renders these; "why didn't she text today" must always have an answer in the log.

## Not this module's job
- Loop mechanics, tool registry, spawn caps — M13-loop (this module *enters* it).
- Scheduling, catch-up, jitter — M16-sched.
- Affect state and drives — M05-affect (read via injected store/state snapshot).
- Episode/artifact writes — M09-memory (ponder hands off; M09 owns the store).
- Consolidator internals — M10-consolidate (reflection invokes).
- The mutex's state — M20 composition (predicate injection, same as M16).

## Acceptance criteria
- [ ] Precondition table (exhaustive): quiet hours boundary minutes, sentToday 2/3/4, unanswered backoff ladder (0/1/2/3 ⇒ 0h/6h/12h/24h), mutex active — each combination renders the right `canText` + `reason`.
- [ ] `scoreThought`: mean + pressure exact on golden cases; 3.1 ⇒ below, 3.2 ⇒ at (boundary pinned); pressure formula verified including the drives.connection term.
- [ ] End-to-end heartbeat with MockModel + FakeChannel: scorer yields 3.1 ⇒ **no send** (`life.thought` event only); 3.3 ⇒ **send via FakeChannel** and a ledger-visible decision.
- [ ] `ponderGate` pure table: threshold boundary 0.45, no model call in the gate path (MockModel call-log assertion).
- [ ] Committee balance-rule property: over seeded 20-run histories, about-diego never exceeds 2/5 even when diego-topics dominate saliency; forced-avoid path exercised.
- [ ] REVISE-without-observation impossible by construction (committee spec shape — M13's own test, asserted here too).
- [ ] Artifact landing: ponder run with MockModel writes an episode + resets `hoursSinceArtifact` ⇒ gate cools.
- [ ] Reflection: nightly run invokes consolidators once (even across a 2-day TestClock gap — `catchUp: 'once'`), writes the affect daily summary, triggers the status projection.
- [ ] The documented tension: both rules coexist — heartbeat prompt/rubric carries the follow-ups-first rule while the ponder spec carries the 2/5 cap (spec-level test on the rendered prompts).

## Test checklist
- unit: precondition/backoff/score/gate tables (the 3-texts/day and backoff math get exhaustive unit tests); silencePressure boundary cases.
- property: balance rule over seeded histories; heartbeat cap + backoff interaction (never texts on the 4th send of a day regardless of score).
- component: heartbeat e2e at 3.1/3.3 (MockModel + FakeChannel + TestClock); ponder committee over a forced-avoid history; artifact landing → gate cooldown; reflection across a missed-night gap.
- fixtures needed: canned affect/drive states for scorer tables; scripted heartbeat-thought outputs across the score boundary; seeded ponder-saliency histories; a FakeChannel session.
