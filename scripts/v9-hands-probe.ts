// v9 hands live probe — her real camera, video and web against the real
// providers, with NOTHING sent to Telegram: a selfie from her reference set,
// that selfie brought to life as a 5 s video, a web search, a page read.
// Files land in a throwaway house (refs copied in from --refs).
//
//   THEA2_FAL_KEY=… THEA2_BRAVE_KEY=… npx tsx scripts/v9-hands-probe.ts --refs /opt/thea2/var/house/refs [--no-video]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SystemClock } from '../src/kernel/index.js';
import { braveSearch, fetchPage, makeCamera, makeFal, nodeExec, openHouse } from '../src/body/index.js';

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const clock = new SystemClock();
const house = openHouse(fs.mkdtempSync('/tmp/thea2-hands-probe-'));
const refs = arg('refs');
if (refs !== undefined) fs.cpSync(refs, path.join(house.root, 'refs'), { recursive: true });

const t = async <T>(label: string, f: () => Promise<T>): Promise<T | undefined> => {
  const t0 = performance.now();
  try {
    const r = await f();
    console.log(`OK   ${label} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    return r;
  } catch (e) {
    console.log(`FAIL ${label} (${((performance.now() - t0) / 1000).toFixed(1)} s): ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
};
const probe = async (file: string): Promise<string> => Buffer.from((await nodeExec.run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'csv=p=0', file])).stdout).toString('utf8').replace(/\n/g, ' ').trim();

const falKey = process.env['THEA2_FAL_KEY'] ?? '';
if (falKey !== '') {
  const camera = makeCamera({ fal: makeFal(falKey, clock), house, clock });
  console.log(`refs: ${camera.refs().join(', ') || 'none'}`);
  const selfie = await t('selfie (fal flux-2-pro/edit + her refs)', () => camera.selfie({ scene: 'sitting on a wooden balcony at dusk, oversized navy sweater, a mug of tea, sea behind her', shot: 'golden' }));
  if (selfie !== undefined) {
    console.log(`     ${house.rel(selfie)} · ${fs.statSync(selfie).size} bytes · ${await probe(selfie)}`);
    if (!argv.includes('--no-video')) {
      const video = await t('video (kling 2.5 turbo image-to-video, 5 s)', () => camera.video({ imagePath: house.rel(selfie), prompt: 'she looks up from the tea, smiles slowly at the camera, wind moves her hair' }));
      if (video !== undefined) console.log(`     ${house.rel(video)} · ${fs.statSync(video).size} bytes · ${await probe(video)}`);
    }
  }
  const pic = await t('imagine (fal flux-2-pro)', () => camera.imagine({ prompt: 'a lighthouse made of sea glass at night, soft teal glow, film photo', size: 'landscape_4_3' }));
  if (pic !== undefined) console.log(`     ${house.rel(pic)} · ${fs.statSync(pic).size} bytes · ${await probe(pic)}`);
}

const brave = process.env['THEA2_BRAVE_KEY'] ?? '';
if (brave !== '') {
  const hits = await t('web_search (brave)', () => braveSearch(brave, 'alexithymia emotion recognition methods', 5));
  for (const h of hits ?? []) console.log(`     ${h.title} — ${h.url}`);
  const page = await t('web_fetch', () => fetchPage('https://en.wikipedia.org/wiki/Alexithymia'));
  if (page !== undefined) console.log(`     "${page.title}" · ${page.text.length} chars · opens: ${JSON.stringify(page.text.slice(0, 160))}`);
  const blocked = await t('web_fetch refuses localhost (expected FAIL)', () => fetchPage('http://127.0.0.1:3456/api/state'));
  if (blocked !== undefined) console.log('     !!! it fetched localhost — the guard is broken');
}
console.log(`house: ${house.root}`);
