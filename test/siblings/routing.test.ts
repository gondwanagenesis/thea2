// M18 gate — the routing guardrail (ADR-008 §5.6). The evidence rule is
// mechanical, so each threshold gets its own test with a fixture just under and
// just over the line; the guardrail gets the loudest test in the file: a
// user-facing class that meets ALL the evidence still yields a REFUSAL record,
// never a proposal. The target tier is only ever `cheap`.
//
// The `_events` parameter on applyRouting is reserved for a future
// routing-change emission; these tests pass a silent log and deliberately pin
// nothing about it.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import type { EventEnvelope, EventLog } from '../../src/events/index.js';
import { canonicalJson } from '../../src/kernel/index.js';
import {
  DEFAULT_CLASS_TIERS,
  PROPOSAL_COST_SHARE,
  PROPOSAL_MAX_PARSE_FAIL_RATE,
  PROPOSAL_MIN_CALLS,
  PROPOSAL_P95_MS,
  PROPOSAL_TARGET_TIER,
  applyRouting,
  effectiveTier,
  proposeRouting,
  readRoutingTable,
  routingOverrideFor,
} from '../../src/siblings/routing.js';
import type { LedgerAggregate } from '../../src/siblings/types.js';
import { TASK_CLASSES, type RoutingTable, type TaskClass } from '../../src/model/index.js';
import { rmDir, tmpDir, writeText } from './helpers.js';

/** A silent L0 for the writing end — the reserved parameter is pinned nowhere. */
const NO_EVENTS: EventLog = {
  emit: async () => {},
  async *replay(): AsyncGenerator<EventEnvelope> {},
};

/** An aggregate with the defaults a hot, clean, unremarkable class needs. */
const agg = (over: Partial<LedgerAggregate> & { taskClass: TaskClass }): LedgerAggregate => ({
  calls: PROPOSAL_MIN_CALLS,
  inputTokens: 1000,
  outputTokens: 100,
  costUsd: 0,
  latencyP50Ms: 100,
  latencyP95Ms: 100,
  parseFailures: 0,
  ...over,
});

/** The target plus one appraisal filler that owns the rest of the spend.
 * appraisal is already AT the cheap tier, so the filler itself is always silent —
 * the assertions below can demand an exactly-empty ProposalSet. */
const withFiller = (target: LedgerAggregate, fillerCostUsd: number): LedgerAggregate[] => [
  target,
  agg({ taskClass: 'appraisal', calls: 100, costUsd: fillerCostUsd }),
];

describe('the thresholds are the load-bearing constants', () => {
  it('min calls 20, parse-fail rate 0.05, cost share 0.15, p95 8000 ms, target cheap', () => {
    expect(PROPOSAL_MIN_CALLS).toBe(20);
    expect(PROPOSAL_MAX_PARSE_FAIL_RATE).toBe(0.05);
    expect(PROPOSAL_COST_SHARE).toBe(0.15);
    expect(PROPOSAL_P95_MS).toBe(8000);
    expect(PROPOSAL_TARGET_TIER).toBe('cheap');
  });
});

