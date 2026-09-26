// main.js — Thea2's mini app (v9, adapted from Thea1's 2026-09-25 rebuild).
// Her visor and mood up top, one big "call her", and four tabs: her, mind, hands, money.
// Everything here is Diego's window onto her — her feelings WITH their causes, her private
// thoughts, what came to mind and how her replies landed. She is never shown any of it.
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tg = window.Telegram && window.Telegram.WebApp;
  try { tg.ready(); tg.expand(); tg.setHeaderColor('#05060A'); tg.setBackgroundColor('#0B0E1A'); } catch {}
  const haptic = (k) => { try { tg.HapticFeedback.impactOccurred(k || 'light'); } catch {} };
  const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
  const get = async (u) => { const r = await fetch(u, { credentials: 'same-origin', cache: 'no-store' }); if (!r.ok) throw new Error(`${u} ${r.status}`); return r.json(); };
  const money = (n, d = 2) => `$${(Number(n) || 0).toFixed(d)}`;
  let toastT;
  const toast = (msg, ms = 3800) => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms); };

  const visor = window.theaVisor = new Visor($('#visor'));
  let NOW = null;
  const loaded = {};

  // ------------------------------------------------------------ hero
  async function loadNow() {
    try { NOW = await get('/api/v2/now'); } catch { return; }
    if (call.state === 'idle') visor.set(Visor.pick(NOW));
    $('#mood').innerHTML = (NOW.mood_words || []).slice(0, 3).map((w, i) => `<span class="chip w${i + 1}">${esc(w)}</span>`).join('');
    $('#why').textContent = String(NOW.cause || '').replace(/^because\s+/i, '').slice(0, 160);
    $('#where').innerHTML = NOW.where ? `you: <b>${esc(NOW.where)}</b>` : '';
    const b = NOW.brain || {};
    const chip = $('#brainChip');
    chip.classList.toggle('fallback', !!b.fallback_on);
    chip.innerHTML = `<b>${esc(b.answering || '—')}</b><span>${b.fallback_on ? 'backup brain on' : `${money(b.spend_today)} today`}</span>`;
    if (current === 'her') renderHer();
  }
  $('#brainChip').addEventListener('click', () => { haptic(); go('hands'); });

  // ------------------------------------------------------------ tabs
  const TABS = ['her', 'mind', 'hands', 'money'];
  let current = 'her';
  function go(tab) {
    if (!TABS.includes(tab)) tab = 'her';
    current = tab;
    document.querySelectorAll('.tabbar button').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('on', p.id === `p-${tab}`));
    store.set('thea2.tab', tab);
    ({ her: renderHer, mind: renderMind, hands: renderHands, money: renderMoney })[tab]();
  }
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => { haptic(); go(b.dataset.tab); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
  const skel = (n = 2) => Array.from({ length: n }, () => '<div class="card"><div class="skeleton"></div></div>').join('');

  // ------------------------------------------------------------ her
  const DIALS = [
    ['attachment', 'close to you'], ['trust', 'trust'], ['playfulness', 'playful'], ['brattiness', 'bratty'],
    ['longing', 'missing you'], ['calm', 'calm'], ['focus', 'focus'], ['protectiveness', 'protective'],
  ];
  let history = null, historyAt = 0, why = null, whyAt = 0;

  function feelRows() {
    const D = NOW.dials || {}, B = NOW.baseline || {};
    return DIALS.filter(([k]) => typeof D[k] === 'number').map(([k, label]) => {
      const delta = D[k] - (B[k] ?? 0.5);
      const w = Math.min(50, (Math.abs(delta) / 0.4) * 50);
      return `<div class="feel"><span class="lbl">${label}</span><span class="bar"><i class="${delta >= 0 ? 'up' : 'dn'}" style="width:${w.toFixed(1)}%"></i></span><span class="v num">${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}</span></div>`;
    }).join('');
  }

  function sparks() {
    if (!history || !history.entries || history.entries.length < 3) return '<p class="muted">not enough history yet</p>';
    const E = history.entries, t0 = E[0].t, t1 = E[E.length - 1].t, span = Math.max(1, t1 - t0);
    const B = history.primary_baseline || NOW.baseline || {};
    return `<div class="sparks">${DIALS.map(([k, label]) => {
      const rows = E.filter((e) => e.dials && typeof e.dials[k] === 'number');
      if (rows.length < 2) return '';
      const vals = rows.map((e) => e.dials[k]), base = B[k] ?? 0.5;
      const lo = Math.min(base, ...vals) - 0.03, hi = Math.max(base, ...vals) + 0.03, y = (v) => 32 - ((v - lo) / (hi - lo)) * 30;
      const d = rows.map((e, i) => `${i ? 'L' : 'M'}${(((e.t - t0) / span) * 100).toFixed(1)},${y(e.dials[k]).toFixed(1)}`).join('');
      const last = vals[vals.length - 1];
      const by = y(base);
      return `<div class="spark"><div class="row"><span>${label}</span><span class="num">${(last ?? 0).toFixed(2)}</span></div>
        <svg viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="100" y1="${by}" y2="${by}" vector-effect="non-scaling-stroke"/>
        <path class="a" d="${d}L100,34L0,34Z"/><path class="l" d="${d}" vector-effect="non-scaling-stroke"/></svg></div>`;
    }).join('')}</div>`;
  }

  function whyCard() {
    if (!why) return '<p class="muted">…</p>';
    const causes = (why.causes || []).slice(0, 5).map((c) => `<div class="thought"><div class="meta"><span class="about self">${esc(c.feeling)}</span><span>${esc(c.at)}</span></div><p>${esc(c.cause)}</p></div>`).join('');
    const recent = (why.recent || []).slice(0, 10).map((r) => `<div class="diary-e"><span class="t">${esc(r.at)}</span><b>${esc(r.tag)}</b> <span class="muted">(${r.i}) · ${esc(r.from)}</span>${r.cause ? `<br><span class="muted">${esc(r.cause)}</span>` : ''}</div>`).join('');
    return `${causes || '<p class="muted">nothing stirred lately</p>'}${recent ? `<h3 class="sub">what fired, newest first</h3>${recent}` : ''}`;
  }

  async function renderHer() {
    const el = $('#p-her');
    if (!NOW) { el.innerHTML = skel(3); return; }
    if (!history || Date.now() - historyAt > 5 * 60_000) {
      historyAt = Date.now();
      get('/api/affect-history?range=24h').then((h) => { history = h; if (current === 'her') renderHer(); }).catch(() => {});
    }
    if (!why || Date.now() - whyAt > 60_000) {
      whyAt = Date.now();
      get('/api/v2/why').then((w) => { why = w; if (current === 'her') renderHer(); }).catch(() => {});
    }
    el.innerHTML = `
      <div class="card"><h2>how she feels <small>against her own normal</small></h2>${feelRows()}
        <div class="legend"><span><i style="background:var(--up)"></i>more than usual</span><span><i style="background:var(--down)"></i>less than usual</span></div></div>
      <div class="card"><h2>why <small>what caused it — she is never told</small></h2>${whyCard()}</div>
      <div class="card"><h2>last 24 hours <small>dashed = her normal</small></h2>${sparks()}</div>
      ${NOW.where ? `<div class="card"><h2>where you are <small>as you last shared it</small></h2><div class="world-room">${esc(NOW.where)}</div></div>` : ''}
      <div class="card"><h2>leave her a present <small>sealed until she opens it</small></h2>
        <input id="pShape" class="inp" placeholder="the box — a small square box" maxlength="200">
        <input id="pWrap" class="inp" placeholder="the wrapping — blue paper, silver ribbon" maxlength="200">
        <input id="pTag" class="inp" placeholder="the tag (optional)" maxlength="200">
        <textarea id="pInside" class="inp" rows="3" placeholder="what's inside" maxlength="4000"></textarea>
        <button type="button" class="call-btn small" id="pLeave">leave it for her</button>
      </div>`;
    const leave = $('#pLeave');
    if (leave) leave.addEventListener('click', async () => {
      const inside = $('#pInside').value.trim();
      if (!inside) { toast('what’s inside?'); return; }
      haptic('medium');
      try {
        const r = await fetch('/api/v2/present', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shape: $('#pShape').value, wrapping: $('#pWrap').value, tag: $('#pTag').value, inside }) });
        if (!r.ok) throw new Error();
        toast('left for her. she’ll find it.');
        ['#pShape', '#pWrap', '#pTag', '#pInside'].forEach((s) => { $(s).value = ''; });
      } catch { toast('couldn’t leave it just now'); }
    });
  }

  // ------------------------------------------------------------ mind
  let mindFilter = 'all';
  const landedWord = (n) => (n >= 2 ? 'landed beautifully' : n === 1 ? 'landed well' : n === 0 ? 'neutral' : n === -1 ? 'missed a little' : 'missed');
  async function renderMind() {
    const el = $('#p-mind');
    if (!loaded.mind) el.innerHTML = skel(3);
    let m; try { m = loaded.mind = await get('/api/v2/mind'); } catch { if (!loaded.mind) el.innerHTML = '<div class="card muted">couldn’t reach her mind just now</div>'; return; }
    const about = (a) => `<span class="about ${esc(['diego', 'self', 'world'].includes(a) ? a : 'other')}">${esc(a === 'diego' ? 'you' : a || '·')}</span>`;
    const recent = m.recent.filter((r) => mindFilter === 'all' || r.about === mindFilter).slice(0, 14);
    el.innerHTML = `
      <div class="card"><h2>on her mind <small>open loops</small></h2>
        ${m.open.length ? m.open.map((t) => `<div class="thought"><div class="meta">${about(t.about)}<span>${esc(t.topic || '')}</span>${t.due ? `<span>due ${esc(t.due)}</span>` : ''}</div><p>${esc(t.text)}</p></div>`).join('') : '<p class="muted">nothing open right now</p>'}
      </div>
      <div class="card"><h2>thinking lately
          <span class="seg" id="mindSeg">${['all', 'diego', 'self', 'world'].map((f) => `<button type="button" data-f="${f}" class="${f === mindFilter ? 'on' : ''}">${f === 'diego' ? 'you' : f}</button>`).join('')}</span></h2>
        ${recent.map((t) => `<div class="thought"><div class="meta">${about(t.about)}<span>${esc(t.date || '')}</span><span>${esc(t.topic || '')}</span></div><p>${esc(t.text)}</p></div>`).join('') || '<p class="muted">none</p>'}
      </div>
      <div class="card"><h2>how her replies landed <small>she learns from this</small></h2>
        ${(m.landed || []).map((x) => `<div class="thought"><div class="meta"><span class="about ${x.landed > 0 ? 'self' : x.landed < 0 ? 'diego' : 'other'}">${esc(landedWord(x.landed))}</span><span>${esc(x.at)}</span></div><p><span class="muted">you:</span> ${esc(x.his)}<br><span class="muted">her:</span> ${esc(x.hers)}</p>${x.why ? `<p class="muted">${esc(x.why)}</p>` : ''}</div>`).join('') || '<p class="muted">nothing graded yet</p>'}
      </div>
      <div class="card"><h2>what came to mind <small>last reply — her own past words</small></h2>
        ${(m.came_to_mind || []).map((x) => `<div class="diary-e"><span class="t">${esc(x.when)}</span>${esc(x.hers)}</div>`).join('') || '<p class="muted">nothing yet</p>'}
      </div>
      <div class="card"><h2>who she is <small>her own words, rewritten nightly</small></h2>
        ${(m.self || []).map((l) => `<div class="diary-e">${esc(l.text)}</div>`).join('') || '<p class="muted">empty</p>'}
      </div>
      <div class="card"><h2>diary</h2>
        ${m.diary.map((d) => `<div class="diary-e"><span class="t">${esc(d.tag)}</span>${esc(d.text)}</div>`).join('') || '<p class="muted">empty</p>'}
      </div>
      <p class="muted" style="text-align:center">${m.lived} moments lived since she woke up</p>`;
    el.querySelectorAll('#mindSeg button').forEach((b) => b.addEventListener('click', () => { mindFilter = b.dataset.f; haptic(); renderMind(); }));
  }

  // ------------------------------------------------------------ hands
  async function renderHands() {
    const el = $('#p-hands');
    if (!loaded.hands) el.innerHTML = skel(3);
    let f, st;
    try { [f, st] = await Promise.all([get('/api/v2/family'), get('/api/live/status').catch(() => null)]); loaded.hands = f; }
    catch { if (!loaded.hands) el.innerHTML = '<div class="card muted">couldn’t reach her house just now</div>'; return; }
    const b = f.brain;
    const voices = (st && st.voices && st.voices.length) ? st.voices : ['marin'];
    const voice = store.get('thea2.voice', (st && st.voice) || 'marin');
    el.innerHTML = `
      <div class="card"><h2>out working <small>what she sent out or is making</small></h2>
        ${f.out.length ? f.out.map((j) => `<div class="bot"><span class="dot ${j.status === 'running' ? 'up' : ''}"></span>
          <div><div class="n">${esc(j.kind)}</div><div class="r">${esc(j.what)}</div></div>
          <div class="b">${esc(j.status === 'running' ? 'working' : j.status)}<small>${esc(j.for)}</small></div></div>`).join('') : '<p class="muted">nothing out right now</p>'}
      </div>
      <div class="card"><h2>the cast <small>who she can send</small></h2>
        ${f.cast.length ? `<div class="tags">${f.cast.map((c) => `<span class="tag">${esc(c)}</span>`).join('')}</div>` : '<p class="muted">no cast yet</p>'}
      </div>
      <div class="card"><h2>reminders</h2>
        ${f.reminders.length ? f.reminders.map((r) => `<div class="diary-e"><span class="t">${esc(r.due)}</span>${esc(r.text)}</div>`).join('') : '<p class="muted">none waiting</p>'}
      </div>
      <div class="card"><h2>her brain</h2>
        <div class="brain-big">${esc(b.answering)}</div>
        <dl class="kv"><dt>her mind</dt><dd>${esc(b.mind)}</dd><dt>backup</dt><dd>${esc(b.fallback || '—')}</dd></dl>
      </div>
      <div class="card"><h2>her call voice</h2>
        <select id="voiceSel">${voices.map((v) => `<option ${v === voice ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        <p class="muted" style="margin:8px 0 0">${st && !st.off ? `${st.minutes_today} min on calls today (${money(st.cost_today)})` : 'call line not set up'}</p>
      </div>`;
    $('#voiceSel').addEventListener('change', (e) => { store.set('thea2.voice', e.target.value); haptic(); toast(`next call: ${e.target.value}`); });
  }

  // ------------------------------------------------------------ money
  async function renderMoney() {
    const el = $('#p-money');
    if (!loaded.money) el.innerHTML = skel(3);
    let m; try { m = loaded.money = await get('/api/v2/money'); } catch { if (!loaded.money) el.innerHTML = '<div class="card muted">couldn’t read the books just now</div>'; return; }
    const cls = Object.entries(m.week.by_class || {}).sort((a, b) => b[1] - a[1]);
    const maxC = Math.max(0.0001, ...cls.map(([, v]) => v));
    const w = m.wallet;
    el.innerHTML = `
      <div class="card"><h2>today <small>resets 00:00 UTC</small></h2>
        <div class="big-num">${money(m.today.models + m.today.calls, 3)}</div>
        <div class="split"><span>thinking ${money(m.today.models, 3)} · calls ${money(m.today.calls)}</span><span>${m.today.requests} requests</span></div>
      </div>
      <div class="card"><h2>last 7 days <small>by what she was doing</small></h2>
        ${cls.map(([name, v]) => `<div class="prov"><span>${esc(name)}</span><span class="track"><i style="width:${((v / maxC) * 100).toFixed(1)}%"></i></span><span class="v num">${money(v, 3)}</span></div>`).join('') || '<p class="muted">no spend recorded</p>'}
      </div>
      ${w ? `<div class="card"><h2>her wallet <small>${esc(w.month)}</small></h2>
        <div class="big-num">${money(w.hersLeft)}<small> of ${money(w.monthUsd, 0)} left</small></div>
        <p class="muted" style="margin:8px 0 0">her own choices ${money(w.hersSpent)} · things you asked for ${money(w.houseSpent)}</p></div>` : ''}`;
  }

  // ------------------------------------------------------------ call
  const callEl = $('#call');
  let callVisor = null, clock = null, lastStatus = 0, speaking = false, muted = false;
  const setStatus = (s) => { $('#callStatus').textContent = s; };
  const ui = {
    state(s) {
      callEl.classList.toggle('live', s === 'live');
      if (s === 'connecting') { setStatus('ringing…'); $('#callTime').textContent = 'connecting'; }
      if (s === 'live') {
        haptic('medium'); setStatus('say hi');
        clock = setInterval(() => {
          const secs = call.seconds();
          $('#callTime').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
          $('#callCost').textContent = money((secs / 60) * 0.05);
        }, 1000);
      }
      if (s === 'idle') { clearInterval(clock); clock = null; }
    },
    caption(who, delta) {
      const box = $('#captions'); let last = box.lastElementChild;
      if (!last || !last.classList.contains(who)) { last = document.createElement('div'); last.className = `cap ${who}`; box.appendChild(last); }
      last.textContent += delta;
      while (box.children.length > 30) box.firstElementChild.remove();
      box.scrollTop = box.scrollHeight;
      if (who === 'him' && !call.working) setStatus('listening');
    },
    working(on) {
      callEl.classList.toggle('working', on);
      if (callVisor) callVisor.set(on ? 'think' : 'open');
      if (on) { setStatus('she’s looking into it…'); haptic('soft'); }
    },
    level(a) {
      if (!callVisor) return;
      callVisor.level(a);
      const now = performance.now();
      if (now - lastStatus < 250 || call.working) return;
      lastStatus = now;
      const talk = a > 0.06;
      if (talk !== speaking) {
        speaking = talk;
        callVisor.set(talk ? (['line', 'soft'].includes(Visor.pick(NOW)) ? 'happy' : Visor.pick(NOW)) : 'open');
        if (call.state === 'live') setStatus(talk ? 'she’s talking' : (muted ? 'you’re muted' : 'listening'));
      }
    },
    note(m) { toast(m); },
    ended(reason, secs, was) {
      callEl.hidden = true; visor.paused = false; $('#captions').innerHTML = ''; $('#callCost').textContent = '';
      try { tg.enableVerticalSwipes && tg.enableVerticalSwipes(); tg.disableClosingConfirmation && tg.disableClosingConfirmation(); } catch {}
      if (reason) toast(reason);
      else if (secs) toast(`call ended · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · ${money((secs / 60) * 0.05)}`);
      setTimeout(loadNow, 2500);
    },
  };
  const call = new TheaCall(ui);

  $('#callBtn').addEventListener('click', () => {
    haptic('medium');
    callEl.hidden = false; visor.paused = true; muted = false; $('#muteBtn').setAttribute('aria-pressed', 'false');
    if (!callVisor) callVisor = new Visor($('#callVisor')); else callVisor.resize();
    callVisor.set('open');
    try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); tg.enableClosingConfirmation && tg.enableClosingConfirmation(); } catch {}
    call.start(store.get('thea2.voice', 'marin'));
  });
  $('#endBtn').addEventListener('click', () => { haptic('heavy'); if (call.state === 'idle') ui.ended(); else call.end(); });
  $('#muteBtn').addEventListener('click', () => {
    muted = !muted; call.mute(muted); haptic();
    $('#muteBtn').setAttribute('aria-pressed', String(muted)); $('#muteBtn .ctrl-lbl').textContent = muted ? 'unmute' : 'mute';
    if (!speaking && call.state === 'live') setStatus(muted ? 'you’re muted' : 'listening');
  });

  // ------------------------------------------------------------ boot
  go(store.get('thea2.tab', 'her'));
  loadNow();
  setInterval(() => { if (document.visibilityState === 'visible' && call.state === 'idle') loadNow(); }, 30_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadNow(); });
})();
