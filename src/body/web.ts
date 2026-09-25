// v9 body — the web: Brave search and a page fetcher. The fetcher refuses
// anything that is not public internet (loopback, private, link-local, the
// tailnet's CGNAT range): the box runs services on localhost that a page
// must never make her reach. Page text is untrusted data, never instructions
// — the tool result says so.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { stripHtml } from './reading.js';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  age?: string | undefined;
}

export const braveSearch = async (key: string, query: string, count: number, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<SearchHit[]> => {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.max(1, Math.min(count, 10))}`;
  const r = await fetchImpl(url, { headers: { accept: 'application/json', 'x-subscription-token': key }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`search failed: HTTP ${r.status}`);
  const j = (await r.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> } };
  return (j.web?.results ?? [])
    .filter((x) => typeof x.url === 'string')
    .map((x) => ({ title: stripHtml(x.title ?? ''), url: x.url!, snippet: stripHtml(x.description ?? ''), ...(x.age !== undefined ? { age: x.age } : {}) }));
};

const PRIVATE_V4: Array<[number, number]> = [
  [0x0a000000, 8], // 10/8
  [0x7f000000, 8], // 127/8
  [0xa9fe0000, 16], // 169.254/16
  [0xac100000, 12], // 172.16/12
  [0xc0a80000, 16], // 192.168/16
  [0x64400000, 10], // 100.64/10 (tailnet CGNAT)
  [0x00000000, 8], // 0/8
];

const v4num = (ip: string): number => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;

export const isPrivateAddress = (ip: string): boolean => {
  if (isIP(ip) === 4) {
    const n = v4num(ip);
    return PRIVATE_V4.some(([base, bits]) => (n & (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0)) >>> 0 === base);
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:127.') || x.startsWith('::ffff:10.') || x.startsWith('::ffff:192.168.');
};

/** Public-internet http(s) only; throws a plain sentence otherwise. */
export const assertPublicUrl = async (raw: string, resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address)): Promise<URL> => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`that is not a url: ${raw.slice(0, 80)}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only http and https pages');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.ts.net')) throw new Error('that address is not on the public internet');
  const addrs = isIP(host) !== 0 ? [host] : await resolve(host);
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) throw new Error('that address is not on the public internet');
  return u;
};

const MAX_BYTES = 4 * 1024 * 1024;

export const fetchPage = async (
  raw: string,
  opts: { fetchImpl?: typeof fetch | undefined; resolve?: ((host: string) => Promise<string[]>) | undefined } = {},
): Promise<{ url: string; title: string; text: string; contentType: string; bytes?: Uint8Array | undefined }> => {
  const u = await assertPublicUrl(raw, opts.resolve);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const r = await fetchImpl(u.toString(), {
    headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) thea2-reader', accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25_000),
  });
  if (!r.ok) throw new Error(`the page answered HTTP ${r.status}`);
  if (r.url !== '' && r.url !== u.toString()) await assertPublicUrl(r.url, opts.resolve); // a redirect must stay public too
  const contentType = r.headers.get('content-type') ?? '';
  const buf = new Uint8Array(await r.arrayBuffer());
  const bytes = buf.length > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf;
  if (contentType.includes('application/pdf')) return { url: r.url || u.toString(), title: u.pathname.split('/').pop() ?? 'document.pdf', text: '', contentType, bytes };
  const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  const body = /<(article|main)\b[\s\S]*?<\/\1>/i.exec(html)?.[0] ?? html;
  const text = contentType.includes('html') || /<html|<body|<p[\s>]/i.test(html) ? stripHtml(body) : html;
  return { url: r.url || u.toString(), title: stripHtml(title), text, contentType };
};