describe('the evidence thresholds, just under and just over', () => {
  it('min calls: 19 observations are a morning, 20 are a pattern', () => {
    const under = proposeRouting(
      withFiller(agg({ taskClass: 'summarize', calls: 19, costUsd: 15, latencyP95Ms: 1000 }), 85),
      [],
    );
    expect(under).toEqual({ proposals: [], refused: [] });

    const over = proposeRouting(
      withFiller(agg({ taskClass: 'summarize', calls: 20, costUsd: 15, latencyP95Ms: 1000 }), 85),
      [],
    );
    expect(over.refused).toEqual([]);
    expect(over.proposals.map((p) => p.taskClass)).toEqual(['summarize']);
  });

  it('parse-fail rate: 5.0% exactly is still clean (<=), 10% is a class that fumbles its output', () => {
    const atLine = proposeRouting(
      withFiller(agg({ taskClass: 'summarize', calls: 20, parseFailures: 1, costUsd: 15, latencyP95Ms: 1000 }), 85),
      [],
    );
    expect(atLine.proposals.map((p) => p.taskClass)).toEqual(['summarize']);

    const over = proposeRouting(
      withFiller(agg({ taskClass: 'summarize', calls: 20, parseFailures: 2, costUsd: 15, latencyP95Ms: 1000 }), 85),
      [],
    );
    expect(over).toEqual({ proposals: [], refused: [] });
  });

  it('cost share: 15.0% of the window spend exactly is heavy, 14.9% is not', () => {
    // 24/160 is the double nearest 0.15 — the same double as the constant, so
    // this pins the inclusive side of >= the way production will see it.
    expect(24 / 160).toBe(PROPOSAL_COST_SHARE);
    const atLine = proposeRouting(
      withFiller(agg({ taskClass: 'summarize', costUsd: 24, latencyP95Ms: 1000 }), 136),
      [],
    );
    expect(atLine.refused).toEqual([]);
    expect(atLine.proposals.map((p) => p.taskClass)).toEqual(['summarize']);

    const under = proposeRouting(
      withFiller(agg({ taskClass: 'summarize', costUsd: 149, latencyP95Ms: 1000 }), 851),
      [],
    );
    // Not heavy, and not slow either: the class has no other leg to stand on.
    expect(under).toEqual({ proposals: [], refused: [] });
  });

  it('p95 latency: 8000 ms exactly is a felt class, 7999 ms is not', () => {
    const atLine = proposeRouting(
      withFiller(agg({ taskClass: 'summarize', costUsd: 149, latencyP95Ms: PROPOSAL_P95_MS }), 851),
      [],
    );
    expect(atLine.proposals.map((p) => p.taskClass)).toEqual(['summarize']);

    const under = proposeRouting(
      withFiller(agg({ taskClass: 'summarize', costUsd: 149, latencyP95Ms: PROPOSAL_P95_MS - 1 }), 851),
      [],
    );
    expect(under).toEqual({ proposals: [], refused: [] });
  });

  it('hot and clean but neither heavy nor slow is silence — no proposal AND no refusal', () => {
    const set = proposeRouting(
      withFiller(agg({ taskClass: 'summarize', costUsd: 1, latencyP95Ms: 1000 }), 99),
      [],
    );
    expect(set.proposals).toEqual([]);
    expect(set.refused).toEqual([]);
  });

  it('the numbers ride in the reason string, so a proposal is auditable from the file alone', () => {
    const set = proposeRouting(
      withFiller(agg({ taskClass: 'summarize', calls: 40, parseFailures: 2, costUsd: 30, latencyP95Ms: 1000 }), 90),
      [],
    );
    expect(set.proposals[0]?.reason).toBe(
      '40 calls, $30.00 (25.0% of window spend), p95 1000 ms, 5.0% parse failures' +
        ' — downgrade is cheap-tier-safe and Nightingale gates the change',
    );
  });
});

describe('the guardrail (the reason this module exists)', () => {
  it('a user-facing class that meets ALL the evidence is refused, never proposed', () => {
    const set = proposeRouting(
      withFiller(agg({ taskClass: 'turn', costUsd: 25, latencyP95Ms: 1000 }), 75),
      [],
    );
    expect(set.proposals).toEqual([]);
    expect(set.refused).toHaveLength(1);
    expect(set.refused[0]?.taskClass).toBe('turn');
    expect(set.refused[0]?.proposedTier).toBe('cheap');
    // The refusal keeps the evidence: the answer is no, and it says why honestly.
    expect(set.refused[0]?.reason).toBe(
      'turn is pinned to the main tier in code (ADR-008) — the evidence was real' +
        ' (20 calls, $25.00 (25.0% of window spend), p95 1000 ms, 0.0% parse failures)' +
        ', the answer is still no',
    );
  });

  it('the same pass can refuse turn and propose a cheaper class beside it', () => {
    const set = proposeRouting(
      [
        agg({ taskClass: 'turn', costUsd: 6, latencyP95Ms: 1000 }),
        agg({ taskClass: 'summarize', costUsd: 6, latencyP95Ms: 1000 }),
      ],
      [],
    );
    expect(set.refused.map((r) => r.taskClass)).toEqual(['turn']);
    expect(set.proposals.map((p) => p.taskClass)).toEqual(['summarize']);
    expect(set.proposals[0]?.from).toBe('main');
    expect(set.proposals[0]?.to).toBe('cheap');
  });

  it('the target tier is only ever cheap, whatever the evidence says', () => {
    expect(PROPOSAL_TARGET_TIER).toBe('cheap');
    const set = proposeRouting(
      TASK_CLASSES.map((tc) => agg({ taskClass: tc, latencyP95Ms: 9000, costUsd: 1 })),
      [],
    );
    for (const p of set.proposals) expect(p.to).toBe('cheap');
    for (const r of set.refused) expect(r.proposedTier).toBe('cheap');
  });

  it('a class already at or below the target is silence — nothing was asked for', () => {
    for (const taskClass of ['appraisal', 'consolidate'] as const) {
      const set = proposeRouting([agg({ taskClass, costUsd: 10, latencyP95Ms: 9000 })], []);
      expect(set.proposals).toEqual([]);
      expect(set.refused).toEqual([]);
    }
  });
});

