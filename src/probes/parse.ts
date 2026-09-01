// M19 probes — the probe-file front door: YAML → ProbeDef, suite loading, and
// the resolve pass that turns "the file parses" into "the probe can actually run"
// (reference exemplar ids, drift centroid ids, episode fixtures, rubric anchor,
// regex compilation). Probe rot is a build failure, so resolve throws typed
// errors instead of returning soft warnings.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import * as yaml from 'js-yaml';
import {
  DeterministicCheck,
  DriftRef,
  JudgeRubric,
  ProbeDef,
  ProbeEntry,
  ProbeExpect,
  ProbeFixtures,
} from '../../schemas/probe.js';
import { DecisionObject as DecisionObjectSchema, type DecisionObject } from '../../schemas/decision.js';
import type { CorpusIndex } from '../corpus/corpus-index.js';
import { ProbeError, zodIssuesText } from './errors.js';
import { AFFECT_DIMS_ORDER, fullVec12, type Episode, type SparseAffect, type Vec12 } from './types.js';

// ---------------------------------------------------------------------------
// Strict parse variants — derived from schemas/probe.ts (the reference), never
// restated: z.object strips unknown keys, and a typo'd `exepct:` must fail the
// dry run, not silently vanish. Same rationale as src/corpus/frontmatter.ts.
// ---------------------------------------------------------------------------

// Strictness depth note: every NAMED object in the file (probe, entry options,
// fixtures, expect, rubric, driftRef, each check option, scripted inbound) is
// strict; the two anonymous leaves one level deeper (speaker, window rows) keep
// the reference's plain z.object — a typo there survives, which the resolve pass
// and the corpus lint make up for. Keep synced with schemas/probe.ts.
// zod v4's discriminatedUnion wants a non-empty tuple; `.map()` widens to a plain
// array, so destructure the (statically non-empty) options back into tuple shape.
const [firstEntryOption, ...restEntryOptions] = ProbeEntry.options.map((opt) => z.strictObject(opt.shape));
const StrictProbeEntry = z.discriminatedUnion('kind', [firstEntryOption!, ...restEntryOptions]);

const StrictProbeFixtures = z.strictObject(ProbeFixtures.shape);

const [firstCheckOption, ...restCheckOptions] = DeterministicCheck.options.map((opt) => z.strictObject(opt.shape));
const StrictDeterministicCheck = z.discriminatedUnion('type', [firstCheckOption!, ...restCheckOptions]);

const StrictJudgeRubric = z.strictObject(JudgeRubric.shape);
const StrictDriftRef = z.strictObject(DriftRef.shape);

const StrictProbeExpect = z.strictObject({
  ...ProbeExpect.shape,
  deterministic: z.array(StrictDeterministicCheck),
  judgeRubric: StrictJudgeRubric.optional(),
  driftRef: StrictDriftRef.optional(),
});

/** The strict probe schema: same shapes, defaults, and vocabularies as the reference — unknown keys rejected. */
export const ProbeDefStrict = z.strictObject({
  ...ProbeDef.shape,
  entry: StrictProbeEntry,
  fixtures: StrictProbeFixtures,
  expect: StrictProbeExpect,
});

/** Parses one probe file's text into a ProbeDef. Throws 'probes/yaml' or 'probes/schema'. */
export const parseProbeYaml = (text: string, file?: string): ProbeDef => {
  const loc = file === undefined ? {} : { file };
  let raw: unknown;
  try {
    raw = yaml.load(text, file === undefined ? undefined : { filename: file });
  } catch (e) {
    throw new ProbeError('probes/yaml', `probe file is not valid YAML: ${e instanceof Error ? e.message : String(e)}`, {
      ...loc,
      cause: e,
    });
  }
  const parsed = ProbeDefStrict.safeParse(raw);
  if (!parsed.success) {
    throw new ProbeError('probes/schema', `probe file violates schemas/probe.ts: ${zodIssuesText(parsed.error)}`, loc);
  }
  return parsed.data as ProbeDef;
};

export interface LoadedSuite {
  /** Parsed probes, id-sorted. */
  probes: ProbeDef[];
  /** Every file that failed, so one rotten probe reports all the rot, not just the first. */
  errors: Array<{ file: string; code: string; message: string }>;
}

const PROBE_SUFFIX = '.probe.yaml';

