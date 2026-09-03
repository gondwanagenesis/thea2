// M07 corpus — identityBody: the [IDENTITY] anchor is canon prose with
// exemplar-shaped furniture in front of it. The body is the prompt; the
// frontmatter (id/role/note) is repo metadata and must never ship to the model.
// compose.ts adopts this in Round 3 (call site: src/app/compose.ts:245).

import { describe, expect, it } from 'vitest';
import { identityBody } from '../../src/corpus/frontmatter.js';

const IDENTITY_FILE = `---
id: canon/identity
syncedTo: spec-v1
role: identity-anchor
note: >
  DRAFT, distilled from Thea1 SOUL.md.
---

i'm thea. Diego's best friend on the wire: fast, funny, loyal, and i don't lie.
precision overrides the bit, always.
`;

describe('identityBody — identity renders body only', () => {
  it('strips the fenced frontmatter and preserves the body', () => {
    const body = identityBody(IDENTITY_FILE);
    expect(body).toBe(
      "i'm thea. Diego's best friend on the wire: fast, funny, loyal, and i don't lie.\nprecision overrides the bit, always.\n",
    );
    expect(body).not.toContain('---');
    expect(body).not.toContain('role:');
    expect(body).not.toContain('identity-anchor');
  });

  it('never throws on a fenceless file — the whole text is the body', () => {
    const raw = 'just prose, no fences\n';
    expect(identityBody(raw)).toBe(raw);
  });

  it('normalizes CRLF before splitting, like every other corpus read', () => {
    const crlf = '---\r\nid: canon/identity\r\n---\r\n\r\nthe body line\r\n';
    expect(identityBody(crlf)).toBe('the body line\n');
  });

  it('trims the blank line after the closing fence so the section starts on content', () => {
    expect(identityBody('---\nrole: x\n---\n\nfirst line\n')).toBe('first line\n');
  });

  it('a body that merely mentions --- inside prose is not split on it', () => {
    const raw = '---\nrole: x\n---\nprose containing --- later\n';
    expect(identityBody(raw)).toBe('prose containing --- later\n');
  });
});
