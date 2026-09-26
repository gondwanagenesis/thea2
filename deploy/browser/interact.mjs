import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
p.on('console', m => { if (m.type() === 'error')errs.push(m.text()); });
await p.goto('http://127.0.0.1:3456/', { waitUntil: 'networkidle' });
await p.waitForTimeout(2000);
const T = async (label, fn) => { try { const r = await fn();console.log(`  ${label}: ${r}`); } catch (e) { console.log(`  ${label}: FAIL ${e.message}`); } };

console.log('--- range toggle 7d ---');
await T('click 7d', async () => { await p.click('#rangeToggle [data-range="7d"]'); await p.waitForTimeout(1200);
  return await p.$eval('#chartMeta', e => e.textContent.trim()); });
await T('7d btn is-on', () => p.$eval('#rangeToggle [data-range="7d"]', e => e.className));
await T('back to 24h', async () => { await p.click('#rangeToggle [data-range="24h"]'); await p.waitForTimeout(1200);
  return await p.$eval('#chartMeta', e => e.textContent.trim()); });

console.log('--- table toggle ---');
await T('show table', async () => { await p.click('#tableToggle'); await p.waitForTimeout(400);
  return 'hidden=' + await p.$eval('#tableView', e => e.hidden) + ' rows=' + await p.$$eval('#tableView tr', r => r.length); });

console.log('--- ponder filters ---');
for (const f of ['diego', 'self', 'world', 'all']) {
  await T(`filter ${f}`, async () => { await p.click(`#ponderFilter [data-about="${f}"]`); await p.waitForTimeout(300);
    return await p.$$eval('#ponderList > *', n => n.filter(x => x.offsetParent !== null).length) + ' visible'; });
}
console.log('--- map room click ---');
const rooms = await p.$$eval('#mapWrap [data-room]', n => n.map(x => x.getAttribute('data-room')).slice(0, 4));
console.log('  rooms found:', rooms.join(', '));
for (const r of rooms.slice(0, 2)) {
  await T(`click room ${r}`, async () => { await p.click(`#mapWrap [data-room="${r}"]`); await p.waitForTimeout(300);
    return (await p.$eval('#roomDetail', e => e.textContent.trim())).slice(0, 50); });
}
console.log('--- chart scrub ---');
await T('scrub middle', async () => { const bb = await p.$eval('#chartWrap', e => { const r = e.getBoundingClientRect();return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await p.mouse.move(bb.x + bb.w * 0.35, bb.y + bb.h * 0.5); await p.waitForTimeout(300);
  return (await p.$eval('#chartReadout', e => e.textContent.trim())).slice(0, 60); });
console.log('=== ERRORS ==='); errs.length ? errs.forEach(e => console.log(e)) : console.log('  none');
await b.close();
