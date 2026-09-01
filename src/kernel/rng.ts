// M01 kernel — seeded, forkable RNG. Platform-stable: small integer PRNGs only,
// no crypto entropy, so a seed reproduces the same sequence on any machine.

export interface Rng {
  float(): number; // [0, 1)
  int(lo: number, hi: number): number; // inclusive bounds
  pick<T>(xs: readonly T[]): T;
  shuffle<T>(xs: T[]): T[]; // new array; input untouched
  fork(label: string): Rng; // independent child stream
}

/** xmur3 string hash → 32-bit seed generator. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** splitmix32 — spreads a 32-bit seed into well-distributed state words. */
function splitmix32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t = t ^ (t >>> 15)) >>> 0;
  };
}

/** sfc32 — small, fast, high-quality counter-based PRNG. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

const seedToWords = (key: string): [number, number, number, number] => {
  const g = splitmix32(xmur3(key)());
  // Warm up: sfc32 needs a few draws before its output is well-distributed.
  const w = [g(), g(), g(), g()];
  return [w[0]!, w[1]!, w[2]!, w[3]!];
};

const makeFromKey = (key: string): Rng => {
  const draw = sfc32(...seedToWords(key));
  const rng: Rng = {
    float: () => draw(),
    int: (lo, hi) => lo + Math.floor(draw() * (hi - lo + 1)),
    pick: (xs) => {
      if (xs.length === 0) throw new Error('rng.pick: empty array');
      return xs[Math.floor(draw() * xs.length)]!;
    },
    shuffle: (xs) => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(draw() * (i + 1));
        const tmp = out[i]!;
        out[i] = out[j]!;
        out[j] = tmp;
      }
      return out;
    },
    fork: (label) => makeFromKey(`${key}::${label}`),
  };
  return rng;
};

/** Deterministic per seed (number or string) and stable across platforms/runs. */
export const makeRng = (seed: number | string): Rng => makeFromKey(String(seed));