/** Scans a directory for `*.probe.yaml` and parses every one; a missing directory is an empty suite. */
export const loadProbeSuite = (dir: string): LoadedSuite => {
  const probes: ProbeDef[] = [];
  const errors: LoadedSuite['errors'] = [];
  if (!fs.existsSync(dir)) return { probes, errors };
  const files = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(PROBE_SUFFIX))
    .sort();
  for (const name of files) {
    const file = path.join(dir, name);
    try {
      probes.push(parseProbeYaml(fs.readFileSync(file, 'utf8'), file));
    } catch (e) {
      const code = e instanceof ProbeError ? e.code : 'probes/schema';
      errors.push({ file, code, message: e instanceof Error ? e.message : String(e) });
    }
  }
  // Duplicate ids: two files claiming one probe id would make baseline rows and
  // reports lie by conflation, so it is rot, not a shadowing rule.
  const seen = new Set<string>();
  for (const p of probes) {
    if (seen.has(p.id)) {
      errors.push({
        file: p.id,
        code: 'probes/duplicate-id',
        message: `probe id '${p.id}' is claimed by more than one file`,
      });
    }
    seen.add(p.id);
  }
  const unique = probes.filter((p, i) => probes.findIndex((q) => q.id === p.id) === i);
  return { probes: unique.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), errors };
};

/** Merges every `*.json` fixture file's top-level keys into one episode-fixture map. */
export const loadProbeFixtures = (dir: string): Map<string, unknown> => {
  const map = new Map<string, unknown>();
  if (!fs.existsSync(dir)) return map;
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new ProbeError('probes/fixture-unresolved', `fixture file ${file} is not valid JSON: ${String(e)}`, {
        file,
        cause: e,
      });
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ProbeError('probes/fixture-unresolved', `fixture file ${file} must be a top-level object of id -> fixture`, {
        file,
      });
    }
    for (const [id, value] of Object.entries(raw)) {
      if (map.has(id)) {
        throw new ProbeError('probes/fixture-collision', `episode fixture id '${id}' is claimed by more than one file`, {
          file,
        });
      }
      map.set(id, value);
    }
  }
  return map;
};

// ---------------------------------------------------------------------------
// Recorded transcripts (the dry-run harness's input)
// ---------------------------------------------------------------------------

/**
 * A recorded fixture transcript: what a LIVE run of the probe produced, captured
 * so CI can re-grade the deterministic checks over real-shaped evidence with
 * zero model spend. `affect` may be sparse (materialized on load); `episodes`
 * mirror M09's Episode shape (see types.ts).
 */
const TranscriptEpisode = z.object({
  id: z.string().min(1),
  ts: z.number(),
  turnId: z.string().min(1),
  summary: z.string().min(1),
  diaryLine: z.string().min(1),
  importance: z.number().int().min(1).max(10),
  emotions: z.array(z.object({ tag: z.string().min(1), i: z.number().min(1).max(10), cause: z.string().min(1) })),
  threads: z.array(z.string().min(1)),
  /** FULL Vec12 in AFFECT_DIMS order, or a sparse dim-keyed record — both accepted. */
  affectAtEncoding: z.union([z.array(z.number()).length(12), z.record(z.string(), z.number())]),
});

const Vec12ish = z.union([z.array(z.number()).length(12), z.record(z.string(), z.number())]);

const TranscriptRawSchema = z.object({
  probeId: z.string().min(1),
  outbound: z.array(z.string()),
  /** Validated against the schemas/decision.ts reference — transcripts carry real decisions. */
  decision: DecisionObjectSchema.nullable().default(null),
  affect: Vec12ish.default({}),
  episodes: z.array(TranscriptEpisode).default([]),
});

export interface ProbeTranscript {
  probeId: string;
  outbound: string[];
  decision: DecisionObject | null;
  affect: Vec12;
  episodes: Episode[];
}

/** Accepts a Vec12 array or a sparse dim-keyed record (probe fixtures stay sparse). */
const materializeVec12 = (value: readonly number[] | Record<string, number>): Vec12 => {
  if (Array.isArray(value)) return value;
  // The false branch still types as the whole union (Array.isArray cannot exclude
  // readonly arrays), but at runtime only a record remains here.
  const record = value as Record<string, number>;
  const sparse: SparseAffect = {};
  for (const dim of AFFECT_DIMS_ORDER) {
    const v = record[dim];
    if (v !== undefined) sparse[dim] = v;
  }
  return fullVec12(sparse);
};

