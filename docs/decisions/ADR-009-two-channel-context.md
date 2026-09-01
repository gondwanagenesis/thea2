---
adr: ADR-009
title: Two-channel context — character and procedure composed separately
status: accepted
date: 2026-09-01
syncedTo: spec-v1
---

## Context

Spec-v1 gave the packet a single exemplar channel. Two problems surfaced in post-report review:

1. **Slot competition.** Tool-use and delegation exemplars would compete with voice/disposition/episode material for the same [EXEMPLARS] quota. Procedure displaces character exactly on the turns where tools are in play — which are the turns where character under load matters most.
2. **Category error.** Procedure is a different kind of memory. A procedural exemplar is `{situation → call → result → outcome}`: judged by whether the call pattern worked, not by voice fit; harvested from tool traces and delegation episodes, not conversational scenes; and its natural home is next to the tool definitions it exemplifies.

## Decision

Two context channels, composed independently:

- **Character channel.** Voice/pattern/disposition/episode exemplars, affect line, register — the spec-v1 packet sections, backed by the corpus and the episodic memory store. Quotas, gravity, coupling, and the canon-only disposition slot (ADR-005/ADR-006) live here, unchanged.
- **Procedural channel.** Tool-use/delegation exemplars, shape `{situation → call → result → outcome}`, held in a separate **ProceduralStore** with its own nominator. Rendered as a **[PROCEDURAL]** block placed beside the tool definitions, never inside [EXEMPLARS]. Exemplar files keep the one shared schema (schemas/exemplar.ts); `kind: procedure` is what routes a file into this channel.
- **Native calling preserved.** Tool invocation stays native OpenAI function calling. `fork`, `task`, and `committee` are ordinary tools in the registry — no bespoke spawn protocol — so every subprocess speaks the same call convention and passes the same inhibition gate.
- **Composition rules.** `fork` inherits character + procedural (it is her, thinking on a branch). `task` and committee workers (the "cast", in the owner's terms) receive procedural + brief only — no character channel, no affect line. Delegated work needs competence, not persona.

## Consequences

- Character slots cannot be displaced by procedure; procedural competence scales without touching voice.
- Procedural exemplars sit adjacent to the tool schemas they exemplify — maximal relevance at the decision point. M8's procedural generator and lived delegation episodes both feed the store.
- Subprocess uniformity: one calling convention, one gate, one trace shape feeding credit and consolidation.
- Costs: a second store and nominator, and a [PROCEDURAL] token line that spec-v1's §2.7 packet budget does not allocate — carve it from the turn's tool-observation reserve and revise the budget table (flagged, not silently changed).
- Supersedes the spec-v1 description of fork/task/committee as loop-owned functions (M13): they are registry tools now; caps (depth ≤ 2, concurrency ≤ 3) and delegation-episode events carry over unchanged.