describe('the all-nine-classes table', () => {
  it('every task class, maximal evidence: 6 proposals, 1 refusal, 2 silences — and the from tiers are the callers\' defaults', () => {
    const set = proposeRouting(
      TASK_CLASSES.map((tc) => agg({ taskClass: tc, latencyP95Ms: 9000, costUsd: 1 })),
      [],
    );
    expect(set.proposals.map((p) => [p.taskClass, p.from, p.to])).toEqual([
      ['derive', 'main', 'cheap'],
      ['heartbeat-thought', 'main', 'cheap'],
      ['judge', 'reasoning', 'cheap'],
      ['ponder-seed', 'main', 'cheap'],
      ['probe-judge', 'reasoning', 'cheap'],
      ['summarize', 'main', 'cheap'],
    ]);
    expect(set.refused.map((r) => r.taskClass)).toEqual(['turn']);
    // appraisal and consolidate already ride cheap: absent from both lists.
    const named = [...set.proposals, ...set.refused].map((r) => r.taskClass);
    expect(named.includes('appraisal')).toBe(false);
    expect(named.includes('consolidate')).toBe(false);
  });
});

describe('override resolution (last entry wins, like M03 resolves)', () => {
  it('routingOverrideFor takes the LAST entry for a class', () => {
    expect(routingOverrideFor([], 'summarize')).toBeUndefined();
    const table: RoutingTable = [
      { taskClass: 'summarize', tier: 'cheap' },
      { taskClass: 'derive', tier: 'main' },
      { taskClass: 'summarize', tier: 'reasoning', reason: 'the human changed their mind' },
    ];
    expect(routingOverrideFor(table, 'summarize')?.tier).toBe('reasoning');
    expect(routingOverrideFor(table, 'derive')?.tier).toBe('main');
    expect(routingOverrideFor(table, 'turn')).toBeUndefined();
  });

  it('effectiveTier is the override, else the class default — and the default table is pinned', () => {
    expect(DEFAULT_CLASS_TIERS).toEqual({
      turn: 'main',
      appraisal: 'cheap',
      'heartbeat-thought': 'main',
      'ponder-seed': 'main',
      consolidate: 'cheap',
      derive: 'main',
      judge: 'reasoning',
      'probe-judge': 'reasoning',
      summarize: 'main',
    });
    expect(effectiveTier('summarize', [])).toBe('main');
    expect(effectiveTier('summarize', [{ taskClass: 'summarize', tier: 'reasoning' }])).toBe('reasoning');
    // A downgrade proposal names the tier the class ACTUALLY rides today.
    const set = proposeRouting(
      [agg({ taskClass: 'summarize', latencyP95Ms: 9000, costUsd: 1 })],
      [{ taskClass: 'summarize', tier: 'reasoning' }],
    );
    expect(set.proposals[0]?.from).toBe('reasoning');
  });
});

describe('readRoutingTable', () => {
  it('an absent file is a valid empty table (the normal first week)', async () => {
    const dir = tmpDir('routing-absent');
    try {
      expect(await readRoutingTable(`${dir}/var/routing.json`)).toEqual([]);
    } finally {
      rmDir(dir);
    }
  });

  it('a well-formed file round-trips, reason optional', async () => {
    const dir = tmpDir('routing-read');
    try {
      const file = `${dir}/var/routing.json`;
      writeText(
        file,
        canonicalJson([
          { taskClass: 'summarize', tier: 'cheap', reason: 'probe-gated' },
          { taskClass: 'derive', tier: 'cheap' },
        ]),
      );
      expect(await readRoutingTable(file)).toEqual([
        { taskClass: 'summarize', tier: 'cheap', reason: 'probe-gated' },
        { taskClass: 'derive', tier: 'cheap' },
      ]);
    } finally {
      rmDir(dir);
    }
  });

  it('a file that is not JSON, violates the shape, or names an unknown class is a LOUD typed throw', async () => {
    const dir = tmpDir('routing-bad');
    try {
      const file = `${dir}/var/routing.json`;
      writeText(file, '{oops');
      await expect(readRoutingTable(file)).rejects.toThrow(/routing\.json is not valid JSON/);

      writeText(file, canonicalJson([{ taskClass: 'summarize', tier: 'bargain' }]));
      await expect(readRoutingTable(file)).rejects.toThrow(/violates the routing table shape/);

      writeText(file, canonicalJson([{ taskClass: 'summarize' }]));
      await expect(readRoutingTable(file)).rejects.toThrow(/violates the routing table shape/);

      writeText(file, canonicalJson([{ taskClass: 'ghost-class', tier: 'cheap' }]));
      await expect(readRoutingTable(file)).rejects.toThrow(/unknown task class 'ghost-class'/);
    } finally {
      rmDir(dir);
    }
  });
});

