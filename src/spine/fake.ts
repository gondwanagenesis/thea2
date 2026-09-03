// M21 spine — FakeRunner (S1.1), the hermetic SpineRunner double. Replays
// scripted StreamEvent sequences from JSON fixtures (test/spine/fixtures/);
// every decision a fixture carries is validated through src/loop's own decision
// parse AT LOAD, so a malformed fixture fails loud at construction, not mid-turn.
// CI runs this runner and only this runner (D.7-3: no test touches a live spine).

import type { ToolDef } from '../model/index.js';
import { parseDecisionValue } from '../loop/loop.js';
import type { LoopEntry, LoopPacket, ModelDecision } from '../loop/index.js';
import type { SpineRunOpts, SpineRunner, SpineUsage, StreamEvent } from './types.js';

/** The JSON fixture shapes — one tagged object per StreamEvent, wire-friendly. */
export type StreamEventFixture =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; args: unknown }
  | { type: 'decide-object'; decision: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number; latencyMs?: number }
  | { type: 'stop-reason'; stopReason: string };

/** What one replayed turn looked like from the loop's side. */
export interface FakeTurnRequest {
  entry: LoopEntry;
  packet: LoopPacket;
  tools: readonly ToolDef[];
  opts: SpineRunOpts;
  systemText: string;
  proceduralText: string | null;
  trailerText: string;
}

const parseDecideFixture = (raw: unknown): ModelDecision => {
  const parsed = parseDecisionValue(raw);
  if (!parsed.ok) {
    throw new Error(`spine/fake-bad-fixture: decide-object does not parse through the loop schema: ${parsed.error}`);
  }
  return parsed.value;
};

const coerceFixture = (fixture: StreamEventFixture): StreamEvent => {
  switch (fixture.type) {
    case 'text-delta':
      return { type: 'text-delta', text: fixture.text };
    case 'tool-call':
      return { type: 'tool-call', call: { id: fixture.id, name: fixture.name, args: fixture.args } };
    case 'decide-object':
      return { type: 'decide-object', decision: parseDecideFixture(fixture.decision) };
    case 'usage': {
      const usage: SpineUsage = {
        inputTokens: fixture.inputTokens,
        outputTokens: fixture.outputTokens,
        ...(fixture.costUsd !== undefined ? { costUsd: fixture.costUsd } : {}),
        latencyMs: fixture.latencyMs ?? 0,
        attempts: 1,
      };
      return { type: 'usage', usage };
    }
    case 'stop-reason':
      return { type: 'stop-reason', stopReason: fixture.stopReason };
    default: {
      const never: never = fixture;
      throw new Error(`spine/fake-bad-fixture: unknown fixture event ${(never as { type?: string }).type ?? '?'}`);
    }
  }
};

/**
 * One script per run() call, consumed FIFO. Fixtures are validated (and
 * coerced to StreamEvents) AT CONSTRUCTION — a malformed fixture fails loud
 * before any turn runs. A run with no script left throws — a silently empty
 * turn would masquerade as a decided silence downstream.
 */
export class FakeRunner implements SpineRunner {
  readonly requests: FakeTurnRequest[] = [];
  private readonly scripts: StreamEvent[][];

  constructor(scripts: StreamEventFixture[][]) {
    this.scripts = scripts.map((events) => events.map(coerceFixture));
  }

  /** Accepts `{events: [...]}` or a bare array, as the fixture files store them. */
  static fromFixture(json: unknown): FakeRunner {
    const events = Array.isArray(json) ? json : (json as { events?: StreamEventFixture[] })?.['events'];
    if (!Array.isArray(events)) throw new Error('spine/fake-bad-fixture: expected {events: [...]} or an array');
    return new FakeRunner([events as StreamEventFixture[]]);
  }

  async *run(entry: LoopEntry, packet: LoopPacket, tools: readonly ToolDef[], opts: SpineRunOpts): AsyncGenerator<StreamEvent> {
    const script = this.scripts.shift();
    if (script === undefined) {
      throw new Error('spine/fake-exhausted: no scripted turn left — the test replay ran past its fixtures');
    }
    this.requests.push({
      entry,
      packet,
      tools,
      opts,
      systemText: packet.systemText(),
      proceduralText: packet.proceduralText(),
      trailerText: packet.trailerText(),
    });
    for (const event of script) {
      yield event;
    }
  }
}
