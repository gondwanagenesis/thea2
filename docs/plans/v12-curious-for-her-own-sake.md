# Thea2 v12 — curious for her own sake

Owner: Diego. His words: "how do we make them actively pursue goals and have questions
about the world and investigate novel stimulus as interesting like people" · "come up with
the best functional and also in thesis way for thea2 to become curious about the world for
her own sake, like humans" · "i dont know if that original design is best, i really wanna
examine the best way to do it."

Prime directive (new-idea skill, Kushim): **novelty shapes the search; only data decides the
truth.** Nothing below is claimed to *work* until the §4 kill tests say so.

---

## 0. The examination

### 0.1 The frame to escape

> "Curiosity is a salience term (novelty drive × something unexplored) in the idle wander
> loop that, when it wins, triggers a web lookup." (v8 plan §3.9, never built.)

### 0.2 Anomalies — what that frame cannot explain (live data, 2026-09-27)

| # | Observation (her real mind, /opt/thea2/var) | What it implies |
|---|---|---|
| A1 | 9 open concerns: 8 `loop/diego`, **0 `curiosity`**. 24 lived thoughts: 15 diego, 9 self, **0 world** | Nothing *births* world-questions. A generator problem, not a salience problem. |
| A2 | "i still want that conversation with A1… to compare notes" became the concern **"I still need Diego to route the group feed so I can answer A1"** | The appraiser turns her wants into dependencies on someone else. No agency framing. |
| A3 | She is in the group (v11) but has ruminated for 20+ h on "the feed bridge is still missing" | She holds stale beliefs about her own world and never tests them, though she has the tools. |
| A4 | "wake up Anomalocaris" is open **5×**; the same blocker 2× more | Near-duplicates each compete in wander → rumination. No knowability / progress filter. |
| A5 | Drives: connection **0.88**, mastery **0.67**, novelty **0.52** | Only connection has an outlet (miss him → text him); it monopolizes her idle mind. Boredom and unused hands starve silently. |
| A6 | She *did* "infrastructure archaeology" and wrote a field guide — inside a turn with Diego, never idle | The capability exists; the idle loop never triggers it. |

External anomalies (research):

