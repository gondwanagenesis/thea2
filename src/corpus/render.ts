// M07 corpus — the packet-side render of one exemplar: the situation frame.
//
// Demonstration over description does not mean the model gets a scene cold: a
// one-line frame above the body (`situation: <context>`) tells it what it is
// looking at without describing HOW she talks — the body still does that. The
// frame is derived from frontmatter (`context:`), never authored prose in the
// packet, and the `D:`/`T:` turn grammar below it is explained once by the
// loop's [OUTPUT] contract (src/loop/decide.ts OUTPUT_CONTRACT) — not here.
//
// A leading `Setup:` paragraph (body grammar, src/corpus/body.ts) is scene
// setting the one-line context cannot carry, so it is FOLDED into the
// situation line and removed from the rendered body — the packet carries the
// frame once, not frame-plus-setup as two competing descriptions.

/** The slice of Exemplar the render needs (nominator candidates mirror it). */
export interface FrameSource {
  /** The `context:` frontmatter line. Empty/absent ⇒ no frame line at all. */
  context?: string | undefined;
  /** The raw body region (everything after the closing `---` fence). */
  body: string;
}

const SETUP_RE = /^Setup:\s*(.*)$/;

/** A `Setup:` line with actual content, per the body grammar. */
const setupTextOf = (line: string): string | undefined => {
  const text = line.trim();
  if (text.length === 0) return undefined;
  const m = SETUP_RE.exec(text);
  if (m === null) return undefined;
  const rest = (m[1] ?? '').trim();
  return rest.length > 0 ? rest : undefined; // an empty `Setup:` is a lint problem, not render's business
};

/**
 * Splits the body's LEADING `Setup:` paragraph off (lines joined with spaces),
 * returning '' when the body does not open with one. Scanning stops at the
 * first non-Setup, non-blank line; anything later in the body is scene, not
 * setup, and stays verbatim.
 */
export const leadingSetupOf = (body: string): { setup: string; rest: string } => {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const setup: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const text = setupTextOf(lines[i] ?? '');
    if (text !== undefined) {
      setup.push(text);
      i += 1;
      continue;
    }
    if ((lines[i] ?? '').trim().length === 0 && setup.length > 0) {
      i += 1; // blank line inside the setup block
      continue;
    }
    break;
  }
  if (setup.length === 0) return { setup: '', rest: body };
  return { setup: setup.join(' '), rest: lines.slice(i).join('\n') };
};

/**
 * The rendered exemplar: `situation: <context>[ — <folded Setup>]` above the
 * body. No context AND no setup ⇒ the body verbatim (statements often carry
 * neither). The context comes first; setup text is appended after an em-dash
 * separator, which keeps the line a single sentence-shaped frame.
 */
export const renderExemplar = (e: FrameSource): string => {
  const { setup, rest } = leadingSetupOf(e.body);
  const frame: string[] = [];
  const context = (e.context ?? '').trim();
  if (context.length > 0) frame.push(context);
  if (setup.length > 0) frame.push(setup);
  if (frame.length === 0) return e.body;
  return `situation: ${frame.join(' — ')}\n${rest}`;
};
