// W0.6 — pull the stuck worker's stack via the inspector protocol.
// Usage: node scripts/stack-dump.mjs <pid-derived-port> — activates nothing;
// it assumes the worker was started with --inspect=9230 and is wedged.
// Pauses the debugger, reads the call stack frames, prints them, detaches.

const port = process.argv[2] ?? '9230';
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const targets = list.filter((t) => t.type === 'node' || t.title.includes('vitest'));
if (targets.length === 0) {
  console.error('no debuggable target on 9230');
  process.exit(1);
}
const wsUrl = targets[0].webSocketDebuggerUrl;
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? msg.error);
    pending.delete(msg.id);
  }
};
await new Promise((r) => (ws.onopen = r));
await send('Debugger.enable');
await send('Debugger.pause');
await new Promise((r) => setTimeout(r, 800));
const evalRes = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    frames: (() => { const o = {}; Error.captureStackTrace(o); return o.stack.split('\\n').slice(0, 25); })(),
    mem: process.memoryUsage().rss,
    up: process.uptime(),
  })`,
  returnByValue: true,
});
console.log(evalRes?.result?.value ?? JSON.stringify(evalRes));
await send('Debugger.resume');
process.exit(0);
