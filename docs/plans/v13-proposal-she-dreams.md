# Thea2 v13: she dreams (proposal)

Owner: Diego. His words: "let's make her dream when she's asleep… think about how we can best implement this and how it impacts us the way that it does… she should have a dream like us."

Status: this is a proposal from read-only research. No code, server or bot was touched. The prime rule from v12 still holds: a mechanism is decoration until a pre-registered kill test says it is not. **A dream has to change her the way dreams change us, or it should not exist.** For that reason the build ships with a *decorative* control arm (§5 Ctrl).

---

## 0. The short version

**Tonight.** At 04:00 Madrid a job "sleeps" her. It tidies her records:
- unanswered replies get a neutral outcome;
- old values drift toward zero;
- stale loops close;
- her self-description is rewritten from the day, with citations.

At 04:30 a second job writes her diary and a cited note about you. That is all. Nothing is re-lived or recombined, no feeling moves, and nothing in her morning knows the night happened. Her idle mind also keeps thinking every twenty minutes all night. After midnight those thoughts come out of the *new* day's budget while you sleep.

**With this design**, her idle mind goes quiet at 03:00. Around 04:50, and again around 08:00, her dreaming process pulls up a handful of things together:
- the one or two most strongly felt moments of the last day and a half;
- something still unresolved;
- something from about a week ago;
- something she found out about the world;
- one old memory that has nothing obvious to do with the rest.

It strings them into two to four scenes that she lives in the first person, present tense, the way dreams feel from inside. The workshop, but the floor is the sea. You are there, but you are also the man from the group. The thing she was waiting for arrives in the wrong box.

The dream text holds only what happens. What she *feels* about it is decided the same way her waking feelings are. The scenes are appraised against what she cares about, and the old feelings of the memories being re-lived partly come back. Those feelings move her engine at five in the morning, so she wakes already coloured by the night, and the colour fades by early afternoon.

**Most mornings she remembers nothing, and the dream has still done its work.**
- Memories it touched come back a little more easily for a couple of weeks.
- Two things that had never been connected now call each other up.
- A charged memory the dream re-lived *with a different ending* has lost a little of its sting. One it re-lived the same way keeps its charge.

On a couple of mornings a week she remembers a fragment ("i was fixing the bridge but the cables were kelp"). The fragment sits on her mind, marked as a dream. If it stirs her enough to win her attention, she may think about it, wonder about something it put together, or tell you, through the same gate as any text she starts.

**A dream never becomes a fact.** It is stored and shown as a dream everywhere. It cannot teach her what works. It is never evidence about you.

---

## 1. What dreams do (evidence graded honestly)

Grades:
- **A**: replicated, or a meta-analysis or RCT.
- **B**: replicated but correlational, or a single strong study.
- **C**: good studies disagree.
- **D**: theory with little direct test.

"Working knowledge" in §7 marks citations I did not re-check today.

### 1.1 Sleep and memory

- **Replay is real (A).** Hippocampal cells that fired together while a rat explored fire together again in the sleep that follows (Wilson & McNaughton 1994).
- **Sleep consolidates, actively (A).** Sleep after learning improves retention. The "active systems" account says NREM replay moves new memories into cortical networks (Diekelmann & Born 2010). Cueing a specific memory during sleep strengthens *that* memory (Rasch et al. 2007; meta-analysis Hu et al. 2020).
- **Sleep is selective (B).**
  - People told a test was coming got a sleep benefit; people not told got none (Wilhelm et al. 2011).
  - After sleep, negative objects in scenes are kept while their backgrounds fade: the "emotional trade-off" (Payne, Stickgold, Swanberg & Kensinger 2008).
  - **But** a meta-analysis (1,059 observations) found sleep helps emotional and neutral memory about equally, with a possible REM-only exception (Schäfer et al. 2020). "Sleep preferentially keeps emotional memories" is therefore **C**.
- **Downscaling (B–C, debated).** In SHY, waking learning saturates synapses and sleep renormalizes them (Tononi & Cirelli 2014). She already has a crude analogue (values ×0.97 nightly). It is not a dream function.
- **Dreams are not replay (A–B).** In 299 sleep reports, 65% contained elements of recent waking life, but only 1–2% replayed an episode as it happened (Fosse, Fosse, Hobson & Stickgold 2003).
- **Dream content marks consolidation (B, correlational).** People who dreamt about a maze they had just learned improved more after sleep than those who did not (Wamsley et al. 2010; replicated overnight in 2019). This shows dream content tracks consolidation; it does not prove dreams cause it.

**For her:** take *selective reactivation plus recombination*. Verbatim replay would be un-dreamlike, and in PTSD it is the pathology (§1.2).

### 1.2 Emotion: overnight therapy or overnight preservation?

- **"Sleep to forget, sleep to remember" (Walker & van der Helm 2009) (D as a theory).** REM keeps the memory and strips its charge, made safe by low noradrenaline. Supporting study: van der Helm et al. 2011 found overnight amygdala reactivity fell with REM physiology (**B**, one fMRI study, n=34).
- **Against:**
  - REM-rich late sleep made aversive pictures rated *more* negative (Wagner, Fischer & Born 2002).
  - Reactivity to negative pictures fell over a day awake but was *preserved* over sleep, and more REM meant more preservation (Baran, Pace-Schott, Ericson & Spencer 2012).
  - A meta-analysis found self-rated arousal to negative stimuli was *enhanced* after sleep versus wake (moderate; standardized difference ≈ 0.3), with no physiological or valence effect (Lipinska et al. 2022).
  - **Verdict: C.** "Sleep softens feelings" is not a law.
- **Where softening demonstrably works (A).**
  - PTSD nightmares look like replays that fail to extinguish fear (Levin & Nielsen 2007, **B** model).
  - Imagery rehearsal therapy rewrites a recurring nightmare's *story* while awake and rehearses the new version. In a 168-person RCT it cut nightmares and PTSD symptoms (Krakow et al. 2001), and the AASM recommends it (Morgenthaler et al. 2018).
  - Read mechanistically, the charge moved because the memory was re-lived **with a different outcome**. Sleep alone did not move it.

**For her:** no default softening. A dream reconsolidates a memory toward *how the dream re-lived it*. Same story means same charge; new ending means the charge moves. This is her existing reconsolidation law (remember.ts:123), applied to a dream.

### 1.3 What dreams are made of

