// M07 corpus — the packet-side frame render (src/corpus/render.ts). Each
// selected exemplar ships a one-line `situation:` frame above its body, and a
// leading `Setup:` paragraph folds into that line instead of riding along as a
// second description. Fixtures are exemplar-shaped data, not repo canon.

import { describe, expect, it } from 'vitest';
import { leadingSetupOf, renderExemplar } from '../../src/corpus/render.js';

const sceneBody = (): string => "D: he asks what's wrong\nT: nothing. the rack is being dramatic again\n";

describe('the situation frame', () => {
  it('frame renders situation and label line once', () => {
    const rendered = renderExemplar({
      context: "the rack at 2am, third alert of the night",
      body: `Setup: she is elbow-deep in the drive cage, flashlight in her teeth\n${sceneBody()}`,
    });
    const lines = rendered.split('\n');
    expect(lines[0]).toBe('situation: the rack at 2am, third alert of the night — she is elbow-deep in the drive cage, flashlight in her teeth');
    // The label appears exactly once, and the folded Setup line is gone.
    expect(rendered.match(/situation:/g)).toHaveLength(1);
    expect(rendered).not.toContain('Setup:');
    // The demonstrated turns survive verbatim below the frame.
    expect(rendered.endsWith(sceneBody())).toBe(true);
  });

  it('exemplar without context renders body only', () => {
    const body = sceneBody();
    expect(renderExemplar({ context: undefined, body })).toBe(body);
    expect(renderExemplar({ context: '', body })).toBe(body);
    expect(renderExemplar({ context: '   ', body })).toBe(body);
    expect(renderExemplar({ context: 'plain statement', body: 'i like machines that admit what they are.\n' })).toBe(
      'situation: plain statement\ni like machines that admit what they are.\n',
    );
  });

  it('a body without a Setup paragraph frames the context over an untouched body', () => {
    const body = sceneBody();
    const rendered = renderExemplar({ context: 'morning, first coffee', body });
    expect(rendered).toBe(`situation: morning, first coffee\n${body}`);
  });

  it('setup folds even without a context line — the frame still reads as one situation', () => {
    const rendered = renderExemplar({
      body: `Setup: the deploy just went red\n${sceneBody()}`,
    });
    expect(rendered.startsWith('situation: the deploy just went red\nD: ')).toBe(true);
    expect(rendered).not.toContain('Setup:');
  });

  it('multiple leading Setup lines fold into one frame, in order', () => {
    const rendered = renderExemplar({
      context: 'moving day',
      body: 'Setup: the van is packed\nSetup: she has not sat down since dawn\nD: you okay\nT: define okay\n',
    });
    expect(rendered.split('\n')[0]).toBe(
      'situation: moving day — the van is packed she has not sat down since dawn',
    );
  });

  it('a Setup line after the turns is scene, not setup — it stays in the body', () => {
    const body = `D: you okay\nT: define okay\nSetup: not a real setup line in a statement body\n`;
    const rendered = renderExemplar({ context: 'c', body });
    expect(rendered).toBe(`situation: c\n${body}`);
  });

  it('leadingSetupOf on a body with no setup returns the body untouched (byte-stable)', () => {
    const body = '\nD: starts with a blank line\nT: still fine\n';
    expect(leadingSetupOf(body)).toEqual({ setup: '', rest: body });
  });
});