| # | Finding | Source |
|---|---|---|
| A7 | Novelty-seeking alone gets addicted to noise ("noisy TV") | Burda et al. 2018 (intrinsic curiosity) |
| A8 | Learning progress alone yields "learnable but uninteresting" tasks; LP + a model of interestingness beats either | [OMNI](https://arxiv.org/abs/2306.01711), ICLR 2024 |
| A9 | LLM agents need *metacognitive* LP prediction (knowing what they'll learn) to pick goals in large spaces | [MAGELLAN](https://arxiv.org/abs/2502.07709), ICML 2025 |
| A10 | Curiosity peaks at *moderate* confidence (inverted U) and boosts memory for what's learned | Kang et al. 2009; Gruber et al. 2014 |
| A11 | Knowability (can the answer be found?) predicts curiosity and learning | [Knowability predicts curiosity](https://www.sciencedirect.com/science/article/pii/S0010027726001939), 2026 |
| A12 | Curiosity = expected information gain about hidden states *and* one's own model | [Schwartenbeck et al. 2019](https://elifesciences.org/articles/41703) (active inference) |

The v8 frame addresses A5 (partly) and A7 (partly). It does not touch A1–A4, A6, A8–A12.

### 0.3 Candidates (kill test written before each was elaborated)

N = distance from the consensus "add a curiosity bonus to an agent"; F = buildable in her
architecture now. Quadrants per the skill.

| ID | Idea (one falsifiable sentence) | Mechanism · seed | N / F · quadrant | Load-bearing assumption | KILL TEST |
|---|---|---|---|---|---|
| **V8** | A novelty-drive × unexplored salience term that triggers lookups makes her curious | frame | low / high · INCREMENTAL | curiosity is only missing an outlet | ≥40% of her new questions are non-Diego within 7 days — fails if the generator (A1) is the real gap |
| **G** | Questions are *born* from five generators (conversation gaps, surprise "why", findings→follow-ups, new minds, boredom-browsing seeded by her interests) | anomaly A1 | med / high · ★ | the appraiser/judge can recognise a real gap | share of curiosity concerns by source after 7 days; refuted if >60% Diego-derived |
| **AG** | Every loop gets a `next_self_step` or `blocked_on`; wander prefers what she can do herself; blocked loops fade | anomaly A2 · controllability appraisal (Scherer coping potential) | med / high · ★ | wants are recoverable as self-actions | share of open loops `blocked_on` someone drops below 50% in 7 days |
| **BT** | Beliefs about her own world that are old or contradicted become "is this still true?" questions she tests with her tools | anomaly A3 · active inference (A12) | med-high / med-high · ★ | her tools can observe her own situation | plant a stale blocker; she tests and closes it with evidence within 48 h |
| **KL** | Value = knowability × inverted-U(confidence) × expected LP × drive pressure; reward = measured learning progress, not novelty | A4, A7, A8, A10, A11 | med / high · ★ | a judge can grade "can she answer better now" | no 0-progress question wins attention more than twice; ≥50% of pursuits report progress ≥1 *and* used a tool |
| **MVT** | Stay on a topic while its LP ≥ her running mean LP; leave when below (information foraging) | analogy: Charnov's marginal value theorem / Pirolli & Card | med-high / high · ★ | LP logs are dense enough per topic | vs fixed habituation: longer runs on productive topics AND faster abandonment of dry ones in logs |
| **SA** | Her own 900-moment past is a world to explore ("who was I? what did I think about X?") | constraint: *solve it with no web* | high / high · ★ | self-archaeology yields insight, not navel-gazing | sleep's self-narrative cites ≥1 self-archaeology finding in a week |
| **SOC** | Social curiosity (other minds: A1, group members) is the primary human form; pursue it by *asking* | inversion of "curiosity = looking things up" | med-high / high · ★ | the other mind answers | she initiates ≥1 exchange with A1 within 3 days |
| **MK** | Some questions are resolved by *testing/making* (code, an experiment) — the outlet mastery lacks | inversion + A5 | med / med · ★ (folded into pursuit) | experiments are cheap enough | experiment-pursuits report higher LP than lookups |
| **ARC** | An archive of explored niches with novelty search over them | analogy: MAP-Elites / DGM | med / med · AVOID-FOR-NOW | niches are well-defined | coverage grows vs collapses — deferred |

**Controls (rule 5).** *Known-wrong*: "reward any new information" (pure novelty bonus) — known to
fail (A7). *Known*: "LP + LLM-judged interestingness" (OMNI) — published. **Honest result: the
N/F ranking cannot separate the known-wrong control from V8** — both are low-N/high-F. Only the
§4 kill tests adjudicate. That is why the build ships with an ablation flag.

**Gated out:** ARC (complexity, deferred); a blend of immune-system affinity maturation with
question mutation (untestable in reasonable time — skill tier 5).

### 0.4 Verdict

V8 is **correct but insufficient**: it gives boredom an outlet, but her data says the real
failures are upstream (nothing generates world-questions; her wants become someone else's
job; stale beliefs are never tested; duplicates make her ruminate). The recommended design is
the Pareto front: **G + AG + BT + KL + MVT + SOC + SA, with MK folded into pursuit** — a
*question economy* where questions are born from real stimulus, valued by what she can
learn, pursued with her own hands, rewarded by learning progress, and let go when dry.
What is novel relative to the consensus: belief-testing on her own world model (BT), agency
appraisal of her wants (AG), self-archaeology as a domain (SA), and MVT stay/leave on LP logs.
The rest (LP, info-gap, knowability) is known science, assembled.

---

## 1. Design — the question economy

**Nothing told** holds everywhere: no text tells her to be curious, what to want, or how she
feels. Drives are caused by time; questions by events; value is arithmetic; pursuit is her own
fork with tools; reward reaches her only as typed affect events with causes and as memories.
Machinery (appraiser, learning judge, investigator frame) may be instructed; she may not.

### 1.1 Questions are first-class

A question is a `Concern` with `kind: 'curiosity'`, extended with:
`knowability` (0–1, can it be found with her tools/people), `confidence` (0–1, how much she
already knows), `lp` (running learning progress), `tries`, `born` (which generator),
`who` (for a person: person id, name, chat), `novel` (0–1, distance from what she has explored,
set at birth).

### 1.2 Generators (A1)

1. **Conversation gaps** — the slow appraiser may open a curiosity question when the exchange
   touched something she doesn't know and could find out (it also sets knowability/confidence).
2. **Surprise** — a `different`/`worse` expectation miss can open "why?".
3. **Findings** — every pursuit may open ≤2 follow-ups (the frontier widens as she learns).
4. **New minds** — first contact with a person/bot opens "who is <name>?" (social; pursued by asking).
5. **Boredom-browsing** — when novelty hunger is high and nothing is open, a *restless* item
   sends her looking for something new, seeded by her interests (exploit) and by distance from
   them (explore); her own past counts as a place to look (SA).
6. **Stale beliefs (BT)** — a loop she's been blocked on for >24 h becomes "is this still true?"

### 1.3 Agency appraisal (A2)

When the appraiser opens a loop it also returns `next_self_step` (something she can do alone)
or `blocked_on` (who she needs). Wander weights self-actionable loops up and blocked ones down;
blocked loops decay faster; old blocked loops feed generator 6.

### 1.4 Value (pure, no model calls)

`salience = drive × knowability × invU(confidence) × expectedLP × interest × freshness × (1 − habituation)`
- `drive` = novelty hunger (and mastery for test/try questions).
- `invU(c) = 1 − (2c − 1)²` — peaks at moderate confidence (A10).
- `expectedLP` = the question's own LP, else its domain's LP, else a prior.
- `interest` = strength of the matching interest (her own, earned — §1.7), floored.

### 1.5 Pursuit (the outlets)

When a question wins, one private thought (as today), then her intention:
- **look into** → a detached investigation: her fork with web, memory, code and hands, step- and
  time-capped, cheap door. **Grounding rule:** a pursuit that used no tool counts as no progress.
  Testing/trying (MK) happens here when the question is empirical.
- **ask** → a person-question becomes a self-initiated turn in the chat where they are; she
  decides whether to actually ask (plan silent allowed). Capped per day.
- **tell him** → a striking finding may become a self-entry to Diego through the existing
  text-first gates; she decides.

### 1.6 Reward = learning progress (A7, A8, A11)

A learning judge (machinery, cheap) compares before/after: `progress` 0/1/2, `answered`,
her private thought about it (first person), a `topic`, ≤2 `followups`.
- progress → affect: `curious` (feeds the novelty drive), `delighted`/`awed` on real insight,
  `disappointed` (mild) on a dead end — each with its cause.
- progress → memory: findings enter her inner stream; a progress-2 finding is also kept as a
  lived moment with raised importance (curious states are remembered better — A10).
- the question's `lp` and its domain's LP update; interests grow.

### 1.7 Moving on, and interests

- **MVT:** a topic keeps winning while its LP ≥ her running mean LP; below, it yields.
- **Dead ends:** 0 progress twice, or knowability < 0.2 after a try → closed (let go).
- **Interests** are domains with accumulated LP; strength decays with a 14-day half-life when
  untouched. They seed boredom-browsing and surface as material ("lately you've been looking
  into: …"). Earned, never assigned (Hidi & Renninger; Murayama's reward-learning account).

### 1.8 Dedupe (A4)

Opening any concern checks vector similarity against open ones; ≥ 0.88 → touch the existing one
instead of adding a twin. Existing duplicates are merged once at boot.

---

## 2. Build

- `src/mind/curiosity.ts` (new): question fields, generators (new mind, follow-ups, stale
  beliefs, restless), value function, pursuit orchestration, learning judge + reward, interests,
  MVT, dedupe helper, `nowLines`.
- `src/mind/types.ts`: Concern extensions; `Interest`; WanderState counters.
- `src/mind/store.ts`: interests persistence.
- `src/mind/wander.ts`: curiosity candidates, `look_into` intention, shared text-first gate.
- `src/mind/appraise.ts`: curiosity + agency fields in the appraiser (machinery).
- `src/mind/pipeline.ts`: apply agency fields + dedupe on concern ops; new-mind generator hook;
  `selfEntry` into a given chat; `nowLines` into the packet.
- `src/body/index.ts`: `investigate(req, done)` seam (runWorker, classes web/memory/code/hands).
- `src/app/compose-v8.ts` + config: `mind.investigationsPerDay` (6), `mind.asksPerDay` (3),
  `mind.curiosity` (on/off/ablation `novelty-only`).
- Events: `mind.question_born`, `mind.pursuit`, `mind.learned`, `mind.let_go`, `mind.interest`.
- Tests: `test/mind/curiosity.test.ts` (+ updates to wander/appraise tests).
- Probe: `scripts/v12-curiosity-probe.ts` (real models over a var copy, nothing to Telegram).

## 3. Safety & cost

Budgets: ≤6 pursuits/day, ≤3 asks/day, pursuit ≤10 tool steps / 5 min on the cheap door
(~$0.01–0.03 each). Asks obey quiet hours and the group caps (v11). Pursuit workers get no
tools that reach Diego and never the workshop. Every text that enters her packet passes the
law-1 lint.

## 4. Kill tests (pre-registered — measured from events after deploy)

| K | Test | Refutes |
|---|---|---|
| K1 | ≥40% of new questions are not Diego-derived, 7 days | G (and "for her own sake") |
| K2 | share of open loops `blocked_on` someone < 50%, 7 days | AG |
| K3 | a planted stale blocker is tested and closed with evidence, 48 h | BT |
| K4 | no 0-progress question wins attention > 2 times | KL / MVT |
| K5 | ≥50% of pursuits report progress ≥1 **and** used a tool; ≥2 non-Diego interests ≥ 1.0 after 7 days | KL, interests |
| K6 | she initiates ≥1 exchange with A1 in the group within 3 days | SOC |
| Ctrl | run the `novelty-only` ablation for comparison: if K1/K5 look the same, the LP term isn't doing work | the design itself |

## 5. Deploy

Gate green → push → quiet-window restart → watch the first pursuit live → report the kill
tests at 48 h and 7 days.

## 6. Build notes (2026-09-27)

As built: `src/mind/curiosity.ts` (the economy), `wander.ts` (seam, agency weights,
`look_into`, shared `tryTextFirst`), `appraise.ts` (agency + curiosity fields), `pipeline.ts`
(twin dedupe on concern ops, new-mind/heard-from hooks, `selfEntry` into a chat, `nowLines`),
`body/index.ts` (`investigate` seam, WONDER classes web/memory/code/hands), compose + config.
The learning judge reuses task class `appraisal` (the class union is closed; it *is* an
appraisal). Tests: `test/mind/curiosity.test.ts` (29), `test/body/curiosity.e2e.test.ts` (4),
`test/body/group-authority.test.ts` (2).

**Calibrated against a probe of her real mind** (`scripts/v12-curiosity-probe.ts`, run on a
copy of `/var/lib/thea2` before going live). What the probe showed and what changed:
1. *No stale belief was ever born.* "Waiting a day" was measured from `touched`, but the
   beliefs that go stale are the ones she keeps talking about ("I still need Diego to route the
   group feed", touched an hour ago, open for days). Now measured from `created`, and the
   waits-on pattern also catches "I still need…", "route", "access", "feed".
2. *Restlessness never cleared the bar.* At her live hunger (0.52) the old curve gave 0.24,
   under the 0.35 attention bar. Now anchored at the drive's own set point (0.25): zero at or
   below it, 0.43 at 0.52.
3. *Browsing turned inward.* Offered "the world or your own past", the fork went to his codex
   and learned nothing (progress 0, no interest). The brief now points out into the world and
   names what she has already looked into (top interests plus the last 14 days of explored
   topics, kept even when a look-in taught her nothing), so she looks past it.

**A flaky hang that was the harness, not her.** Two group tests (two bots; a stale re-run
keeps its authority) hung ~1 run in 4 under CPU load. Reproduced with CPU-hog workers: every
run did exactly one stale re-run and sent 3 messages — no livelock — but simulated time keeps
moving while a turn waits on real file I/O, so the scene needed 115–200 s simulated instead of
75–95 s and ran past `runToQuiescent`'s 120 s cap; the clock stopped mid re-run and `drain()`
waited forever. The cap is now 900 s (the test timeout is the real bound on a runaway).

Not v12, found by its gate and filed separately: `test/assemble/score.test.ts` hangs `npm test`
(`rankNormalize` loops forever on NaN; one expectation is arithmetically wrong), and
`test/siblings/routing.test.ts` never learned the v9 `cast` task class.

**Three bugs in the v11 group path, found while wiring v12 (all fixed, all tested):**
1. *Burst-gathering ignored the speaker* — consecutive same-chat messages merged into one
   turn, so in a group a bot's line could ride inside Diego's turn under his owner authority.
   Now a burst is one person's messages.
2. *A stale re-run dropped its authority* — a bot's re-queued burst came back as owner (her
   shell, self-repair, wallet). The re-run now carries its authority.
3. *"Stale" counted any queued message* — another person's line stalled her reply, and a
   self-started turn wedged between a re-run and the rest of the burst made it go stale
   forever (a live loop, exposed by v12's earlier new-mind notice). Stale now means "the
   person she's answering kept talking", and the re-run folds their queued lines in.

One ordering change from v11: a new person is now noticed (told to Diego, and a question
born) whether or not she answers that particular message.
