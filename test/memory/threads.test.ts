// test/memory — the thread index: the in-memory fold of appraisal thread
// updates (and the second input to threads.json).

import { describe, expect, it } from 'vitest';
import { openThreadIndex } from '../../src/memory/index.js';

describe('ThreadIndex', () => {
  it('folds updates: latest status wins, title carries forward, counts accumulate', () => {
    const t = openThreadIndex();
    t.apply([{ id: 'jazz', title: 'Jazz night', status: 'open' }], 100);
    t.apply([{ id: 'jazz', status: 'touched' }], 200); // no title → keeps the old one
    t.apply([{ id: 'jazz', title: 'Jazz friday', status: 'closed' }], 300);

    const jazz = t.get('jazz');
    expect(jazz).toEqual({ id: 'jazz', title: 'Jazz friday', status: 'closed', updatedAt: 300, updates: 3 });
  });

  it('tracks threads independently and answers all() in id order', () => {
    const t = openThreadIndex();
    t.apply(
      [
        { id: 'thesis', title: 'Chapter two', status: 'open' },
        { id: 'jazz', title: 'Jazz night', status: 'open' },
      ],
      10,
    );
    t.apply([{ id: 'thesis', status: 'touched' }], 20);

    expect(t.size()).toBe(2);
    expect(t.all().map((x) => x.id)).toEqual(['jazz', 'thesis']);
    expect(t.get('thesis')!.updatedAt).toBe(20);
    expect(t.get('thesis')!.updates).toBe(2);
    expect(t.get('missing')).toBeUndefined();
  });

  it('accepts an empty update batch as a no-op', () => {
    const t = openThreadIndex();
    t.apply([], 5);
    expect(t.size()).toBe(0);
  });
});
