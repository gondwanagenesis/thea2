// M18 gate — the shared helpers: one formatter per number shape (so both reports
// render the same figures the same way), the counted-by-key list, the typed error
// summary, and the module's one loudness valve (`sibling.incident`). Also the
// run-context rule: job bodies get M16's ctx, the CLI verbs fall back to the
// deps' own clock/rng/events.

import { describe, expect, it } from 'vitest';
import { makeRng } from '../../src/kernel/rng.js';
import { TestClock } from '../../src/kernel/clock.js';
import { LEDGER_JOB_NAME, NIGHTINGALE_JOB_NAME, runCtx } from '../../src/siblings/types.js';
import { countBy, countedList, emitSiblingIncident, errorSummary, minutes, pct, usd } from '../../src/siblings/util.js';
import { harness, recordingLog, eventsOf, rmDir } from './helpers.js';

describe('the number formats (one formatter per shape)', () => {
  it('usd always carries two decimals and the dollar sign', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(7.25)).toBe('$7.25');
    expect(usd(0.5)).toBe('$0.50');
    expect(usd(1234.5)).toBe('$1234.50');
  });

  it('pct is one decimal; a zero whole is n/a, not NaN and not infinity', () => {
    expect(pct(6, 12)).toBe('50.0%');
    expect(pct(1, 8)).toBe('12.5%');
    expect(pct(1, 3)).toBe('33.3%');
    expect(pct(0, 7)).toBe('0.0%');
    expect(pct(0, 0)).toBe('n/a');
    expect(pct(5, 0)).toBe('n/a');
  });

  it('minutes are whole and floored — report-speak for an age', () => {
    expect(minutes(0)).toBe('0 min');
    expect(minutes(59_999)).toBe('0 min');
    expect(minutes(60_000)).toBe('1 min');
    expect(minutes(90_000)).toBe('1 min');
    expect(minutes(5_400_000)).toBe('90 min');
  });
});

describe('countBy / countedList — every report list', () => {
  it('counts by key, sorted by key, stable across input order', () => {
    expect(countBy([])).toEqual([]);
    expect(countBy(['unmoored', 'tilt', 'unmoored'])).toEqual([
      { key: 'tilt', count: 1 },
      { key: 'unmoored', count: 2 },
    ]);
    expect(countBy(['b', 'a', 'b'])).toEqual([
      { key: 'a', count: 1 },
      { key: 'b', count: 2 },
    ]);
  });

  it('countedList renders `key ×n` pairs, or the word none', () => {
    expect(countedList([])).toBe('none');
    expect(countedList(countBy(['low-arousal', 'low-arousal', 'quiet-hours']))).toBe('low-arousal ×2, quiet-hours ×1');
  });
});

describe('errorSummary — typed, never `[object Object]` where a message will do', () => {
  it('keeps the code when it is a string, drops it when it is not', () => {
    expect(errorSummary(Object.assign(new Error('boom'), { code: 'sched/state-corrupt' }))).toEqual({
      code: 'sched/state-corrupt',
      message: 'boom',
    });
    expect(errorSummary(new Error('plain'))).toEqual({ message: 'plain' });
    expect(errorSummary('a string failure')).toEqual({ message: 'a string failure' });
    expect(errorSummary(42)).toEqual({ message: '42' });
    expect(errorSummary({ code: 7, message: 'not an Error' })).toEqual({ message: '[object Object]' });
  });
});

describe('emitSiblingIncident — the module\'s loudness valve', () => {
  it('emits sibling.incident with the source and the error summary, verbatim', async () => {
    const log = recordingLog();
    await emitSiblingIncident(log, 'routing', Object.assign(new Error('routing.json is not valid JSON'), { code: 'routing/bad' }));
    expect(eventsOf(log, 'sibling.incident')).toEqual([
      { source: 'routing', code: 'routing/bad', message: 'routing.json is not valid JSON' },
    ]);
  });

  it('an error without a code emits source + message only (no phantom key)', async () => {
    const log = recordingLog();
    await emitSiblingIncident(log, 'ledger-voice', new Error('endpoint down'));
    expect(eventsOf(log, 'sibling.incident')).toEqual([{ source: 'ledger-voice', message: 'endpoint down' }]);
  });
});

describe('the job names (M16\'s table, M18\'s two rows)', () => {
  it('ledger-report and probe-on-deploy, exactly', () => {
    expect(LEDGER_JOB_NAME).toBe('ledger-report');
    expect(NIGHTINGALE_JOB_NAME).toBe('probe-on-deploy');
  });
});

describe('runCtx — M16\'s ctx, or the deps\' own clock/rng/events', () => {
  it('with no ctx, every field falls back to the deps and there is no signal key', async () => {
    const h = harness('util-runctx-none');
    try {
      const c = runCtx(h.deps);
      expect(c.clock).toBe(h.deps.clock);
      expect(c.rng).toBe(h.deps.rng);
      expect(c.events).toBe(h.deps.events);
      expect(Object.keys(c).sort()).toEqual(['clock', 'events', 'rng']);
    } finally {
      rmDir(h.dirs.root);
    }
  });

  it('a (partial) ctx overrides field by field, and a signal rides along only when given', async () => {
    const h = harness('util-runctx-partial');
    try {
      const clock = new TestClock(7);
      const rng = makeRng('ctx');
      const events = recordingLog();
      const signal = new AbortController().signal;

      const withSignal = runCtx(h.deps, { clock, rng, events, signal });
      expect(withSignal).toEqual({ clock, rng, events, signal });

      const withoutSignal = runCtx(h.deps, { clock });
      expect(withoutSignal.clock).toBe(clock);
      expect(withoutSignal.rng).toBe(h.deps.rng);
      expect(withoutSignal.events).toBe(h.deps.events);
      expect(Object.keys(withoutSignal).sort()).toEqual(['clock', 'events', 'rng']);
    } finally {
      rmDir(h.dirs.root);
    }
  });
});