describe('applyRouting — the writing end of the guardrail', () => {
  it('an unreadable file is NEVER overwritten: a human\'s hand edit survives untouched', async () => {
    const dir = tmpDir('routing-unreadable');
    try {
      const file = `${dir}/var/routing.json`;
      const humanEdit = canonicalJson([{ taskClass: 'judge', tier: 'cheap', reason: 'human' }]);
      writeText(file, humanEdit);

      const result = await applyRouting(
        file,
        null,
        [{ taskClass: 'summarize', from: 'main', to: 'cheap', reason: 'evidence' }],
        NO_EVENTS,
      );

      expect(result).toEqual({ changed: false, table: null, written: [], unreadable: true });
      expect(fs.readFileSync(file, 'utf8')).toBe(humanEdit);
    } finally {
      rmDir(dir);
    }
  });

  it('nothing to write means no write: an empty proposal list leaves the file byte-identical', async () => {
    const dir = tmpDir('routing-empty');
    try {
      const file = `${dir}/var/routing.json`;
      writeText(file, canonicalJson([{ taskClass: 'derive', tier: 'cheap' }]));
      const before = fs.readFileSync(file, 'utf8');

      const result = await applyRouting(file, [{ taskClass: 'derive', tier: 'cheap' }], [], NO_EVENTS);

      expect(result).toEqual({
        changed: false,
        table: [{ taskClass: 'derive', tier: 'cheap' }],
        written: [],
        unreadable: false,
      });
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    } finally {
      rmDir(dir);
    }
  });

  it('accepted proposals are merged over the table and written canonically', async () => {
    const dir = tmpDir('routing-apply');
    try {
      const file = `${dir}/var/routing.json`;
      const current: RoutingTable = [
        { taskClass: 'derive', tier: 'reasoning', reason: 'a previous accept' },
        { taskClass: 'judge', tier: 'reasoning' },
      ];
      writeText(file, canonicalJson(current));

      const result = await applyRouting(
        file,
        current,
        [{ taskClass: 'summarize', from: 'main', to: 'cheap', reason: 'hot and cheap-tier-safe' }],
        NO_EVENTS,
      );

      const merged: RoutingTable = [
        { taskClass: 'derive', tier: 'reasoning', reason: 'a previous accept' },
        { taskClass: 'judge', tier: 'reasoning' },
        { taskClass: 'summarize', tier: 'cheap', reason: 'hot and cheap-tier-safe' },
      ];
      expect(result).toEqual({
        changed: true,
        table: merged,
        written: [{ taskClass: 'summarize', from: 'main', to: 'cheap', reason: 'hot and cheap-tier-safe' }],
        unreadable: false,
      });
      expect(fs.readFileSync(file, 'utf8')).toBe(canonicalJson(merged));
      expect(await readRoutingTable(file)).toEqual(merged);
    } finally {
      rmDir(dir);
    }
  });

  it('an existing entry for the proposed class is superseded, not duplicated', async () => {
    const dir = tmpDir('routing-supersede');
    try {
      const file = `${dir}/var/routing.json`;
      const current: RoutingTable = [
        { taskClass: 'summarize', tier: 'reasoning', reason: 'a human experiment' },
        { taskClass: 'derive', tier: 'main' },
      ];
      writeText(file, canonicalJson(current));

      const result = await applyRouting(
        file,
        current,
        [{ taskClass: 'summarize', from: 'reasoning', to: 'cheap', reason: 'downgrade' }],
        NO_EVENTS,
      );

      expect(result.table).toEqual([
        { taskClass: 'derive', tier: 'main' },
        { taskClass: 'summarize', tier: 'cheap', reason: 'downgrade' },
      ]);
      expect(fs.readFileSync(file, 'utf8')).toBe(canonicalJson(result.table));
    } finally {
      rmDir(dir);
    }
  });

  it('an already-identical table is never rewritten, so an unchanged routing.json cannot bump the deploy marker', async () => {
    const dir = tmpDir('routing-identical');
    try {
      const file = `${dir}/var/routing.json`;
      const current: RoutingTable = [{ taskClass: 'summarize', tier: 'cheap', reason: 'downgrade' }];
      writeText(file, canonicalJson(current));
      const before = fs.readFileSync(file, 'utf8');

      const result = await applyRouting(
        file,
        current,
        [{ taskClass: 'summarize', from: 'main', to: 'cheap', reason: 'downgrade' }],
        NO_EVENTS,
      );

      expect(result.changed).toBe(false);
      expect(result.written).toEqual([]);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    } finally {
      rmDir(dir);
    }
  });
});
