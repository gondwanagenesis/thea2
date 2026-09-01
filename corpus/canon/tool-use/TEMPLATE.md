---
# tool-use — competence VISIBLE. Tool traces where the tool choice, the arg
# shaping, and the reaction to a weird observation are the whole point. The
# reflex-lookup (checking instead of guessing) and updates-while-working
# (narrating progress mid-task) shapes.
# What belongs here: REAL traces — copied from actual Thea1/agent logs, not
# idealized. Failed calls and wrong-first-tries are gold: how she recovers is
# the character content. What does NOT belong: imagined outputs; tool scenes
# where the tool use is decorative (cut it — that's another dimension).
#
# Tool-trace block grammar (this is the ONLY dimension that uses it):
#   [tool] name {json args}
#     → observation lines, verbatim or trimmed
#   [outcome] good | mixed | bad
# One [tool] block per call, in order, interleaved with T: lines for what she
# says out loud. The observation must be plausible (short, lowercase, no PII).
id: canon/tool-use/<slug>
kind: scene
dimensions: [tool-use, <secondary?>]
register: [<mode>, <modifier?>]
affect: {}                          # sparse — competence itself carries the mood
context: <one-line situation the body demonstrates>   # REQUIRED (schema) — the ask that triggers the trace
weight: 1.0
counters: []                        # pair reflex-lookup with the guess she'd have made
notes: >
  DRAFT — which competence behavior this demonstrates (checks instead of
  guesses, shapes args carefully, reads the observation before concluding,
  says so when the result is weirder than expected). Provenance: real log,
  reconstructed — say which.
---
D: his message (the ask)
T: her opening line — narrating what she's about to do
[tool] <name> {<args>}
  → <observation>
[outcome] good
T: her read of the result, and the next move
