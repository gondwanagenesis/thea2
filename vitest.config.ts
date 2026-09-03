import { defineConfig } from "vitest/config";

// Hermetic test doctrine (TESTING.md): every CI test runs offline, offline, offline.
// No test may hit the network, read files outside test fixtures, or depend on
// wall-clock time — modules get TestClock/seeded Rng/MockModel injected instead.
// Live-model and live-embedder checks are probes/ (M19), not unit tests.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    globals: false,
    // Determinism over speed: forks, not threads, so Rng/TestClock state can never
    // leak between files through worker globals.
    pool: "forks",
    // Timeout doctrine (plan v3 §0.1): the 5 s default predated the crown
    // proofs and the corpus tripling — a slow box turned it into false reds.
    // 30 s house default; genuine hangs are bugs and surface as 30 s stalls.
    // Named crown proofs carry higher explicit values with a comment.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // §0.0 unwedge: parallel forks wedged the full suite mid-run on Windows
    // (per-file and serial runs green; only the concurrent fan-out stalled).
    // Deterministic over fast: one fork, files in sequence.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
