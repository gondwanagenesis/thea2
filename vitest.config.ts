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
    // CI runs the full suite serially enough to keep golden replays stable.
    fileParallelism: true,
    sequence: { concurrent: false },
  },
});