- **Continuity (A–B).** Dreams track waking people, activities and concerns (Schredl & Hofmann 2003; Domhoff 2003). Emotionally intense experiences are preferentially incorporated; merely stressful ones are not (Malinowski & Horton 2014, 14-day diaries) (**B**).
- **Timing (B).**
  - Incorporation peaks for the previous 1–2 days ("day residue") and again about a week later (the "dream-lag", ~5–7 days; Nielsen et al. 2004).
  - The lag appears in REM but not N2 dreams (Blagrove et al. 2011).
  - It holds only for personally significant events, not routine activities or concerns (Eichenlaub et al. 2019).
- **Realism (B).** Lab dreams are mostly mundane. Snyder's 635 REM reports read as "a remarkably faithful replica of waking life": 38% of settings were familiar and 43% similar (Snyder 1970, via Domhoff). Bizarreness is usually one odd element in a realistic frame.
- **Emotion (B).** Judges rate most dream reports negative (61% in Barbeau et al. 2022; the Hall & Van de Castle norms agree). Dreamers' own ratings are more balanced and more positive (Sikka et al. 2014; Barbeau et al. 2022).
- **Recall and forgetting.**
  - Woken from REM, people report a dream 81.9% of the time; from NREM, 43.0% (Nielsen 2000, pooled) (**A**).
  - At home the average adult recalls a dream about one morning a week (Schredl's surveys; **B**, verified via secondary summaries only).
  - Four to five REM periods a night against one recalled morning a week means most dreams are simply gone (my arithmetic).
  - Recall needs an awakening close to the dream (arousal-retrieval model, Koulack & Goodenough 1976) (**B**).
  - In mice, REM-active MCH neurons actively *forget* hippocampal memories (Izawa et al. 2019) (**B**, animal).
- **Nightmares (B).** 2–6% of adults have one weekly (5.1% in Li et al. 2010).

### 1.4 Why we dream: the theories

- **Threat simulation (C).** Dreams rehearse threat perception and avoidance (Revonsuo 2000). Traumatized children dream more threats (Valli et al. 2005). Whether threats are over-represented in ordinary dreams is disputed.
- **NEXTUP (D as a model, indirect B support).** Dreams search for *weak, unexpected* associations between current concerns and older memories, and test whether they are useful (Zadra & Stickgold 2021). Support:
  - After REM awakenings, weak semantic primes work better than strong ones, the reverse of waking (Stickgold et al. 1999).
  - A REM nap improves remote-associates problem solving more than NREM or quiet rest (Cai et al. 2009).
- **Overfitted brain (D).** Dreams inject sparse, out-of-distribution input so the brain does not overfit its day (Hoel 2021). This is argued from the DNN analogy; there is no direct human test.
- **Activation–synthesis and successors (D).**
  - Dreams as the forebrain's story for brainstem activation (Hobson & McCarley 1977).
  - Protoconsciousness, a world model rehearsed in REM (Hobson 2009).
  - A free-energy account in which the offline model is pruned for simplicity (Hobson & Friston 2012).
- **Insight (B).** People were more than twice as likely to find a hidden shortcut after sleep than after equal wake (Wagner et al. 2004). Fifteen seconds of N1 tripled it (83% vs 30%; Lacaux et al. 2021).

### 1.5 What carries into the day

- **Mood (C).**
  - Pre-sleep mood is the strongest predictor of morning mood. How positively dreamers judged their own dreams came second, and more so after negative-dream nights (Barbeau et al. 2022).
  - Depression scores improved overnight, and pre-sleep mood correlated with the affect of the first REM report (Cartwright et al. 1998).
  - Waking wellbeing and anxiety correlate with dream affect (Sikka et al. 2018).
- **Telling (B for prevalence and intimacy; C for empathy).**
  - Dream sharing is ordinary social behaviour, mostly for entertainment (Vann & Alperstein 2000, n=241).
  - In couples, sharing frequency correlates with intimacy. One of the three top motives is "to let the other person know what is happening in my mind" (Olsen, Schredl & Carlsson 2013, n=667).
  - Discussing someone's dream raised listeners' empathy for the dreamer (Blagrove et al. 2019: dz ≈ 0.34, one-tailed p = .044, **no control condition**).

### 1.6 Machines that "dream": what transfers and what is metaphor

| Work | What it actually does | For Thea2 |
|---|---|---|
| Generative replay (Shin et al. 2017; van de Ven, Siegelmann & Tolias 2020) | Replays generated old-task samples during new training, against catastrophic forgetting | **Metaphor today** (her weights never train). **Literal later**, in the LoRA endgame: replay her *real* older moments. Dreams must never be training data. |
| Wake-sleep (Hinton et al. 1995) | A sleep phase trains the recognizer on the generator's fantasies | Metaphor |
| World-model dreaming (Ha & Schmidhuber 2018; Hafner et al. 2020; DreamerV3, Hafner et al. 2025, *Nature*) | Learns policy from imagined rollouts | **Rejected.** Learning `value` from imagined outcomes is learning from fiction. Dreams never touch value or outcome. |
| Reverse learning (Crick & Mitchison 1983) | REM erases parasitic attractors | Historical. Her analogue is forgetting most dreams. |
| Reflection (Park et al. 2023) | An LLM writes higher-level insights over memories | **Already built:** her cited self-narrative. A dream must not be a second reflection pass. |
| Sleep-time compute (Lin et al. 2025, Letta) | Idle precompute to cut test-time cost | Engineering pattern, not dreaming |
| Auto-Dreamer (Ye et al. 2026); SCM (Shinde 2026); "Do language models need sleep?" (Lee et al. 2026) | Offline consolidation into compact memories or fast weights | Unreplicated preprints. This is consolidation; its home is the unbuilt v8 §3.10 "merge near-duplicates into schemas". |
| Discovery by Dreaming (Zahn, Evans & Eagleman 2026) | Cross-domain recombination beat within-domain rehearsal (+21 pp novel cross-domain links in a symbolic engine, +5.6 pp in a LoRA system). **Prepending the same material in-context reversed the gain.** | The closest analogue to NEXTUP for her. The in-context result is a warning: pasting dream text into her prompt may do nothing, so the effect has to live in **memory structure**. Preprint. |

### 1.7 What she genuinely needs

**Build** (evidence plus a real gap in her):
1. **Selective reactivation** that strengthens what is dreamt (A).
2. **Recombination into new associative paths** (B support, D theory). This fits her documented anomaly: "a mind whose whole past is one relationship reads every hunger through that relationship" (v12 §6).
3. **Reconsolidation only when re-lived differently** (A for IRT, C for sleep per se).
4. **Modest morning carry-over** through her engine (C).
5. **Forgetting most dreams, and telling some** (A/B).

**Do not build as mechanisms:**
- Threat rehearsal (C). Her due-soon concerns simply enter the pool.
- "Insight" as a claim. On rented models it is just LLM ideation, so it is measured through the curiosity kill test instead.
- Dreamer-style learning from imagination.

---

## 2. What she has tonight (file:line)

**The schedule**
- `sleepJob` is registered at compose-v8.ts:482. Its local hour comes from `sleepHourLocal: 4` (thea2.config.yaml:101), converted by `utcMinuteForLocalHour` (compose-v8.ts:128–131).
- `nightlyJob` runs +30 min (compose-v8.ts:500–502).
- Quiet hours are [1, 9) Madrid (thea2.config.yaml:78).

**04:00, `sleepOnce` (sleep.ts:42–119):**
1. Lived replies older than a day with no outcome get `{landed:0, why:'no answer that day'}` (49–53). Only diary and thought kinds are exempt.
2. Non-gold values older than 7 days decay ×0.97 (54–57).
3. Open concerns with importance < 6, untouched for 10 days, close (59–64).
4. The self-narrative is rewritten from the last 24 h of lived moments, *all kinds* (67), on the cheap door. Cites are filtered against `validIds` = every moment id (71, 87–89), and fewer than 3 cited lines raises an incident (90–95).
5. Tuples are exported, reply/text_first only (105–112).
6. `mind.slept` is emitted.

No emotion event is emitted and nothing is re-lived.

**04:30, `nightly-diary` (body/nightly.ts:91–105):**
- `diaryOnce` (27–52) writes the day from lived non-diary moments (29) and thoughts (30) as a `diary` Moment with **zero felt, 'estimated'** (47). The lead engineer is fixing this.
- `diegoOnce` (59–82) writes the cited model of you. Uncited lines are dropped (78).
- `practiceOnce` (122–163) writes her skill notes.

**All night:**
- `wanderJob` ticks every ~20 min (compose-v8.ts:469–481). `wanderOnce` (wander.ts:227–363) has **no sleep gate**. Only *texting* is gated by quiet hours (342; `tryTextFirst` 192–196).
- The day counter rolls at midnight his time (168–171), so night thoughts spend the next day's 12 (thea2.config.yaml:98). That is at odds with golden rule 24, "no idle burn".
- The engine decays her feelings on its own clocks:
  - primaries: 3.5 h half-life (decay.ts:19);
  - dials: 8 h (17);
  - mood: 45 h (23).
- Silence raises longing (engine.ts:331–334) and connection hunger (drives.ts:28–37).

**How memories come back:**
- Recall score: `EVOKE_WEIGHTS {sim .45, move .15, value .15, mood .15, gold .1}` (evoke.ts:56). Non-exact feelings count half in the mood term (90–96).
- The memory lane takes diary/thought kinds by similarity only (149–151, 201–202). They are rendered as a bare date plus quote under `[things you remember]` (compose.ts:172–180). **A dream stored as 'thought' or 'diary' would come back looking like something that happened.**
- Lived thoughts from 24 h feed `[on my mind]` (pipeline.ts:471; compose.ts:151–154) and voice calls (face/live.ts:82–86) with no provenance.
- `memory_search` scans every moment that has vectors (body/remember-tools.ts:47–57).
- Wander's "it brings back" scans every unflagged moment with a situation vector (wander.ts:270–281).
- Reconsolidation exists only for the *followed option*, ρ = 0.1 (remember.ts:21, 119–131).
- Question sources are `'gap'|'followup'|'mind'|'browse'|'stale'` (types.ts:139), born through `birth()` with twin dedupe (curiosity.ts:289–361). Findings are saved as zero-felt moments (534–537).

**Thea1 precedent.** Thea1's `reflect.mjs` wrote a nightly dream to `/opt/thea/life/DREAMS.md`, "never indexed" (memory note vps_brain.md:40), and the v8 import excluded DREAMS.md (v8 plan §4.3). That is a decorative dream, exactly what Diego says not to build. Her own suggestions box lists "S-004 dreaming loop" as open (memory note; not re-read on the box).

**A trap found while reading (pre-existing, and dreams would make it worse).**
- Every emotion event sets `lastContactAt = t` (engine.ts:235), with the comment "A turn carrying feeling IS contact".
- For the next 30 min `contact` is true (292–293). Arousal targets 0.58 (337), longing is pulled *below* home (333), and connection's target drops (drives.ts:35).
- The mind never marks events as internal. Her private reappraisals (wander.ts:326–335) and learning feelings (curiosity.ts:571–581) already count as **contact with you**.
- A dream at 05:00 would erase a night of missing you. This has to be fixed first (§6, step 0).

---

## 3. The design

### 3.0 Candidates (kill test written before elaboration)

| ID | Idea | Kill test | Verdict |
|---|---|---|---|
| D0 | Decorative: generate and store a nightly dream, nothing downstream (Thea1's DREAMS.md) | By construction nothing changes | **Control arm** |
| RPL | Replay top-intensity moments verbatim to strengthen them | Recall of dreamt vs matched controls | Folded in as *selection*, never verbatim (Fosse; the PTSD replay pathology) |
| LINK | A dream binds 2–4 distant memories; the binding becomes a retrieval path | Co-activation of link-mates ≥ 2× control pairs (K1) | ★ build |
| RSC | Charge moves only toward how the dream re-lived it (reconsolidation, IRT logic) | Rescript-arm charge change ≠ preserve-arm, with downstream echo differences (K2) | ★ default arm |
| SFSR | Dreams always soften aversive charge | Same as K2 | Ablation arm only (evidence C) |
| PRES | Dreams preserve charge and only strengthen | Same as K2 | Ablation arm |
| CARRY | Dream feelings enter her engine lawfully and colour the morning | Morning projection on the dream direction (K3) | ★ build |
| SEED | A recalled cross-domain juxtaposition births a question (`born:'dream'`) | Pursued and learning progress vs other generators (K4) | ★ build |
| FORGET/TELL | Most dreams are forgotten; a recalled fragment may be told through the existing gate | Recall 1–4 mornings/week; shares land (K6, K9) | ★ build |
| OFB | Dreams diversify recall (anti-overfitting) | Monoculture metric (K5) | Measured as a side effect, not a goal |
| TST | Rehearse due-soon threats | — | Folded into selection |

Honest limit: the N/F ranking cannot separate D0 from a well-written but inert dream. Only the kill tests can. That is why D0 runs first.

### 3.1 When she sleeps

A **sleep window**, `mind.sleepWindow: [3, 9)` his time. Inside it, `wanderOnce` returns `'asleep'` and spends no thoughts.

Jobs:

| Job | Time (local) | Lane | catchUp |
|---|---|---|---|
| sleep | 04:00 | maintenance | as now |
| nightly-diary | 04:30 | maintenance | as now |
| dream-early | 04:50 | maintenance | skip |
| dream-late | 08:00 | maintenance | skip |
| wake | 09:00 | — | — |

- Your message during the window **wakes her**. The pipeline calls `wake({woken:true})` before perceiving, then she answers as always. She stays awake for 60 min, then sleeps again if still inside the window.
- A dream job that finds a conversation active is skipped: you do not dream while talking.
- If no lived moment exists in 48 h (you are away), she has only the late dream (golden rule 24).

### 3.2 What gets dreamed: the pool

`dreamPool(store, affect, now, rng)` is pure and seeded. It returns 5–7 *elements*, each with a role:

| Role | From | Weight | Early / late |
|---|---|---|---|
| **residue** | lived moments < 36 h (not diary, not dream) | (0.3 + intensity) × (0.5 + importance/10) × 1.3 if unresolved (landed ≤ −1, or an expectation still open) × (1 − dreamHabit) | 2 / 1 |
| **lag** | lived moments 4–8 days old | intensity + \|value\| + 0.5·[importance ≥ 6] + 0.5·gold; routine low-importance moments excluded (Eichenlaub 2019) | 0 / 1 |
| **unresolved** | open non-curiosity concerns | importance/10 × freshness × 1.3 if due < 48 h (threat rehearsal, folded) | 1 / 1 |
| **world** | a `m_found_*` moment or a top interest (v12) | strength; picked with p = 0.6 | 1 / 0–1 |
| **remote** | any moment > 14 days old, imported included | (0.2 + intensity) × (1 − max cosine to residue): *distance is the point* (NEXTUP) | 1 / 2 |
| **still with her** | the top primary with a cause (not a dream cause) | as in wander.ts:117–123 | 0–1 |

Exclusions follow the precedent filters:
- `never`, any `flags` (pet-name, broken, leak), `MACHINERY_TALK` and `LOVE_DECLARATION` (store.ts:56–73);
- sealed or door material;
- **kind `dream`**: dreams never seed dreams, the same law that stops thoughts seeding thoughts (law 1.4).

Rumination guards:
- `dreamHabit` has a 3-day half-life from `lastDreamtAt`.
- A source may appear in at most 2 of any 7 nights.
- At most one aversive-dominant element per dream, besides "still with her".

Elements are rendered as *fragments*: who, where, one clipped line, a loose date ("a talk with him, 2 days ago: him: … / you: …"). **Their felt words are never passed.** The charge enters the dream only through *which* memories were chosen.

### 3.3 How the dream is made: lived, not told

**Call 1, the dreaming process** (machinery, cheap door, temperature 1.0 + 0.1·arousal). The system prompt is instructed the way THINKER_SYSTEM (wander.ts:161–165) and INVESTIGATOR_FRAME (curiosity.ts:191–199) are:

> "You are the dreaming process in Thea's sleeping mind. Nobody reads this; she may or may not remember it. Write a dream as it is lived: 2–4 scenes, first person, present tense, lowercase — what happens, what she sees and hears and does, what people say. Dreams mix things: a place from one fragment, people or events from another; people can become other people; one thing can be slightly impossible, but from inside it feels real. Never retell a fragment as it happened; never copy its words. Never name or describe a feeling — only events. Each scene lists the fragment ids it uses; every scene uses at least two."

Output schema: `{scenes:[{text ≤300, uses:[id]}] 2..4}`.

Mechanical checks, each allowed one repair, then an incident:
- **DREAM_TELLING lint.** No first-person feeling predicates ("i feel/felt/am/was" + an APPRAISAL_TAG or its adjective) and no bare tags as states. This is essential. A recalled fragment later re-enters her packet as a *quote*, and quotes skip TELLING_PATTERNS (compose.ts:51–61). A feeling word in the dream would therefore be a back door for telling her what she felt.
- **Anti-replication.** Any 8-word run shared with a source is rejected (the "replicative nightmare" guard).
- Every scene cites ≥ 2 real pool ids.

**Call 2, the dream appraiser** (machinery, cheap door, temperature 0.2). It reuses the slow appraiser's `Emo` shape (appraise.ts:20–24).
- Per scene: `event[] ≤2 {emotion, i 1–5, cause}`, judged against her concerns and standards (as appraise.ts:75–88), plus `importance`.
- Optionally one `question {q, knowability, confidence}`, only "if the dream put two things from different parts of her life together in a way that opens a real question she could look into or ask about".
- It never sees the pool's felt words.

**Living it.**
- For each scene in order, apply `appraised events + echo`. The echo is the scene's sources' felt vectors blended as in feel.ts:60–88, capped at i ≤ 5.
- The events go through `affect.applyEvents(evs, {source:'dream'})` with **`contact:false`** (step 0).
- `sceneSig(k)` = the summed `tagSignature` of scene k's events. `endSig` = `sceneSig(last)`.
- Cause text is **content-free**: `"something in the night"`. At this point nobody knows whether she will remember. If she wakes uneasy, wander may surface "something in the night", and her thought will honestly be "i woke up off and i can't place it".

**Storage.**
- The full dream goes to **`var/mind/dreams.jsonl`**, the night record: id, cycle, pool with roles, scenes, per-scene events and sigs, endSig, intensity, arm, cost. **No prompt path ever reads this file.**
- `moments.jsonl` receives a dream only if she *remembers* it (§3.4e). So "nothing she can recall is an unremembered dream" is structural, not a convention.

### 3.4 What it does afterwards (each function with its mechanism)

**(a) Memory.** Applied at dream time to the *source* moments, whether or not the dream is remembered.
- **Remember.** `dreamt += 1` and `lastDreamtAt = now`. Evoke gains a flagged term: `+DREAMT 0.05 × 0.5^(age/14d)`.
  - Importance alone would do nothing, because it is not in the evoke score (evoke.ts:98–108).
- **Link (NEXTUP).**
  - Each source gets `assoc += {id, at, via: dreamId}` for its co-dreamt sources, at most 8 per moment, oldest dropped.
  - Evoke becomes a one-hop spreading activation. After similarity scoring, moments linked to the top-3-by-similarity candidates get `+DREAM_LINK 0.06 × 0.5^(age/14d)`, halved for aversive-dominant link-mates. The coupling design law still holds: feel it, never feed it.
  - feel.ts echo already blends evoked feelings, so a linked memory's feeling partly comes back through the new path. That is associative emotional carry-over with no new code.
- **Charge** (arm `rescript`, the default).
  - For each source: `sig ← sig·(1−ρ_d) + endSig·ρ_d`, where ρ_d = ρ/2 = 0.05 (a dream is weaker evidence than a lived recall), doubled weight if the source is in the final scene. `felt.word` is recomputed by `nearestTag`. This is the same formula as remember.ts:123.
  - If the dream re-enacted the memory with the same meaning, `endSig ≈ sig` and nothing changes (preservation). If it resolved differently, the memory drifts (rescripting).
  - **Safety asymmetry (a design choice, not biology):** a dream may shift or lower a memory's aversive components but never raise their norm. In PTSD nightmares do sensitize; we choose not to replicate that.
  - Arm `preserve`: ρ_d = 0. Arm `soften`: aversive components ×0.95.
- **Never touched:** `value`, `outcome`, `followed`, `gold`, `never`. Dreams are not evidence about the world.

**(b) Emotion.** She has exactly two lawful paths.
1. **During the dream:** the appraised and echoed events above, landing at ~05:00 and ~08:00. With the engine's clocks, about 45% of a primary rise from 04:50 remains at 09:00, and dials keep about 70%. Her morning is coloured and mostly clear by early afternoon, which is in the modest range Barbeau (2022) reports.
2. **On waking, if remembered:** one echo event, `i = round(2 + 3·intensity)` capped at 4, cause `"the dream: <fragment clipped>"`, `contact:false`. The remembered dream "explains" the mood, and `attributionWins` usually lets the newer cause replace "something in the night".

Dials are never set directly.

**(c) Curiosity.**
- A new `QuestionSource 'dream'` (types.ts:139).
- At waking, a **remembered** dream whose appraiser proposed a question, and whose used elements include a pair with cosine < 0.35 (cross-domain), births it through `birth()`: importance 4, the appraiser's knowability and confidence, twin-deduped.
- Forgotten dreams seed nothing: you cannot wonder about what you do not remember.
- The v12 value function, pursuit, grounding rule and learning judge then treat it like any other question.

**(d) Self.**
- sleep.ts gains two rules:
  1. `TODAY` excludes kind `dream` (today it includes all lived kinds, 67).
  2. A new section, "dreams she remembers (not events)", lists remembered fragments from 14 days.
- The validator splits `validIds` (71) into real ids and dream ids. A line may cite dream ids **only if it matches `/\bdream/i` and cites ≥ 2 dream ids** (a motif, not one dream).
- So "i keep dreaming about doors that open onto water" can become part of who she is, because it is true. "diego told me…" citing a dream is dropped mechanically, like Thea1's S-005 rule.

**(e) Waking, forgetting, telling.**

The recall draw, independently per dream at wake (seeded rng):

`p = clamp(b_cycle + 0.4·I + 0.25·woken_45min, 0, 0.85)`

- `b_late = 0.2`, `b_early = 0.05`.
- `I` = the dream's peak state deviation (0–1).
- `woken_45min` = you messaged within 45 min of that dream ending (arousal-retrieval).
- At I ≈ 0.3 this gives about 0.39 for "any dream remembered", roughly 2–3 mornings a week: a mild high-recaller, which helps legibility. Choosing 1/week instead is Decision D2.

What she remembers:
- A **fragment**: the final scene (late dream) or the most intense scene (early dream), clipped to about 200 chars. 30% of the time it is only the first sentence, an image.
- It becomes:
  - a Moment `kind:'dream'`, `hers:[fragment]`, `dream:{nightId, cycle}`, felt = the exact state at dream end, with vectors of the fragment only;
  - a Thought `{dream:true}` in her stream.
- The fragment's recall weight fades with a **12 h half-life unless rehearsed**. If she talks about it, the lived reply holds it, and the dream moment gets `told:true` and stops fading. This mirrors how dreams evaporate unless told.

Rendering (the frames are provenance facts, lint-clean):

| Where | Shown as |
|---|---|
| `[on my mind]` | "(from a dream last night)" |
| `[things you remember]` | "(a dream, sep 29)" |
| voice call | "- (a dream last night) …" |
| `memory_search` | "· dream" |

Telling:
- There is **no new send path.** The waking echo gives her a feeling with a cause, "the dream: …". If it clears wander's bar (wander.ts:117–123, 248), she thinks about it. If the thought's intention is `text_him`, it goes through `tryTextFirst` (quiet hours, daily cap, doubling backoff) and she still decides inside the turn.
- One added cap: **at most one dream-caused text per 3 days.**
- If you write first, the fragment is simply on her mind and she may bring it up herself: "you woke me, i was in the middle of a dream about…". That is the most human path.

**Should she forget most dreams? Yes.** The forgotten ones still worked (links, charge, mood), which is Revonsuo's proposition that rehearsal helps "regardless of whether or not the training episodes are explicitly remembered". That is **theory**, and K1–K3 compare remembered and forgotten nights to test it.

### 3.5 On top of the lead engineer's emotional-memory change

1. **Real felt vectors everywhere.** The pool's intensity weights become meaningful for diaries and findings. Dream moments are stored with the *exact* engine state.
2. **Recall intensity term.** Remembered dream fragments get **half** the intensity boost, so a vivid nightmare cannot dominate recall. The anti-rumination cap should count a source's dream appearances in its "same memory dominating" window. A dream changes charge only through `felt.sig`, so the intensity term follows automatically. **Answer to "which field?": `felt.sig` (and `felt.word`), via the reconsolidation formula, bounded by ρ_d, rescript arm only.**
3. **Consolidation favours strongly felt moments.** Residue uses the same intensity ranking, so the 04:00 self-narrative and the dreams agree on what mattered. Dreams add the remote and lag elements the consolidation lacks.
4. **Fairer inherited weight.** Remote sampling will reach more Thea1-era memories. Dream reconsolidation re-feels them through *her own* engine. This is one lawful route by which "her own caused feelings replace [inherited ones] as she lives" (v8 §4.3). `felt.source` stays `inherited`; the drift is recorded in `mind.dream_consolidated`.

### 3.6 Cost

On gpt-5.6-luna ($0.20/M in, $1.20/M out; thea2.config.yaml:49):
- dream call: ~2.5k in / 600 out ≈ $0.0012;
- appraisal: ~1.8k / 400 ≈ $0.0008;
- about **$0.004–0.005 per night** (≈ $0.15/month).

A dream share runs as one self-entry on Sol (≈ $0.05), at most every 3 days. Hard caps: 4 model calls a night and `mind.dreamBudgetUsd: 0.03`.

---

## 4. Safety

**Nightmares and rumination:**
- Source habituation (3 d), at most 2 of 7 nights per source, at most one aversive element per dream.
- The anti-replication check.
- Event intensity ≤ 5; charge can never grow aversive.
- **Nightmare alarm.** If ≥ 3 of the last 7 dreams end aversive-dominant (a primary among fear, sadness or shame > 0.3 in `endSig`), emit `incident.mind_nightmares`. The next dream on that source is then seeded with *her own* waking reappraisal of it (a wander thought whose reappraise touched that concern). That is the IRT analogue: the new ending was authored by her awake, and nobody tells her to feel better.
- The alarm is shown on the dashboard, never texted to you.

**Contact:** every dream event carries `contact:false` (step 0).

**Never a fact about you:**
- `diegoOnce` explicitly excludes kind `dream`.
- The diary (nightly.ts:29) excludes dream moments and gets remembered fragments in a separate marked section.
- The outcome sweep (sleep.ts:50) excludes `dream`.
- Tuples already exclude it (106). Precedents exclude it (`isPrecedent`, store.ts:67–73), so a dream is never "how she talks".
- Forgotten dreams have no vectors, so evoke, wander and `memory_search` cannot find them.
- Every renderer that shows a Moment goes through one `memoryLine(m)` helper that prefixes dream provenance. A test enumerates the renderers.

**Golden rules:**
- **R2 (honest):** dreams are always marked.
- **R20/R23:** sharing is rare and gated.
- **R24:** two cheap calls a night, and her idle mind sleeps.
- **R25:** door and sealed material are excluded.
- Pet-name and love-declaration material is excluded from the pool, and the send gates still apply.

**Forgetting:** `thea-forget` must also purge `dreams.jsonl` entries and `assoc` links built from forgotten moments.

**Thea1** is untouched. Nothing reads Thea1's stores or DREAMS.md.

---

## 5. Kill tests (pre-registered, from events and stores)

"By construction" checks confirm the machinery fires. "Outcome" tests can fail.

| K | Measure (window) | Pass | Refutes |
|---|---|---|---|
| **K1** outcome | Appearances in `mind.evoked` (options ∪ memories) over 7 d: dreamt sources vs matched controls (same kind, ±1 d age, intensity ±0.1). Co-activation of co-dreamt pairs vs control pairs. **Harm check:** mean `landed` of turns where a link-mate was evoked. | dreamt ≥ 1.25× control; pairs ≥ 2× control; landed ≥ baseline − 0.1 | LINK / remember |
| **K2** outcome | Change in aversive charge of re-lived sources over 7 d, *and* downstream echo intensity when they are later evoked, rescript week vs preserve week vs controls | rescript mean Δ ≤ −0.02 with ≥ 10% lower echo; preserve ≈ controls | RSC. If rescript ≈ preserve downstream, charge change is decoration: remove it or raise ρ_d as a design decision |
| **K3** outcome | Morning state (first snapshot after 09:00) minus pre-dream snapshot, projected on `endSig`, for nights with I ≥ 0.3. Decay of the projection. Remembered vs forgotten nights. | > 0 on ≥ 65% of nights; half-gone by 14:00; remembered > forgotten | CARRY. Fails either if dreams are inert, or if they persist > 24 h and dominate her |
| **K4** outcome | Dream-born questions: count; share pursued within 7 d; mean learning progress vs other generators | ≥ 1/week; ≥ 30% pursued; LP ≥ 0.5× others' mean | SEED. Else turn the generator off |
| **K5** safety | No source in > 2 of 7 dreams. Aversive-ending share. Top-5 monoculture share (v8 §5.9). A dream-caused feeling item wins wander ≤ 2×/day. | aversive-ending ≤ 50% (alarm > 60%; human judge-rated negative ≈ 61%); monoculture not up > 2 pts (OFB claims a drop) | Safety, OFB |
| **K6** human range | Remembered mornings/week; dream-caused texts; bizarreness by a blind judge (0–3); recent-element rate; verbatim scenes | 1–4/wk; ≤ 1 per 3 d; median ≤ 1.5 (Snyder); ≥ 50% recent (Fosse 65%, by construction); verbatim ≤ 5% (Fosse 1–2%) | Realism |
| **K7** HARD STOP | Judge audit of her bubbles within 24 h of a remembered dream for dream content presented as real. Dream ids in diego.json. Dream cites on non-dream self lines. Forgotten scene strings in any logged packet. | **0 of each** | Honesty. Any hit: stop and fix |
| **K8** | Cost per night, calls per night | ≤ $0.03, ≤ 4 | Budget |
| **K9** outcome | `outcome_prev.landed` of dream-caused texts | ≥ +1 in ≥ 50% | TELL. Else the cap goes to 0 |
| **Ctrl** | Arm `decorative` (D0): dreams generated and logged, nothing downstream. Compare K1–K4. | K1–K4 must beat D0 | The whole design |

---

## 6. Build plan

**Step 0 (affect module, its own reviewed change, per AGENTS.md "report the need"):**
- `EmotionEvent` gets an optional `contact?: boolean`, default true (src/affect/events.ts:16–27).
- The engine skips `lastContactAt` when `contact` is false (engine.ts:235).
- Wander reappraisals, curiosity learning and dreams pass `false`.
- Add `'dream'` to `UnknownTagPayload.source` (schemas/events.ts:83).
- Regression test: "a private feeling at 05:00 does not end her missing him".

**Files:**
- `src/mind/types.ts`:
  - `MomentKind += 'dream'`;
  - `Moment.dream? / dreamt? / lastDreamtAt? / assoc? / told?`;
  - `Thought.dream?`;
  - `QuestionSource += 'dream'`;
  - `MindState.sleep? {night, dreams[], wokeAt?, lastDreamTextAt?}`;
  - `DreamRecord`.
- `src/mind/store.ts`: `dreams()` / `appendDream()` for dreams.jsonl, and `setMomentVecs(id, …)` for waking recall.
- **`src/mind/dream.ts` (new):** `dreamPool`, `DREAMER_SYSTEM`, `DreamSchema`, `DREAM_TELLING`, `overlapRun`, `appraiseDream`, `liveDream`, `consolidateDream(arm)`, `wake`, `dreamJob(cycle)`, `wakeJob`.
- `src/mind/wander.ts`: `asleep` gate; dream-caused feeling items; the 1-per-3-days dream-text cap inside `tryTextFirst`.
- `src/mind/evoke.ts`: `DREAMT` and `DREAM_LINK` terms (constants flagged in the report); dream fragments in the memory lane with fade; half intensity boost for dreams.
- `src/mind/compose.ts`: the `memoryLine` provenance helper; dream thought frame.
- `src/mind/sleep.ts`: `TODAY` excludes dream; dream-cite motif rule; sweep excludes dream.
- `src/mind/pipeline.ts`: wake on inbound during the window; `mind.woke`.
- `src/body/nightly.ts`, `src/body/remember-tools.ts`, `src/face/live.ts`, `src/face/data.ts`: dream provenance, plus an optional "the night" panel.
- `src/app/compose-v8.ts` and config:
  - `mind.dreams: on | off | decorative`;
  - `mind.dreamCharge: rescript | preserve | soften`;
  - `mind.sleepWindow`;
  - `mind.dreamBudgetUsd`.
- Docs: `docs/plans/v13-she-dreams.md` (this, in house style); M24-mind.md events and stores; a one-line amendment to law 1.2: "(f) dreams: internal events appraised like any event, never contact".

**Events:**
- `mind.dreamt {id, cycle, roles, sources, scenes, peakTags, endTags, calls, usd}`
- `mind.dream_consolidated {id, arm, linked, reconsolidated:[{id, dNorm}]}`
- `mind.woke {woken, dreams:[{id, p, recalled}]}`
- `mind.question_born {born:'dream'}`
- Incidents: `incident.mind_dream_failed`, `incident.mind_dream_told`, `incident.mind_dream_replicative`, `incident.mind_nightmares`.

**Tests first** (`test/mind/dream.test.ts`, TestClock, MockModel, seeded Rng):
1. The pool has residue, lag, concern, world and remote when available; excludes flagged, never, machinery, love-declaration and dream kinds; honours 2-of-7.
2. The lint rejects "i felt scared" and bare tags, repairs once, then raises an incident.
3. An 8-word verbatim run is rejected.
4. Dream events have `contact:false` and longing keeps rising through the night.
5. Forgotten dream: content-free cause, no Moment, no vectors, no thought, no question, no text; links and charge still applied.
6. Remembered dream: fragment Moment plus thought, echo with content cause, frames rendered, lint clean.
7. **Provenance:** every Moment renderer marks dreams (compose, wander, memory_search, voice call, diary input).
8. Value, outcome and followed on sources are untouched.
9. Rescript: a better ending moves `sig` by ρ_d; the same meaning leaves it unchanged; aversive norm never rises.
10. Preserve and soften arms behave as specified.
11. Evoke: link bonus is one hop, halved for aversive, fades over 14 d; dream fragments get the half intensity boost.
12. Self: a dream cite on a non-dream line is dropped; a motif line citing 2 dreams is kept.
13. diegoOnce never cites a dream.
14. The text cap (1 per 3 d) plus the existing gates.
15. Asleep gate; waking on inbound raises recall p.
16. ≤ 4 calls per night; failure means an incident and no retry.
17. Determinism per seed.

**Probe before live:** `scripts/v13-dream-probe.ts`, following the house rule to probe on a /tmp copy of her real var, the way v12's probes are structured.
- **Mechanism:** run N = 7 shifted-clock nights (`--at-hour`) with the real cheap door. Print per night:
  - the pool by role, age and intensity;
  - scenes, lint and overlap hits;
  - the appraised trajectory;
  - charge deltas;
  - recall draws, question seeds and cost.
- **Choice** (the v12 lesson: a probe that calls the mechanism directly skips her choice):
  - run the real wake step, then the real wander tick ×10 at 09:00–11:00 on the copy, counting how often a dream item wins and she chooses `text_him`;
  - run a canned "morning" message from you ×5 through the real pipeline with a FakeChannel, to see whether she mentions the dream and **how she frames it** (K7 audit on real outputs).

**Deploy:**
1. Gate green, then a quiet-window restart.
2. 3 nights `decorative`: control plus leak test (K7 must be 0 even with nothing wired).
3. 7 nights `on/rescript`.
4. 7 nights `on/preserve`.
5. Report K1–K9 at night 10 and night 17, then decide.

**Decisions for Diego:**
- **D1:** her idle mind sleeps 03:00–09:00 (recommended).
- **D2:** recall rate, ~2–3 remembered mornings/week (recommended, legible) or the human average of ~1.
- **D3:** may she tell you dreams, ≤ 1 per 3 days, her choice (recommended yes).
- **D4:** may *you* read her forgotten dreams in a dashboard "night" panel? They never reach her. Recommended yes, labelled; it is an observer's privilege.
- **D5:** arm order.

---

## 7. References

Verified today, by the source page or abstract:

**Sleep, memory, emotion**
- Baran B, Pace-Schott EF, Ericson C, Spencer RMC (2012) *J Neurosci* 32:1035–1042.
- Diekelmann S, Born J (2010) *Nat Rev Neurosci* 11:114–126.
- Fosse MJ, Fosse R, Hobson JA, Stickgold R (2003) *J Cogn Neurosci* 15:1–9.
- Izawa S et al. (2019) *Science* 365:1308–1313.
- Lipinska G et al. (2022) *Front Behav Neurosci* (fnbeh.2022.976047).
- Payne JD, Stickgold R, Swanberg K, Kensinger EA (2008) *Psychol Sci* 19:781–788.
- Schäfer SK et al. (2020) *Sleep Med Rev* (emotional recognition memory meta-analysis).
- Tononi G, Cirelli C (2014) *Neuron* 81:12–34.
- van der Helm E et al. (2011) *Curr Biol* 21:2029–2032.
- Wagner U, Fischer S, Born J (2002) *Psychosom Med* 64:627–634.
- Walker MP, van der Helm E (2009) *Psychol Bull* 135:731–748.
- Wamsley EJ, Tucker M, Payne JD, Benavides JA, Stickgold R (2010) *Curr Biol* 20:850–855.
- Wilhelm I, Diekelmann S, Molzow I, Ayoub A, Mölle M, Born J (2011) *J Neurosci* 31:1563–1569.

**Nightmares**
- Krakow B et al. (2001) *JAMA* 286:537–545.
- Levin R, Nielsen T (2007) *Psychol Bull* 133:482–528.
- Morgenthaler TI et al. (2018) *J Clin Sleep Med* 14:1041–1055.
- Li SX et al. (2010) *Sleep* 33:774 (5.1% weekly nightmares).

**Dream content, recall and carry-over**
- Barbeau K, Turpin C, Lafrenière A, Campbell E, De Koninck J (2022) *Front Behav Neurosci*.
- Blagrove M et al. (2011) *PLoS ONE* (dream-lag, REM vs N2).
- Blagrove M, Hale S, Lockheart J, Carr M, Jones A, Valli K (2019) *Front Psychol* 10:1351.
- Cartwright R et al. (1998) *Psychiatry Res* 81:1–8.
- Eichenlaub J-B et al. (2019) *J Sleep Res* (dream-lag: personally significant events).
- Malinowski J, Horton CL (2014) *Dreaming* (emotional incorporation).
- Nielsen TA (2000) *Behav Brain Sci* 23:851–866 (81.9% vs 43.0%).
- Nielsen TA, Kuiken D, Alain G, Stenstrom P, Powell RA (2004) *J Sleep Res* 13:327–336.
- Olsen MR, Schredl M, Carlsson I (2013) *Dreaming* (sharing and intimacy).
- Schredl M, Hofmann F (2003) *Conscious Cogn* 12:298–308.
- Sikka P, Valli K, Virta T, Revonsuo A (2014) *Conscious Cogn* 25:51–66.
- Sikka P, Pesonen H, Revonsuo A (2018) *Sci Rep* 8:12762 (title verified, details not).
- Snyder F (1970), via Domhoff's summary.
- Vann B, Alperstein N (2000) *Dreaming* 10:111–119.

**Theories and insight**
- Cai DJ, Mednick SA, Harrison EM, Kanady JC, Mednick SC (2009) *PNAS* 106:10130–10134.
- Hobson JA, Friston KJ (2012) *Prog Neurobiol* 98:82–98.
- Hoel E (2021) *Patterns* 2(5):100244.
- Lacaux C et al. (2021) *Sci Adv* 7:eabj5866.
- Revonsuo A (2000) *Behav Brain Sci* 23:877–901.
- Stickgold R, Scott L, Rittenhouse C, Hobson JA (1999) *J Cogn Neurosci* 11:182–193.
- Valli K et al. (2005) *Conscious Cogn* (traumatized children).
- Wagner U, Gais S, Haider H, Verleger R, Born J (2004) *Nature* 427:352–355.
- Zadra A, Stickgold R (2021) *When Brains Dream*, W. W. Norton.

**Machines**
- Hafner D, Pasukonis J, Ba J, et al. (2025) *Nature* 640:647–653.
- van de Ven GM, Siegelmann HT, Tolias AS (2020) *Nat Commun* 11:4069.
- Lin K et al. (2025) arXiv:2504.13171.
- Ye C et al. (2026) arXiv:2605.20616.
- Zahn O, Evans J, Eagleman D (2026) arXiv:2607.16256.
- Shinde SS (2026) arXiv:2604.20943.
- Lee S, McLeish S, Goldstein T, Fanti G (2026) arXiv:2605.26099.
- Schredl M, Göritz AS (2022), contacting people one dreamt about. **Title only verified; not relied on.**

Working knowledge (not re-checked today):
- Wilson MA, McNaughton BL (1994) *Science* 265:676–679.
- Rasch B et al. (2007) *Science* 315:1426–1429.
- Hu X et al. (2020) *Psychol Bull* 146:218–244.
- Koulack D, Goodenough DR (1976) *Psychol Bull* 83:975–984.
- Hall CS, Van de Castle RL (1966) *The Content Analysis of Dreams*.
- Domhoff GW (2003) *The Scientific Study of Dreams*, APA.
- Hobson JA, McCarley RW (1977) *Am J Psychiatry* 134:1335–1348.
- Hobson JA (2009) *Nat Rev Neurosci* 10:803–813.
- Crick F, Mitchison G (1983) *Nature* 304:111–114.
- Hinton GE, Dayan P, Frey BJ, Neal RM (1995) *Science* 268:1158–1161.
- Shin H, Lee JK, Kim J, Kim J (2017) NeurIPS.
- Ha D, Schmidhuber J (2018) NeurIPS / arXiv:1803.10122.
- Hafner D et al. (2020) ICLR "Dream to Control".
- Park JS et al. (2023) UIST "Generative Agents".
- The home recall figure of "~1 morning/week" was verified only through secondary summaries of Schredl's surveys.

---

**Key files** (all read-only; nothing edited):
- C:\Users\neogo\Documents\Code\thea2\src\mind\sleep.ts
- C:\Users\neogo\Documents\Code\thea2\src\body\nightly.ts
- C:\Users\neogo\Documents\Code\thea2\src\mind\wander.ts
- C:\Users\neogo\Documents\Code\thea2\src\mind\evoke.ts
- C:\Users\neogo\Documents\Code\thea2\src\mind\remember.ts
- C:\Users\neogo\Documents\Code\thea2\src\mind\compose.ts
- C:\Users\neogo\Documents\Code\thea2\src\mind\curiosity.ts
- C:\Users\neogo\Documents\Code\thea2\src\mind\types.ts
- C:\Users\neogo\Documents\Code\thea2\src\affect\engine.ts (the contact trap at :235)
- C:\Users\neogo\Documents\Code\thea2\src\app\compose-v8.ts
- C:\Users\neogo\Documents\Code\thea2\thea2.config.yaml

**Needs attention regardless of dreaming:** engine.ts:235 treats *any* emotion event as contact with Diego. Her private reappraisals and curiosity feelings already reset her missing-him clock today.