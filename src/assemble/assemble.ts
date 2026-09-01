// M11 assemble — the orchestrator. Pure function of (query, affect, indexes,
// config, rng): nominators are injected seams, nothing here touches a clock, a
// socket, or entropy. Every choice below is a total order (score desc, id asc —
// the repo convention), which is why the packet is byte-identical across
// instances for identical inputs: the seeded rng is accepted for contract
// stability and consumed for nothing.
//
// Pipeline: mask → quota → nominate (per channel) → score → fill → coherence →
// budget → render. The PacketRecord is a snapshot of the END state, so it
// describes exactly what shipped, budget drops included.

import { canonicalJson, contentHash } from '../kernel/index.js';
import type { Vec12 } from '../coupling/index.js';
import type {
  AssembleDeps,
  Packet,
  TurnQuery,
} from './types.js';
import { AssembleError } from './errors.js';
import { byScoreThenId, scored, type Scored } from './score.js';
import {
  characterAsk,
  dedupeById,
  fillCharacter,
  fillProcedural,
  nominateChannel,
  proceduralQuota,
  type Selection,
} from './quota.js';
import { runCoherence } from './coherence.js';
import { enforceBudgets, type RenderedTexts } from './budget.js';
import { asPacket, renderPacket } from './render.js';

const validateConfig = (cfg: AssembleDeps['cfg']): void => {
  const bad = (what: string): never => {
    throw new AssembleError('assemble/config', `assemble config: ${what}`);
  };
  if (!Number.isFinite(cfg.gravityG) || cfg.gravityG < 0 || cfg.gravityG > 1) bad(`gravityG must be in [0,1], got ${String(cfg.gravityG)}`);
  const q = cfg.quotas;
  if (q.disposition < 0 || q.pattern < 0 || q.episodeMemoryMin < 0 || q.episodeMemoryMax < q.episodeMemoryMin || q.contrast < 0 || q.proceduralMax < 0) {
    bad('quota table is inconsistent (negative slot or min > max)');
  }
  if (cfg.budgets.total <= 0 || cfg.budgets.exemplars <= 0 || cfg.budgets.memory <= 0) bad('budgets must be positive');
  if (cfg.coherence.maxSwapRounds < 0 || cfg.coherence.spreadMax <= 0 || cfg.coherence.maxRegisterTags < 0) {
    bad('coherence thresholds are inconsistent');
  }
};

/** Deterministic stand-in when the caller supplies no turn id (it always should). */
const fallbackTurnId = (q: TurnQuery): string => {
  const key = canonicalJson({
    entry: q.entry,
    goal: q.goal ?? null,
    person: q.speaker.person,
    register: q.register,
    text: q.text ?? null,
  });
  return `turn-${contentHash(key).slice('sha256:'.length, 'sha256:'.length + 16)}`;
};

export const assemble = async (q: TurnQuery, a: Vec12, deps: AssembleDeps): Promise<Packet> => {
  const cfg = deps.cfg;
  validateConfig(cfg);

  const channels = q.channels ?? { character: true, procedural: true };
  const pQuota = channels.procedural ? proceduralQuota(q) : 0;

  const charNoms = channels.character ? deps.nominators.filter((n) => n.channel === 'character') : [];
  const procNoms = channels.procedural && pQuota > 0 ? deps.nominators.filter((n) => n.channel === 'procedural') : [];

  const nominatedChar = await nominateChannel(charNoms, q, characterAsk(cfg));
  const nominatedProc = await nominateChannel(procNoms, q, pQuota);

  const charPool: Array<Scored> = dedupeById(
    nominatedChar.character.map((c) => scored(a, c, deps.coupling)),
  ).sort(byScoreThenId);
  const procPool: Array<Scored> = dedupeById(
    nominatedProc.procedural.map((c) => scored(a, c, deps.coupling)),
  ).sort(byScoreThenId);

  // Fill. A worker packet (character:false) fills nothing on the character
  // channel and is therefore never "scarce" — the mask is a composition
  // decision, not a corpus shortage.
  const sel: Selection = channels.character
    ? fillCharacter(charPool, q, cfg)
    : { groups: [], procedural: [], proceduralOut: [], scarcity: false };
  if (channels.procedural && pQuota > 0) sel.procedural = fillProcedural(procPool, pQuota).procedural;

  // Coherence is a character-channel concern: procedural candidates carry no
  // register tags, no affect signature, and no pattern/episode tier, so the
  // three layers have nothing to say about them.
  const coherence = channels.character
    ? runCoherence(sel, {
        queryVec: q.queryVec,
        queryText: `${q.text ?? ''} ${q.goal ?? ''}`.toLowerCase(),
        cfg,
      })
    : { degraded: false, rounds: 0 };

  const renderOf = (): RenderedTexts => {
    const rendered = renderPacket(sel, {
      q,
      characterChannel: channels.character,
      weatherLine: deps.weatherLine,
      inhibitionBlock: deps.inhibitionBlock,
      identityBlock: deps.identityBlock,
      coherence: coherence.degraded ? 'degraded' : 'ok',
      turnId: q.turnId ?? fallbackTurnId(q),
      staleDerived: cfg.staleDerived,
    });
    return {
      system: rendered.systemText,
      procedural: rendered.proceduralText ?? '',
      trailer: rendered.trailerText,
      memory: rendered.sections['MEMORY'] ?? '',
      exemplars: rendered.sections['EXEMPLARS'] ?? '',
    };
  };

  enforceBudgets(sel, renderOf, cfg);

  const rendered = renderPacket(sel, {
    q,
    characterChannel: channels.character,
    weatherLine: deps.weatherLine,
    inhibitionBlock: deps.inhibitionBlock,
    identityBlock: deps.identityBlock,
    coherence: coherence.degraded ? 'degraded' : 'ok',
    turnId: q.turnId ?? fallbackTurnId(q),
    staleDerived: cfg.staleDerived,
  });
  return asPacket(rendered, Array.from(a));
};

export { proceduralQuota };
