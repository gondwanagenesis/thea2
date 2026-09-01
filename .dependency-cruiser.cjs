/**
 * Dependency rules for thea2 — the planned DAG from ARCHITECTURE.md, enforced.
 *
 * Each module may import ONLY the modules listed in its spec frontmatter
 * (docs/modules/Mxx-*.md → `depends:`). The table below mirrors those
 * frontmatter fields exactly; when a spec's depends changes, change it here
 * in the same commit.
 *
 * Rules that reference not-yet-existing files are inert until the files land
 * (dependency-cruiser simply matches nothing), so this config ships with the
 * spec corpus and starts biting at S1 without modification.
 */

/** Map of src module path → the only modules it may depend on. */
const MODULES = {
  "src/kernel": [],
  "src/events": ["kernel"],
  "src/model": ["kernel", "events"],
  "src/embed": ["kernel"],
  "src/affect": ["kernel", "events"],
  "src/coupling": ["kernel", "affect"],
  "src/corpus": ["kernel", "embed"],
  "src/derive": ["kernel", "events", "model", "embed", "corpus"],
  "src/memory": ["kernel", "events", "model", "embed"],
  "src/consolidate": ["kernel", "events", "model", "embed", "affect", "corpus", "memory"],
  "src/assemble": ["kernel", "embed", "coupling", "corpus", "memory"],
  "src/inhibit": ["kernel", "model"],
  "src/loop": ["kernel", "events", "model", "memory", "inhibit"],
  "src/realize": ["kernel", "coupling", "bridge"],
  "src/bridge": ["kernel", "events"],
  "src/sched": ["kernel", "events"],
  "src/life": ["kernel", "events", "model", "affect", "memory", "loop", "sched"],
  "src/siblings": ["kernel", "events", "model", "sched", "probes"],
  "src/probes": ["kernel", "events", "model", "embed", "corpus"],
  "src/app": [
    "kernel", "events", "model", "embed", "affect", "coupling", "corpus",
    "memory", "assemble", "inhibit", "loop", "realize", "bridge", "sched",
  ],
};

/** Build an `allowed`-style rule body for one module. */
const moduleRule = ([dir, deps]) => ({
  name: `deps-of-${dir.replace("src/", "")}`,
  severity: "error",
  comment:
    `${dir} may import only: ${deps.length ? deps.join(", ") : "nothing (leaf)"}` +
    ` — mirrors docs/modules depends frontmatter.`,
  from: { path: `^${dir}/` },
  to: {
    // everything under src/ that is not this module and not in the allowed set
    path: `^src/(?!${dir}/)`,
    pathNot: deps.map((d) => `^src/${d}/`),
  },
});

module.exports = {
  forbidden: [
    ...Object.entries(MODULES).map(moduleRule),

    {
      name: "no-module-outside-planned-dag",
      severity: "error",
      comment: "New src/ top-level dirs require an ARCHITECTURE.md + spec change first.",
      from: {},
      to: { path: "^src/(?!(" + Object.keys(MODULES).map((d) => d.replace("src/", "")).join("|") + ")/)" },
    },
    {
      name: "app-not-imported-anywhere",
      severity: "error",
      comment: "M20-app is the composition root; nothing imports it (M19-probes gets its target injected, never imported).",
      from: { path: "^(?!src/app/)" },
      to: { path: "^src/app/" },
    },
    {
      name: "no-cross-testing-imports",
      severity: "error",
      comment: "Test helpers live in test/helpers and are imported by tests only.",
      from: { path: "^(?!test/)" },
      to: { path: "^test/" },
    },
    {
      name: "no-secrets-in-imports",
      severity: "error",
      comment: "Module code never reads keys.env / .env directly — config arrives injected via M01 kernel/M03 model.",
      from: { path: "^src/" },
      to: { path: "\\.env|keys\\.env" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { extensions: [".ts", ".js"] },
  },
};
