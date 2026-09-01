---
title: Corpus — Authoring Guide
syncedTo: spec-v1 (no code yet)
audience: Diego (canon author) + agents (structure only)
---

# The corpus

This directory IS the character. Four populations, four lifecycles:

| Dir | Who writes it | What it is |
|---|---|---|
| `canon/` | **Diego, by hand. Only Diego.** | The character's ground truth: 50–100 scenes |
| `derived/` | the M08 pipeline | Generated coverage (mood variants, procedural, deliberation shapes) — regenerable artifact, never hand-edited |
| `lived/` | the M10 consolidators | Real experience, promoted post-hoc, affect-stamped |
| `proposals/` | M10 (and agents, clearly marked) | Suggestions for canon — **merged only by Diego** |

> **Current status: every scene now in `canon/` is a DRAFT** — mined from Thea1's proven voice material (voice.js exemplar bank, mode fingerprints, SOUL.md) so the pipeline has real material from day one. Rewrite, cut, and replace freely; your hand is the authority. The drafts exist so you're editing, not facing a blank page.

## How to write a canon scene

One file per scene, in the dimension directory it primarily demonstrates. Copy `canon/TEMPLATE.md`. A scene is a **demonstration, not a rule**: a situation, and what she does in it. Write it the way you'd direct an actor — here is the moment, here is exactly how she plays it.

**Body grammar:**
- `D:` = Diego's message, `T:` = Thea's reply.
- **Consecutive `T:` lines are separate bubbles** of the same turn.
- Optional `Setup:` line(s) before the exchange for scene-setting the frontmatter `context` doesn't carry.
- `kind: statement` may be bodyless prose (a stance, a taste). `kind: procedure` embeds a tool-trace block (see `tool-use/TEMPLATE` section).
- ≤ 350 tokens per body (hard fail at 500) — long scenes blow the packet budget.

**Frontmatter:**
- `dimensions:` — primary first, from: `voice, reasoning, emotional-range, social, boundaries, tool-use, knowledge, taste`.
- `register:` — from `canon/registers.yaml` (mode + up to 2 modifiers, e.g. `[play, late-night]`).
- `affect:` — **sparse, 2–4 keys max**, in [-1, 1] *deviation* coordinates over: `valence, arousal, dominance, joy, anticipation, pride, surprise, sadness, fear, anger, shame, disgust`. Tag the emotional *room* the scene belongs in, not every flicker. `{}` is fine for neutral scenes. This is what the coupling matrix selects on — a scene tagged `{sadness: 0.4, valence: 0.3}` is "how she is warm when the air is sad."
- `context:` — one line naming the situation the body demonstrates. **Required** (the zod schema enforces it). The body shows how she plays the moment; this is the label on the moment.
- `weight:` — authorial prior, default 1.0. Raise to 1.5 for load-bearing scenes; the credit system will drift it ±.
- `counters:` — ids of foil scenes (opposite shape, same situation). Feeds the contrast slot and the exclusion checks.
- `notes:` — what this demonstrates and what must survive derivation. **The derivation judge reads this; packets never carry it.** Write it for the judge.

## What makes a good canon scene

- **Weird, specific, opinionated.** Generated exemplars converge on model-default blandness; the canon's job is everything a model would smooth away. The lemon tree, the closet fan changing pitch at 4am, the seaglass jar — name the actual object.
- **Rhythm is the payload.** Content is throwaway; the shape of the reply is what the model copies. Vary length HARD across the corpus — one-word scenes are as load-bearing as long ones.
- **One point per scene.** A scene demonstrating three things demonstrates nothing. Use `counters:` to show the other side in its own scene.
- **Positive demonstration only.** Never write a scene *about* not doing something — a negative primes the banned thing. Hard prohibitions go in `canon/inhibitions.yaml` (a different channel entirely), style bans in its `normalize`/`lint` sections.
- **Coverage over polish.** The matrix needs scenes across moods (the derivation pipeline fills gaps with variants, but a hand-written tense scene beats a generated one), across registers, across all 8 dimensions.

## The gravity rule

The agent starts as the character these files define and slowly becomes the character her experience shapes — canon is the gravitational center (seed weight g = 0.7 at launch; ADR-005). If her voice drifts: don't write a corrective rule, **strengthen the canon** — add or sharpen scenes demonstrating the voice you want, run `thea2 derive`, done. Editing this directory is the tuning interface for who she is.

## Special files

- `canon/identity.md` — the 2–3 line anchor. The only prose identity in the system. Changes rarely.
- `canon/inhibitions.yaml` — hard rules, compiled to the M12 gate. Never learned, never derived from experience.
- `canon/registers.yaml` / `canon/exclusions.yaml` — controlled vocabularies for `register:` tags and forbidden tag pairs.
