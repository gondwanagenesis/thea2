// test/spine helpers — the one harness every spine suite runs on: a TestClock +
// recording event log, fake child processes standing in for `opencode serve`
// (never the real binary — hermetic law), a runner factory over the local stub,
// and clock pumps for the supervision paths.

import { TestClock } from '../../src/kernel/index.js';
import { resolveSpineConfig, OpenCodeRunner, type ResolvedSpineConfig, type SpineChild, type SpawnFn, type StreamEvent } from '../../src/spine/index.js';
import type { LoopEntry } from '../../src/loop/index.js';
import { recordingLog, type RecordingLog } from '../loop/helpers.js';
import { startSpineStub, type SpineStub } from './sse-stub.js';

export { startSpineStub, loadFrames, type SseFrame, type StubTurn, type SpineStub } from './sse-stub.js';
export { stubPacket, recordingLog, type RecordingLog } from '../loop/helpers.js';

/** Collects an AsyncIterable<StreamEvent> into an array (turn-scoped asserts). */
export const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};

/** A Diego turn, as the bridge would hand it over. */
export const diegoTurn = (text = 'the deploy is failing again, the systemd unit keeps restarting'): LoopEntry => ({
  kind: 'user-turn',
  inbound: {
    updateId: 1,
    msgId: 1,
    chatId: 6971556140,
    ts: 0,
    text,
    speaker: { person: 'tg:6971556140', channel: 'telegram' },
  },
});

/** A fake `opencode serve` child: records kill(), fans out the exit event. */
export class FakeChild implements SpineChild {
  readonly pid: number;
  killed = false;
  private exitCb: ((code: number | null, signal: string | null) => void) | undefined;

  constructor(seq: number) {
    this.pid = 4242 + seq;
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCb = cb;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emitExit(code: number | null = null, signal: string | null = null): void {
    this.exitCb?.(code, signal);
  }
}

export interface RunnerHarness {
  runner: OpenCodeRunner;
  clock: TestClock;
  events: RecordingLog;
  children: FakeChild[];
  spawnCalls: Array<{ cmd: string; args: readonly string[]; env: Record<string, string> }>;
  cfg: ResolvedSpineConfig;
}

export interface RunnerHarnessOpts {
  bootTimeoutMs?: number;
  healthPollMs?: number;
  turnIdleTimeoutMs?: number;
  restartBackoffBaseMs?: number;
  maxBootAttempts?: number;
}

/** Wires an OpenCodeRunner against the loopback stub with FAKE children: the
 * spawn seam is injected, so no test can ever launch a real binary. */
export const makeRunner = (opts: RunnerHarnessOpts & { port: number }): RunnerHarness => {
  const clock = new TestClock(1_000_000);
  const events = recordingLog();
  const children: FakeChild[] = [];
  const spawnCalls: Array<{ cmd: string; args: readonly string[]; env: Record<string, string> }> = [];
  const cfg = resolveSpineConfig(
    {
      version: '1.18.3',
      port: opts.port,
      model: { providerID: 'voice', modelID: 'glm-5.3', door: 'voice' },
      ...(opts.bootTimeoutMs !== undefined ? { bootTimeoutMs: opts.bootTimeoutMs } : {}),
      ...(opts.healthPollMs !== undefined ? { healthPollMs: opts.healthPollMs } : {}),
      ...(opts.turnIdleTimeoutMs !== undefined ? { turnIdleTimeoutMs: opts.turnIdleTimeoutMs } : {}),
      ...(opts.restartBackoffBaseMs !== undefined ? { restartBackoffBaseMs: opts.restartBackoffBaseMs } : {}),
      ...(opts.maxBootAttempts !== undefined ? { maxBootAttempts: opts.maxBootAttempts } : {}),
    },
    { THEA2_SPINE_TOKEN: 'test-token' },
  );
  const spawnProc: SpawnFn = (cmd, args, spawnOpts) => {
    spawnCalls.push({ cmd, args, env: spawnOpts.env });
    const child = new FakeChild(children.length);
    children.push(child);
    return child;
  };
  const runner = new OpenCodeRunner(cfg, { clock, events, spawnProc });
  return { runner, clock, events, children, spawnCalls, cfg };
};

/** Wires harness + stub together (most tests want both). */
export const makeRunnerOnStub = async (opts: RunnerHarnessOpts = {}): Promise<RunnerHarness & { stub: SpineStub }> => {
  const stub = await startSpineStub();
  return { ...makeRunner({ ...opts, port: stub.port }), stub };
};

/** Advances the TestClock in steps until `until()` holds, yielding to the real
 * event loop between steps so the runner's loopback fetches can settle. */
export const pumpClock = async (clock: TestClock, until: () => boolean, stepMs = 50, maxSteps = 400): Promise<void> => {
  let steps = 0;
  while (!until()) {
    await clock.advance(stepMs);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (++steps > maxSteps) throw new Error('pumpClock: condition never met within the step cap');
  }
};
