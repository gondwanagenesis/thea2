// THE regression. Thea1's pathology 2: ten tags were being written into her
// journal and moved NOTHING, because they never made it into a delta table —
// `sharp` was her 8th most-used word and did not exist. This suite walks the
// entire vocabulary and proves every single tag moves at least one dial in at
// least one scripted scenario, from the resting state, at diary intensity.
// `unspecified` is the one documented exception (a deliberate neutral), and the
// companion test proves it is the ONLY one.

import { describe, expect, it } from 'vitest';
import {
  EMOTION_DELTAS,
  EMOTION_DRIVES,
  EMOTION_TAGS,
  TAG_DRIVE_DELTAS,
  TAG_PRIMARY_DELTAS,
  applyInto,
  type AffectState,
  type EmotionTag,
} from '../../src/affect/index.js';
import { allDims, emo, freshState } from './helpers.js';

const dialTable = EMOTION_DELTAS as Record<string, Record<string, number>>;
const primTable = TAG_PRIMARY_DELTAS as Record<string, Record<string, number>>;
const driveTable = TAG_DRIVE_DELTAS as Record<string, Record<string, number>>;

/** The keys this tag is DECLARED to move, in the moved-summary convention. */
const declaredKeys = (tag: EmotionTag): string[] => [
  ...Object.keys(dialTable[tag] ?? {}),
  ...Object.keys(primTable[tag] ?? {}).map((k) => `p.${k}`),
  ...Object.keys(driveTable[tag] ?? {}).map((k) => `drive.${k}`),
];

/** Every tag, landed from the resting state at a strong-but-not-peak intensity. */
const landFromBaseline = (tag: EmotionTag): { after: AffectState; moved: Record<string, number> } => {
  const r = applyInto(freshState(), [emo(tag, 8, `the ${tag} scenario`)]);
  return { after: r.state, moved: r.moved };
};

describe('every tag moves something (pathology 2 regression)', () => {
  const tags = [...EMOTION_TAGS].sort();

  it('the vocabulary is non-trivial in size', () => {
    expect(tags.length).toBeGreaterThanOrEqual(70);
  });

  for (const tag of tags) {
    if (tag === 'unspecified') continue; // proven separately below
    it(`'${tag}' moves at least one dial from the resting state`, () => {
      const { after, moved } = landFromBaseline(tag);
      const keys = Object.keys(moved).sort();
      // It moves something...
      expect(keys.length, `${tag} moved nothing at all`).toBeGreaterThan(0);
      // ...only through the channels its tables declare — no side effects...
      const declared = declaredKeys(tag);
      for (const k of keys) expect(declared, `${tag} -> ${k} is not in its tables`).toContain(k);
      // ...every recorded landing is real movement (a push that saturates to 0
      // at a boundary is honest absence: not recorded at all)...
      for (const [k, v] of Object.entries(moved)) expect(v, `${tag} -> ${k}`).not.toBe(0);
      // ...and the state it produced is still a state.
      for (const v of Object.values(allDims(after))) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  }

  it('the scripted scenario is the strongest form of the check: same tag, same result', () => {
    // the loop above must not be hiding order dependence — one tag, replayed twice
    const a = landFromBaseline('grieving');
    const b = landFromBaseline('grieving');
    expect(a.moved).toEqual(b.moved);
    expect(a.after.dials).toEqual(b.after.dials);
    expect(a.after.primaries).toEqual(b.after.primaries);
  });
});

describe('the one documented exception', () => {
  it("'unspecified' is a known tag that moves nothing", () => {
    const before = freshState();
    const { state: after, moved } = applyInto(before, [
      { kind: 'emotion', tag: 'unspecified', i: 10, cause: 'x' },
    ]);
    expect(EMOTION_TAGS.has('unspecified')).toBe(true); // known — not an orphan
    expect(moved).toEqual({});
    expect(after.dials).toEqual(before.dials);
    expect(after.primaries).toEqual(before.primaries);
    expect(after.drives).toEqual(before.drives);
  });

  it('and it is the ONLY no-op in the whole vocabulary', () => {
    const noOps = [...EMOTION_TAGS].filter((tag) => Object.keys(landFromBaseline(tag).moved).length === 0);
    expect(noOps).toEqual(['unspecified']);
  });
});

describe('the three consumers stay in sync', () => {
  it('every tag in the drive table also has dial or primary presence (a want is never the only effect)', () => {
    for (const tag of Object.keys(driveTable)) {
      const total = Object.keys(dialTable[tag] ?? {}).length + Object.keys(primTable[tag] ?? {}).length;
      expect(total, tag).toBeGreaterThan(0);
    }
  });

  it('the vocabulary covers every dimension it can trace (drives included)', () => {
    const moved = new Set<string>();
    for (const tag of EMOTION_TAGS) {
      for (const k of declaredKeys(tag)) moved.add(k);
    }
    for (const d of ['novelty', 'connection', 'mastery']) {
      expect(EMOTION_DRIVES).toContain(d); // sanity
    }
    // 32 dimensions exist (20 dials+PAD, 9 primaries, 3 drives); the vocabulary
    // genuinely reaches more than half of them, and every drive is reachable
    expect(moved.size).toBeGreaterThanOrEqual(20);
    for (const d of EMOTION_DRIVES) expect(moved.has(`drive.${d}`), d).toBe(true);
  });
});
