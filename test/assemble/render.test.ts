// M11 render tests — the [EXEMPLARS] section's placement and label laws:
//   - the contrast slot renders BEFORE the episode-memory exemplars, under its
//     one-word `elsewhere:` label (anti-convergence: the foreign body lands
//     mid-packet, named, not as a tail note);
//   - a canon scene flagged `disposition: true` fills the keel slot through the
//     real schema/parse path (ADR-006's canon-only law is untouched).
//
// Fixture exemplars only — the six canon files carrying a commented
// `# disposition: true` are Diego's hand to un-comment, never a test's.

import { describe, expect, it } from 'vitest';
import { assemble } from '../../src/assemble/assemble.js';
import { DEFAULT_ASSEMBLE_CONFIG, type AssembleConfig } from '../../src/assemble/index.js';
import { buildIndex } from '../../src/corpus/corpus-index.js';
import { CONTRAST_LABEL } from '../../src/assemble/render.js';
import {
  DIR_A,
  DIR_B,
  assembleDeps,
  canonFile,
  flat12,
  neutralCoherenceCfg,
  query,
  sceneBody,
  slotsOf,
  staticNominator,
  testCorpusNominator,
  vec3,
} from './helpers.js';

const QVEC = vec3(DIR_A);
const FLAT = flat12();

