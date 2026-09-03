// M21 spine — S1.4, the packet injection path. Assemble stays ours: the packet
// renders into the spine turn's `system` (packet head, [PROCEDURAL] appended,
// the [OUTPUT] contract beside it) and `parts` (the turn text, then the
// [INHIBITION] trailer LAST). The golden asserts BYTE-STABILITY against
// probes/fixtures/door-smoke-packet.txt — a real rendered packet recorded with
// BOTH layouts: its ChatMsg[] section is the trailing placement, its anthropic
// wire body is the merged placement (the trailer folded into `system`).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUT_CONTRACT, decideToolDef, type LoopPacket } from '../../src/loop/index.js';
import { buildTurnRequest, type ModelRef } from '../../src/spine/index.js';
import { diegoTurn } from './helpers.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturePath = join(repoRoot, 'probes', 'fixtures', 'door-smoke-packet.txt');

interface WireBody {
  system: string;
  messages: Array<{ role: string; content: string }>;
}

/** Splits the recorded packet fixture into its ChatMsg[] blocks and the
 * anthropic wire body it documents — two independent renderings of one packet. */
const parseFixture = (): { head: string; trailer: string; mergedSystem: string } => {
  const text = readFileSync(fixturePath, 'utf8');
  const wireStart = text.indexOf('############ ANTHROPIC WIRE BODY');
  const wireEnd = text.indexOf('############ PACKET RECORD');
  if (wireStart < 0 || wireEnd < 0) throw new Error('fixture is missing its sections');
  const wire = JSON.parse(text.slice(text.indexOf('{', wireStart), text.lastIndexOf('}', wireEnd) + 1)) as WireBody;
  const chatPart = text.slice(0, wireStart);
  // split on the role markers: [preamble, role, body, role, body, ...]
  const sections = chatPart.split(/^----- role: ([a-z]+) -----\n/m);
  const blocks: Array<{ role: string; body: string }> = [];
  for (let i = 1; i + 1 < sections.length; i += 2) {
    blocks.push({ role: sections[i] ?? '', body: (sections[i + 1] ?? '').replace(/\n+$/, '') });
  }
  const systemBlocks = blocks.filter((b) => b.role === 'system');
  const head = systemBlocks[0]?.body ?? '';
  const trailer = systemBlocks.at(-1)?.body ?? '';
  // the ChatMsg[] head is the merged rendering minus the folded trailer: verify
  // the two fixture sections describe ONE packet before the spine path runs
  if (wire.system !== `${head}\n\n${trailer}`) {
    throw new Error('fixture sections disagree: wire system is not head + trailer');
  }
  return { head, trailer, mergedSystem: wire.system };
};

const model: ModelRef = { providerID: 'voice', modelID: 'glm-5.3', door: 'voice' };
const turnText = 'the deploy is failing again, the systemd unit keeps restarting';

describe('packet injection path (S1.4)', () => {
  const fx = parseFixture();
  const packet: LoopPacket = {
    systemText: () => {
      const marker = `\n\n${OUTPUT_CONTRACT}`;
      const at = fx.head.lastIndexOf(marker);
      if (at < 0) throw new Error('fixture head does not end with the [OUTPUT] contract');
      return fx.head.slice(0, at);
    },
    proceduralText: () => null,
    trailerText: () => fx.trailer,
  };

  it('packet-render-golden-unchanged-through-spine', () => {
    const req = buildTurnRequest({
      entry: diegoTurn(turnText),
      packet,
      tools: [decideToolDef],
      model,
      turnText,
      placement: 'trailing',
      decide: { schema: decideToolDef.parameters },
    });

    // the spine system text is the loop's head message, BYTE FOR BYTE:
    // packet systemText -> [OUTPUT] contract appended, nothing re-wrapped.
    expect(req.system).toBe(fx.head);

    // and the structured-output contract rides exactly as the recorded wire does
    expect(req.system.endsWith(OUTPUT_CONTRACT)).toBe(true);
    expect(req.agent).toBe('thea');
    expect(req.format).toEqual({ type: 'json_schema', schema: decideToolDef.parameters, retryCount: 1 });
    expect(req.model).toEqual({ providerID: 'voice', modelID: 'glm-5.3' });
  });

  it('inhibition-is-the-trailing-message', () => {
    const req = buildTurnRequest({
      entry: diegoTurn(turnText),
      packet,
      tools: [decideToolDef],
      model,
      turnText,
      placement: 'trailing',
    });

    // the [INHIBITION] trailer is the LAST part — recency wins, same position
    // semantics as the loop's trailing system message.
    expect(req.parts.map((p) => p.label)).toEqual(['turn', 'inhibition']);
    expect(req.parts[0]?.text).toBe(turnText);
    const last = req.parts.at(-1);
    expect(last?.text).toBe(fx.trailer); // byte-for-byte the recorded [INHIBITION] block
    expect(req.system).not.toContain('[INHIBITION]');

    // the 'merged' fallback folds the trailer into the head — and that rendering
    // is byte-identical to the packet's recorded anthropic wire body (which was
    // recorded on a decide turn, so the [OUTPUT] contract rides too).
    const merged = buildTurnRequest({
      entry: diegoTurn(turnText),
      packet,
      tools: [decideToolDef],
      model,
      turnText,
      placement: 'merged',
      decide: { schema: decideToolDef.parameters },
    });
    expect(merged.parts.map((p) => p.label)).toEqual(['turn']);
    expect(merged.system).toBe(fx.mergedSystem);
  });

  it('[PROCEDURAL] travels in the head, beside the tool defs — never inside parts', () => {
    const withProc: LoopPacket = {
      ...packet,
      proceduralText: () => '[PROCEDURAL] answer in one line.',
    };
    const req = buildTurnRequest({
      entry: diegoTurn(turnText),
      packet: withProc,
      tools: [decideToolDef],
      model,
      turnText,
      placement: 'trailing',
      decide: { schema: decideToolDef.parameters },
    });
    expect(req.system).toBe(`${packet.systemText()}\n\n[PROCEDURAL] answer in one line.\n\n${OUTPUT_CONTRACT}`);
    expect(req.parts.map((p) => p.label)).toEqual(['turn', 'inhibition']);
  });
});
