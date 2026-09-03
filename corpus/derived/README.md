# corpus/derived — a committed build artifact

ADR-007: this directory is GENERATED (`thea2 derive`, on a dev machine, with
the real model and judge) and then **committed together with its
`manifest.json`**, so that `thea2 corpus:check` can prove in CI — with no model
— that what is on `main` is exactly what the manifest attests: judge-approved,
byte for byte, with provenance back to the canon scene each file came from.

Rules:

- Never run `thea2 derive` on the production host (the process lock refuses it
  while `thead` runs; ADR-007 forbids it regardless). Prod only *reports*
  staleness.
- Never hand-edit a derived file. Edit the canon scene and re-derive; the
  content-addressed ids make a stale file obvious.
- A canon edit leaves `corpus:check` red until someone re-derives and commits.
  That friction is the feature.

Review note (2026-09-02): this directory was untracked on both the dev box and
the VPS, with different contents on each — the flywheel had never actually
been committed. The README exists so that state is not mistaken for normal.
