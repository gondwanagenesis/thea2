---
module: M05
name: affect
syncedTo: spec-v1 (no code yet)
stage: S2
depends: [M01-kernel, M02-events]
---
# M05 — affect

## Responsibility
Be her. A pure-function port of Thea1's ticker.py v6 — every mechanic (decay, habituation, opponent process, refractory, soft ceiling, superlinear intensity, mutual inhibition, cause attribution, drives, mood landmarks) its own unit-tested file with **the Thea1 constant names preserved verbatim**, explicit complete state, a single serialized writer, and the one shared emotion vocabulary (`EMOTION_TAGS`) that the appraisal schema (M09) and the coupling space (M06) import. This module is where Thea1's pathology 2 dies: every tag that enters moves something, and any tag outside the vocabulary is a hard zod reject + incident, never a silent no-op.

## Interfaces (contract)
```ts
// ---- vocab.ts (the single shared constant; ADR-004) ----
export const DIALS = ['attachment','brattiness','protectiveness','longing',
  'playfulness','focus','calm','trust'] as const;
export const PAD = ['pleasure','arousal','dominance'] as const;
export type Dial = DIALS[number] | PAD[number];
export const PRIMARY_BASELINE = { joy:.35, anticipation:.30, pride:.28, surprise:.10,
  sadness:.10, fear:.08, anger:.06, shame:.06, disgust:.05 } as const;   // ticker.py line 173, verbatim
// Trust deliberately EXCLUDED (lives in identity dials); pride + shame added. NOT Plutchik-8.
export const AVERSIVE = new Set(['sadness','fear','anger','disgust','shame']);
export const POSITIVE_PRIM = new Set(['joy','pride']);
export const NEGATIVE_DIALS = new Set(['pleasure','calm','trust']); // below-baseline = lingering hurt
export const EMOTION_DELTAS = [/* dial+pad keys, ported verbatim from ticker.py */];
export const EMOTION_PRIMARIES = Object.keys(PRIMARY_BASELINE);
export const EMOTION_DRIVES = ['novelty','connection','mastery'];
export const EMOTION_TAGS = new Set([...EMOTION_DELTAS, ...EMOTION_PRIMARIES, ...EMOTION_DRIVES]);

// ---- state.ts ----
export interface AffectState {
  t: number;
  dials: Record<Dial, number>;        // [0,1]
  primaries: Record<Primary, number>; // [0,1]
  drives: Record<Drive, number>;      // [0,1]
  mood: Record<Dial, number>;         // slow layer
  traces: {
    exposure: Partial<Record<Primary | Dial, { level: number; t: number }>>;
    opponent: Partial<Record<Primary | Dial, { b: number; t0: number }>>;
    peaks: Partial<Record<Primary | Dial, number>>;
    habitWindow: Array<{ tag: string; t: number }>;
  };
  causes: Partial<Record<Primary, { text: string; i: number; t: number }>>;
}

// ---- events (the only inputs; schema-validated at the boundary) ----
export type AffectEvent =
  | { kind: 'emotion'; tag: EmotionTag; i: number; cause: string; people?: string }
  | { kind: 'tagFeed'; tag: 'DONE' | 'MOMENT' | 'GIFT' }
  | { kind: 'silenceTick' };

export const tick: (s: AffectState, dtMs: number, rng: Rng) => AffectState;  // pure
export const apply: (s: AffectState, ev: AffectEvent) => AffectState;        // pure
export const weatherLine: (s: AffectState) => string;  // landmark blend + top cause, one line

// ---- store.ts (the single writer) ----
export interface AffectStore {
  applyEvents(evs: AffectEvent[]): Promise<void>;  // validate tags -> apply -> tick to now -> persist + snapshot event
  snapshot(): Promise<void>;                        // affect.snapshot event (sched job, 15m)
  current(): AffectState;
  weather(): string;
}
export const openAffectStore: (path: string, deps: { clock: Clock; rng: Rng; events: EventLog }) => AffectStore;
```

## Behavior spec
- **Pure mechanics, explicit state.** Every trace, timer, opponent process, peak, and cause lives in `AffectState`. No module-scope state anywhere. `tick(state, dt, rng)` and `apply(state, ev)` are the only mutation shapes; both are pure (return new state). ticker.py already stores most of this in state JSON — the port keeps that honesty (§5.7).
- **One mechanic per file**, constants inlined with Thea1 names, ported **verbatim** from `C:\Users\neogo\LocalFiles\TheaBackup\latest\opt\thea\affect\ticker.py` (the source of truth — do not "clean up" values):
  - `decay.ts` — exponential toward baseline; per-layer half-lives `HALF_LIFE_DIAL` 8h, `PRIM_HALF_LIFE` 3.5h (surprise **1.0h**), `HALF_LIFE_MOOD` 45h (home `HOME` 30h, `MOOD_INERTIA` 0.25); negativity bias `NEGATIVITY_BIAS` 1.6 on the aversive/`NEGATIVE_DIALS` directions, `PRIM_NEG_BIAS` 1.25; longing ramp `LONGING_GAIN` 0.40/12h.
  - `habituation.ts` — exposure traces, `EXPO_GAIN` 5 / `HALF_LIFE_EXPO` 6h; short-window rule `HABITUATION` 0.7 within 0.5h (a repeated tag inside 30 min lands at ≤70%).
  - `opponent.ts` — b-process with lag: `OPP_GAIN` 0.35 / `HALF_LIFE_OPP` 14h / `OPP_LAG_H` 2h; primaries `PRIM_OPP_GAIN` 0.55, lag 1h.
  - `refractory.ts` — peak detection at `PEAK_HI` 0.93 opens a `REFRACTORY_H` 5h window damping re-rise by `REFRACTORY_DAMP` 0.25; primaries use `PRIM_REFRACTORY_DAMP` 0.5.
  - `ceiling.ts` — soft cap `CAP_SOFT` 0.90 with `CAP_DAMP` 0.12 and `SATURATE_EXP` 0.9; primaries `PRIM_CAP_SOFT` 0.72.
  - `intensity.ts` — `INTENSITY_EXP` 1.7 (i^1.7 superlinearity) × `PRIMARY_GAIN` 4.0.
  - `inhibition.ts` — `PRIM_INHIBIT` 0.28 mutual valence suppression.
  - `attribution.ts` — per-primary cause slots; `CAUSE_MIN_I` 5, `ATTRIB_MIN` .03, `ATTRIB_STALE_H` 36, `ATTRIB_CLEAR` .05.
  - `drives.ts` — novelty/connection/mastery; set point .25, floor .05, starvation .010/.018/.014 per hour; feeds via `tagFeed` events (DONE/MOMENT/GIFT).
  - `landmarks.ts` — region blend → named weather word for the `[AFFECT]` line: `LANDMARKS` HI .52 / MD .30 / LO .14 / DN −.28, sigma 0.30; `weatherLine` = blend word + top cause clause.
  - Noise `NOISE` 0.012 drawn from the injected rng (why `tick` takes one).