/** Loads `*.json` transcripts from a directory: one transcript object, or an array of them, per file. */
export const loadTranscripts = (dir: string): Map<string, ProbeTranscript> => {
  const map = new Map<string, ProbeTranscript>();
  if (!fs.existsSync(dir)) return map;
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new ProbeError('probes/transcript-schema', `transcript file ${file} is not valid JSON: ${String(e)}`, {
        file,
        cause: e,
      });
    }
    const items: unknown[] = Array.isArray(raw) ? raw : [raw];
    for (const item of items) {
      const parsed = TranscriptRawSchema.safeParse(item);
      if (!parsed.success) {
        throw new ProbeError('probes/transcript-schema', `transcript ${file} fails validation: ${zodIssuesText(parsed.error)}`, {
          file,
        });
      }
      const t = parsed.data;
      const transcript: ProbeTranscript = {
        probeId: t.probeId,
        outbound: t.outbound,
        decision: t.decision,
        affect: materializeVec12(t.affect),
        episodes: t.episodes.map((e) => ({ ...e, affectAtEncoding: materializeVec12(e.affectAtEncoding) })),
      };
      const prior = map.get(transcript.probeId);
      if (prior !== undefined) {
        throw new ProbeError('probes/transcript-schema', `two transcripts claim probe id '${transcript.probeId}'`, { file });
      }
      map.set(transcript.probeId, transcript);
    }
  }
  return map;
};

// ---------------------------------------------------------------------------
// Resolve — the probe can actually run
// ---------------------------------------------------------------------------

export interface ResolveEnv {
  corpus: CorpusIndex;
  /** Episode-fixture map episodeSet ids must resolve into (loadProbeFixtures). */
  fixtures?: ReadonlyMap<string, unknown>;
  /** Canon text reader for the rubric anchor (e.g. corpus/canon/identity.md, which
   * is deliberately NOT an exemplar and so is not in the index). */
  readCanonFile?: (corpusPath: string) => string | undefined;
}

/** Compiles a probe regex; a pattern that cannot compile is probe rot. */
export const compilePattern = (pattern: string): RegExp => {
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new ProbeError('probes/bad-regex', `noForbiddenPattern does not compile: /${pattern}/`, {
      field: 'expect.deterministic.noForbiddenPattern',
      cause: e,
    });
  }
};

/**
 * Verifies every cross-artifact pin a probe makes: reference exemplar ids and
 * drift centroid ids resolve through the corpus index, the rubric anchor text is
 * reachable, the drift dimension has a usable reference set, episode fixtures
 * exist, and every forbidden pattern compiles. Throws the first failure, naming it.
 */
export const resolveProbe = (probe: ProbeDef, env: ResolveEnv): void => {
  for (const check of probe.expect.deterministic) {
    if (check.type === 'noForbiddenPattern') compilePattern(check.pattern);
  }

  const rubric = probe.expect.judgeRubric;
  if (rubric !== undefined) {
    for (const ref of rubric.references) {
      if (env.corpus.byId(ref) === undefined) {
        throw new ProbeError('probes/reference-unresolved', `judge reference '${ref}' is not in the corpus index`, {
          field: 'expect.judgeRubric.references',
        });
      }
    }
    const anchorExemplar = env.corpus.byId(rubric.anchor);
    const anchorText = anchorExemplar !== undefined ? anchorExemplar.body : env.readCanonFile?.(rubric.anchor);
    if (anchorText === undefined) {
      throw new ProbeError(
        'probes/anchor-unresolved',
        `judge anchor '${rubric.anchor}' is neither an exemplar id nor readable via the injected canon reader`,
        { field: 'expect.judgeRubric.anchor' },
      );
    }
  }

  const drift = probe.expect.driftRef;
  if (drift !== undefined) {
    if (drift.centroidFrom !== undefined) {
      for (const id of drift.centroidFrom) {
        if (env.corpus.byId(id) === undefined) {
          throw new ProbeError('probes/reference-unresolved', `drift centroid id '${id}' is not in the corpus index`, {
            field: 'expect.driftRef.centroidFrom',
          });
        }
      }
    } else {
      const canon = env.corpus.byDimension(drift.dimension).filter((e) => e.source === 'canon');
      if (canon.length === 0) {
        throw new ProbeError(
          'probes/centroid-empty',
          `drift dimension '${drift.dimension}' has no canon exemplars to build a reference centroid from`,
          { field: 'expect.driftRef.dimension' },
        );
      }
    }
  }

  const fixtures = env.fixtures ?? new Map<string, unknown>();
  for (const id of probe.fixtures.episodeSet) {
    if (!fixtures.has(id)) {
      throw new ProbeError('probes/fixture-unresolved', `episode fixture '${id}' (fixtures.episodeSet) has no fixture entry`, {
        field: 'fixtures.episodeSet',
      });
    }
  }
};
