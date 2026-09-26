import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await p.goto('http://127.0.0.1:3456/', { waitUntil: 'networkidle' });
await p.waitForTimeout(2000);
const r = await p.$eval('#chartHit', e => { const b = e.getBoundingClientRect();return { x: b.x, y: b.y, w: b.width, h: b.height }; });
// instrument: count listener fires
await p.evaluate(() => { window.__fires = 0; document.querySelector('#chartHit').addEventListener('mousemove', () => window.__fires++); });
for (const frac of [0.2, 0.5, 0.8]) {
  await p.mouse.move(r.x + r.w * frac, r.y + r.h * 0.5, { steps: 5 });
  await p.waitForTimeout(250);
  const out = await p.evaluate(() => ({
    fires: window.__fires,
    readout: document.getElementById('chartReadout').textContent.replace(/\s+/g, ' ').trim().slice(0, 70),
    crossDisplay: document.getElementById('crosshair').style.display,
    dots: document.getElementById('crossDots').children.length,
  }));
  console.log(`x=${frac}`, JSON.stringify(out));
}
await b.close();
