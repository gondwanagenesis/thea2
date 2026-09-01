# Reference Schemas — spec-v1

## What these are

Documentation artifacts: the shared data shapes of the Thea2 design report (docs/design-report.md) written as compiling-plausible TypeScript + zod, so an agent implementing a module has an exact target instead of prose. They are **not** imported by `src/` at runtime and never will be.

## The sync rule

- Until the owning module lands, the file here is the source of truth for its shape.
- At the owning module's build stage, source of truth migrates to `src/<module>/` — from then on, any PR that changes a schema in `src/` must update its mirror here in the same PR.
- Every file's header carries the rule; the `syncedTo: spec-v1` marker (mirrored in docs/decisions frontmatter) names the spec version the shapes reflect.
- Divergence between `src/` and `schemas/` is a doc bug and fails review. If a mirror becomes too costly to maintain, replace it with a one-line pointer to the `src/` file — never let it rot silently.

## Files

| Schema file | Shape(s) | Owning module | Source of truth migrates at |
|---|---|---|---|
| `exemplar.ts` | canon/derived/lived exemplar frontmatter, body grammar, parsed `Exemplar` | M7 `corpus` | S2 |
| `appraisal.ts` | per-turn L1 `Appraisal` (emotions, diary line, threads, outcomePrev) | M9 `memory` | S3 |
| `decision.ts` | `DecisionObject`, `ToolStep`, `SpawnRecord` (`Verdict` mirror is owned by M12 `inhibit`) | M13 `loop` | S4 (`Verdict`: S3) |
| `events.ts` | `EventEnvelope` + core event kind union and payloads | M2 `events` | S1 |
| `probe.ts` | probe YAML shape (entry, fixtures, expect, evaluators) | M19 `probes` | S8 |

## Cross-cutting constants

Two vocabularies appear in more than one schema and must never fork:

- **AFFECT_DIMS** (12 dims: PAD + 9 primaries) — defined in `exemplar.ts` here; canonical home will be `src/affect/vocab.ts` / `src/coupling` (ADR-004).
- **EMOTION_TAGS** — deliberately *not* restated in `appraisal.ts`; the canonical list is ported from Thea1 ticker.py into `src/affect/vocab.ts` at S2. A second copy is exactly the drift that caused the orphan-tag incident.

Two-channel note (ADR-009): `kind: procedure` exemplars validate against the same file schema but belong to the procedural channel (ProceduralStore, rendered as [PROCEDURAL]), never to [EXEMPLARS].
