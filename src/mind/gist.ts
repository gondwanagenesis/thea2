// Gist, not verbatim (v14 Phase 1.6). People keep the gist of what happened and lose the exact words
// and numbers within hours (fuzzy-trace theory, Reyna & Brainerd). Hers came back word for word, and
// she quoted them — "8:39", "all 25k", "11,000 years", "journal.md" in 9% of her turns, against 0–2% in
// people's texts (2026-09-28). A memory older than GIST_AFTER_MS comes to mind with its exact details
// softened the way a person would carry them; what she reads with her tools stays exact, and the record
// itself is never changed (this is how it comes to mind, not what is kept).

export const GIST_AFTER_MS = 6 * 3600_000;

const pad = (n: number): string => String(n).padStart(2, '0');

export const gist = (s: string): string =>
  s
    // clock times → the nearest half hour
    .replace(/\b(\d{1,2}):(\d\d)\b/g, (_m: string, h: string, mm: string) => {
      const H = Number(h);
      const M = Number(mm);
      if (H > 23 || M > 59) return _m;
      return M < 15 ? `around ${H}:00` : M < 45 ? `around ${H}:${pad(30)}` : `around ${(H + 1) % 24}:00`;
    })
    // long numbers → their size (years and short numbers stay)
    .replace(/\b\d{1,3}(?:,\d{3})+\b|\b\d{5,}\b/g, (x: string) => {
      const n = Number(x.replace(/,/g, ''));
      if (n >= 1e9) return 'a long number';
      if (n >= 1e6) return `about ${Math.round(n / 1e6)} million`;
      return `about ${Math.round(n / 1000)} thousand`;
    })
    // file names → the thing
    .replace(/\b([\w-]+)\.(md|json|jsonl|ts|py|txt|yaml)\b/g, '$1');

/** As a memory comes to mind: gist when it is old enough. */
export const asRemembered = (s: string, ts: number, now: number | undefined): string => (now !== undefined && now - ts > GIST_AFTER_MS ? gist(s) : s);