describe('the contrast slot in the rendered packet', () => {
  it('contrast renders before episodes with its label', async () => {
    const packet = await assemble(
      query({ queryVec: QVEC, turnId: 'turn-contrast' }),
      FLAT,
      assembleDeps(
        {
          nominators: [
            staticNominator('character', [
              { id: 'ep/a', tier: 'episode', source: 'lived', baseScore: 3, vec: vec3(DIR_A), render: () => 'EPISODE-A body' },
              { id: 'ep/b', tier: 'episode', source: 'lived', baseScore: 2, vec: vec3(DIR_A), render: () => 'EPISODE-B body' },
              // The far, low-scoring leftover is the one the contrast slot wants.
              // (A vector, or L3 embedding-sanity would drop it as unverifiable.)
              { id: 'far/c', tier: 'pattern', baseScore: 0.1, sig: { sadness: -1, disgust: 0.8 }, vec: vec3(DIR_A), render: () => 'CONTRAST body' },
            ]),
          ],
        },
        neutralCoherenceCfg({
          quotas: { disposition: 0, pattern: 0, episodeMemoryMin: 2, episodeMemoryMax: 2, contrast: 1, proceduralMax: 0 },
        }),
      ),
    );
    // Label + placement, byte-exact: `elsewhere:` names the foreign body, and it
    // sits FIRST — before the episode-memory exemplars that follow it.
    expect(packet.sections['EXEMPLARS']).toBe(
      '[EXEMPLARS]\nelsewhere:\nCONTRAST body\n\nEPISODE-A body\n\nEPISODE-B body',
    );
    expect(packet.systemText().match(/elsewhere:/g)).toHaveLength(1);
    // The record follows the rendered order, not the fill order.
    expect(packet.record().slots.map((s) => s.exemplarId)).toEqual(['far/c', 'ep/a', 'ep/b']);
  });

  it('the label rides only the contrast slot — regular exemplars render unlabeled', async () => {
    const files = [
      canonFile({ dim: 'voice', slug: 'plain', register: ['play'], body: sceneBody('PLAIN body') }),
      // id-sorted after 'plain', so the fill consumes plain as the pattern and
      // the far-signature scene is the leftover the contrast slot takes.
      canonFile({ dim: 'voice', slug: 'z-far', register: ['play'], affect: 'sadness: -0.9', body: sceneBody('FAR body') }),
    ];
    const vectors = new Map<string, Float32Array>([
      ['canon/voice/plain', vec3(DIR_A)],
      ['canon/voice/z-far', vec3(DIR_A)],
    ]);
    const packet = await assemble(
      query({ queryVec: QVEC, turnId: 'turn-label' }),
      FLAT,
      assembleDeps(
        {
          nominators: [testCorpusNominator(buildIndex(files), vectors, DEFAULT_ASSEMBLE_CONFIG)],
        },
        neutralCoherenceCfg({
          quotas: { disposition: 0, pattern: 1, episodeMemoryMin: 0, episodeMemoryMax: 0, contrast: 1, proceduralMax: 0 },
        }),
      ),
    );
    const exemplars = packet.sections['EXEMPLARS'] ?? '';
    expect(exemplars).toContain(CONTRAST_LABEL);
    expect(exemplars.indexOf(CONTRAST_LABEL)).toBeGreaterThan(exemplars.indexOf('situation: fixture exemplar plain'));
    expect(exemplars.match(new RegExp(CONTRAST_LABEL, 'g'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// disposition flag (ADR-006) through the real schema + quota fill
// ---------------------------------------------------------------------------

const keelCorpus = (flagged: boolean): ReturnType<typeof buildIndex> =>
  buildIndex([
    canonFile({
      dim: 'voice',
      slug: 'flagged-keel',
      register: ['play'],
      disposition: flagged,
      body: sceneBody('the keel scene flagged in frontmatter'),
    }),
    canonFile({ dim: 'taste', slug: 'stmt-keel', kind: 'statement', register: ['play'], body: 'the statement keel' }),
    canonFile({ dim: 'voice', slug: 'pat-a', register: ['play'], body: sceneBody('PATTERN-A material') }),
    canonFile({ dim: 'voice', slug: 'pat-b', register: ['play'], body: sceneBody('PATTERN-B material') }),
    canonFile({ dim: 'social', slug: 'ep-a', register: ['play'], body: sceneBody('EPISODE-A material') }),
    canonFile({ dim: 'social', slug: 'ep-b', register: ['play'], body: sceneBody('EPISODE-B material') }),
    canonFile({ dim: 'social', slug: 'ep-c', register: ['play'], body: sceneBody('EPISODE-C material') }),
    canonFile({ dim: 'taste', slug: 'far', register: ['play'], affect: 'sadness: -0.9', body: sceneBody('FAR material') }),
  ]);

const vectorsFor = (): Map<string, Float32Array> => {
  const m = new Map<string, Float32Array>();
  for (const id of [
    'canon/voice/flagged-keel',
    'canon/voice/pat-a',
    'canon/voice/pat-b',
    'canon/social/ep-a',
    'canon/social/ep-b',
    'canon/social/ep-c',
    'canon/taste/far',
  ]) {
    m.set(id, vec3(DIR_A));
  }
  m.set('canon/taste/stmt-keel', vec3(DIR_B)); // orthogonal: loses the slot to the flagged scene
  return m;
};

const keelPacket = async (flagged: boolean): Promise<ReturnType<typeof assemble>> => {
  const cfg: AssembleConfig = neutralCoherenceCfg();
  return assemble(
    query({ queryVec: QVEC, turnId: flagged ? 'turn-keel' : 'turn-no-keel' }),
    FLAT,
    assembleDeps(
      { nominators: [testCorpusNominator(keelCorpus(flagged), vectorsFor(), cfg)] },
      cfg,
    ),
  );
};

describe('the disposition flag fills the keel slot (ADR-006)', () => {
  it('disposition-flagged canon scene fills the keel slot', async () => {
    const packet = await keelPacket(true);
    expect(slotsOf(packet, 'disposition')).toEqual(['canon/voice/flagged-keel']);
    expect(packet.record().flags.scarcity).toBe(false);
    // The flagged scene renders with the frame like any other exemplar — tier
    // changes the slot, never the rendering law.
    expect(packet.sections['EXEMPLARS']).toContain('situation: fixture exemplar flagged-keel');
  });

  it('scene without the flag does not', async () => {
    const packet = await keelPacket(false);
    // The keel falls back to the canon statement; the unflagged scene stays
    // pattern/episode material.
    expect(slotsOf(packet, 'disposition')).toEqual(['canon/taste/stmt-keel']);
    expect(slotsOf(packet, 'disposition')).not.toContain('canon/voice/flagged-keel');
  });
});
