// M11 assemble — rendering. Byte-exactness is a contract here: the render order
// is fixed ([IDENTITY][GOAL][INTERLOCUTOR][MEMORY][AFFECT][REGISTER][EXEMPLARS]),
// [PROCEDURAL] is a separate block the loop places beside the tool defs, and
// [INHIBITION] is the trailer, passed through verbatim from M12 (its renderer
// already emits the header — prefixing another would ship a doubled tag).
//
// Within [EXEMPLARS] the order is stability → volatility: disposition (the
// keel), patterns, episodes, then the contrast slot last — it is the foreign
// body of the packet and reads best at the end.

import { compareStrings } from '../corpus/types.js';
import { CHARACTER_SECTIONS, type CharacterSection, type Packet, type PacketRecord, type Section, type TurnQuery } from './types.js';
import type { Scored } from './score.js';
import type { Selection } from './quota.js';

export interface RenderInput {
  q: TurnQuery;
  characterChannel: boolean;
  weatherLine: string;
  inhibitionBlock: string;
  identityBlock: string | undefined;
  coherence: 'ok' | 'degraded';
  turnId: string;
  staleDerived: boolean;
}

const groupByKind = (sel: Selection, kind: 'disposition' | 'pattern' | 'episodeMemory' | 'contrast'): Scored[] => {
  const g = sel.groups.find((x) => x.kind === kind);
  return g === undefined ? [] : [...g.members];
};

/** Score desc, id asc — the render order inside every tier class. */
const byRenderOrder = (x: Scored, y: Scored): number => y.score - x.score || compareStrings(x.c.id, y.c.id);

export interface RenderedPacket {
  sections: Partial<Record<Section, string>>;
  itemIds: string[];
  systemText: string;
  proceduralText: string | null;
  trailerText: string;
  record: PacketRecord;
}

const sectionText = (name: CharacterSection, body: string): string => `[${name}]\n${body}`;

export const renderPacket = (sel: Selection, input: RenderInput): RenderedPacket => {
  const memory = groupByKind(sel, 'episodeMemory').filter((m) => m.c.tier === 'memory').sort(byRenderOrder);
  const disposition = groupByKind(sel, 'disposition').sort(byRenderOrder);
  const pattern = groupByKind(sel, 'pattern').sort(byRenderOrder);
  const episodes = groupByKind(sel, 'episodeMemory').filter((m) => m.c.tier !== 'memory').sort(byRenderOrder);
  const contrast = groupByKind(sel, 'contrast').sort(byRenderOrder);
  const exemplars = [...disposition, ...pattern, ...episodes, ...contrast];
  const procedural = [...sel.procedural].sort(byRenderOrder);

  const sections: Partial<Record<Section, string>> = {};
  if (input.characterChannel) {
    if (input.identityBlock !== undefined && input.identityBlock !== '') {
      sections['IDENTITY'] = sectionText('IDENTITY', input.identityBlock);
    }
    if (input.q.goal !== undefined && input.q.goal.trim() !== '') {
      sections['GOAL'] = sectionText('GOAL', input.q.goal);
    }
    sections['INTERLOCUTOR'] = sectionText(
      'INTERLOCUTOR',
      `${input.q.speaker.person} on ${input.q.speaker.channel} (register: ${input.q.register})`,
    );
    if (memory.length > 0) {
      sections['MEMORY'] = sectionText('MEMORY', memory.map((m) => m.c.render()).join('\n'));
    }
    if (input.weatherLine !== '') {
      sections['AFFECT'] = sectionText('AFFECT', input.weatherLine);
    }
    sections['REGISTER'] = sectionText('REGISTER', input.q.register);
    if (exemplars.length > 0) {
      sections['EXEMPLARS'] = sectionText('EXEMPLARS', exemplars.map((m) => m.c.render()).join('\n\n'));
    }
  } else if (input.q.goal !== undefined && input.q.goal.trim() !== '') {
    // Task/cast worker: procedural + brief only — no character channel, no affect line (ADR-009).
    sections['GOAL'] = sectionText('GOAL', input.q.goal);
  }

  const systemText = CHARACTER_SECTIONS.map((s) => sections[s])
    .filter((t): t is string => t !== undefined)
    .join('\n\n');

  const proceduralText = procedural.length > 0 ? `[PROCEDURAL]\n${procedural.map((m) => m.c.render()).join('\n\n')}` : null;

  const itemIds = [...memory, ...exemplars, ...procedural].map((m) => m.c.id);

  const slots = [...memory, ...exemplars, ...procedural].map((m) => ({
    exemplarId: m.c.id,
    tier: m.c.tier,
    channel: m.c.channel,
    baseScore: m.c.baseScore,
    modulation: m.modulation,
  }));

  const record: PacketRecord = {
    turnId: input.turnId,
    slots,
    affectSig: [],
    coherence: input.coherence,
    flags: { scarcity: sel.scarcity, staleDerived: input.staleDerived },
  };

  return {
    sections,
    itemIds,
    systemText,
    proceduralText,
    trailerText: input.inhibitionBlock,
    record,
  };
};

/** Wrap a rendered snapshot in the Packet contract (record's affectSig filled by the caller). */
export const asPacket = (rendered: RenderedPacket, affectSig: number[]): Packet => {
  const record = { ...rendered.record, affectSig };
  return {
    sections: rendered.sections,
    itemIds: rendered.itemIds,
    systemText: () => rendered.systemText,
    proceduralText: () => rendered.proceduralText,
    trailerText: () => rendered.trailerText,
    record: () => record,
  };
};
