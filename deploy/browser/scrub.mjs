import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await p.goto('http://127.0.0.1:3456/', { waitUntil: 'networkidle' });
await p.waitForTimeout(2000);
console.log(JSON.stringify(await p.evaluate(() => {
  const wrap = document.getElementById('chartWrap');
  const hit = wrap.querySelector('#chartHit');
  const svg = wrap.querySelector('svg');
  const cross = wrap.querySelector('#crosshair');
  if (!hit) return { hit: null, svgHTML: svg ? svg.outerHTML.slice(0, 400) : 'no svg' };
  const r = hit.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  const cs = getComputedStyle(hit);
  return {
    hitAttrs: Object.fromEntries([...hit.attributes].map(a => [a.name, a.value])),
    hitRect: { x: r.x, y: r.y, w: r.width, h: r.height },
    wrapRect: { x: wr.x, y: wr.y, w: wr.width, h: wr.height },
    pointerEvents: cs.pointerEvents, fill: cs.fill,
    svgPointerEvents: getComputedStyle(svg).pointerEvents,
    crossExists: !!cross,
    elemAtHitCenter: (document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) || {}).id
      || (document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) || {}).tagName,
  };
}), null, 2));
await b.close();