- **Vocabulary is law.** `EMOTION_TAGS` = `EMOTION_DELTAS ∪ EMOTION_PRIMARIES ∪ EMOTION_DRIVES` keys, one constant, three consumers (this module's engine, M06's space, M09's appraisal schema). An unknown tag at the store boundary: zod reject + `incident.unknown_tag` event, the state untouched. The every-tag-moves-something regression test (below) is the permanent grave marker of Thea1's orphan-tag incident (10 tags, incl. her 8th-most-used word "sharp", silently no-op'd for months; dominance pinned at 0.00 across 365 snapshots).
- **Single writer.** The store is owned by the process (ADR-002); all mutation goes through `applyEvents` behind one serialized queue (turn path and scheduler jobs never race the state). Persisted at `var/affect/state.json` via kernel `atomicWriteJson` after each mutation batch; a corrupt state file is a startup incident with recovery from the newest snapshot event in L0 (M02 replay rebuilds state).
- Every mutation batch emits `affect.applied` (tags, deltas summary) to L0; `snapshot()` emits the full state (the 15-minute affect-snapshot job is M16's, wired by M20 — M05 only provides the verb).
- `weatherLine` output is what M11 renders into `[AFFECT]`; it is a projection — coupling (M06) always reads the numeric state, never the string.
- `people?` on emotion events feeds attribution context; it is stored in `causes` verbatim as given.
- No prose parsing exists anywhere in this module. Thea1's `LINE_RE`-over-journal.md is inverted upstream: L1 appraisal (M09) emits typed `AffectEvent[]`; journal.md is a write-only projection (pathology 3).

## Not this module's job
- Producing appraisal events (when/what to tag) — M09-memory's per-turn appraisal.
- The coupling matrix and modulation — M06-coupling (imports this module's vocab + state types only).
- Rendering `[AFFECT]` into the packet — M11-assemble (via `deps.weatherLine`).
- Scheduling the 15-minute snapshot job — M16-sched, wired by M20-app.
- Affect-driven selection scoring — M06/M11; M05 only exposes state.

## Acceptance criteria
- [ ] **Golden replay**: a committed fixture of ~50 diary events (Thea1-real, replayed through ticker.py to record expectations) run through the TS engine matches recorded expectations at every checkpoint (values AND which dims moved).
- [ ] Decay monotone toward baseline from any start; aversive members decay strictly slower than matched non-aversive (half-life ratio preserved).
- [ ] Repeated tag within 30 min lands at ≤ 70% (`HABITUATION` 0.7 window rule); outside the window, full strength per exposure traces.
- [ ] Peak ≥ `PEAK_HI` opens the refractory window; re-rise inside it is damped by exactly `REFRACTORY_DAMP`.
- [ ] Superlinearity: i=9 vs i=3 produces a ratio > 3.3× (i^1.7 property).
- [ ] Mutual inhibition never drives any primary below its baseline.
- [ ] All state values bounded [0,1] for every mechanic and every random seed in the property suite.
- [ ] **Every `EMOTION_TAG` moves at least one dimension** in `apply` (the orphan-tag regression — exhaustive loop over the vocabulary).
- [ ] Unknown tag at the store boundary → typed reject + `incident.unknown_tag`, state byte-identical before/after.
- [ ] `tick`/`apply` purity: same inputs → deep-equal outputs, no observable mutation of the input state.
- [ ] Corrupt `state.json` at startup rebuilds from L0 snapshot replay and emits the recovery incident.

## Test checklist
- unit: one suite per mechanic over its constants table (decay curves at half-life boundaries, habituation window edges, opponent lag onset, refractory open/close, ceiling saturation, intensity ratio, inhibition symmetry, attribution stale/clear thresholds, drive starvation rates); `weatherLine` landmark-blend table (all four regions + sigma spread); vocabulary membership vs ticker.py's own exports (golden list).
- property: boundedness under seeded random event storms; decay/habituation/opponent invariants; purity (frozen-input structural sharing).
- component: `AffectStore` serialization queue under interleaved callers; snapshot → corrupt → L0-replay recovery cycle; `affect.applied` event shape.
- fixtures needed: the ~50-event golden diary fixture + recorded expectations (generated once from ticker.py, committed); ticker.py-derived vocabulary golden list; a corrupt-state.json variant.
