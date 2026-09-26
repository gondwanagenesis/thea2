#!/usr/bin/env python3
# scripts/extract-thea1-opencode.py — Thea1's whole Telegram life, as exchanges.
#
# READ-ONLY (sqlite `mode=ro`) over Thea1's OpenCode store. Pairs each real
# message of Diego's with the reply Thea1 actually delivered (the text after
# the last ⟦TG⟧ sentinel) and writes one JSON line per exchange to stdout:
#
#   {"ts", "kind": "reply"|"text_first", "before": [{who,text}], "his",
#    "hers": [bubbles], "next": {"text","gapH"}|null, "tools": [names]}
#
# Pairing is by the reply's parentID (the user message it answers): Thea1
# queued his messages and answered them after, so time order interleaves.
# Machinery turns are skipped: sentinel resends carry the reply he saw to what
# is pending; scene / location / call / operator injections are not his words,
# so her answers to them are not exchanges with him. Quality is NOT judged
# here — scripts/import-thea1-convos.ts screens every exchange.
#
#   python3 scripts/extract-thea1-opencode.py > /opt/thea2/var/import/oc-pairs.jsonl

import json
import os
import re
import sqlite3
import sys
from bisect import bisect_right

DB = os.environ.get('THEA1_OPENCODE_DB', '/root/.local/share/opencode/opencode.db')
TG = '⟦TG⟧'

c = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)

# Thea1 forked herself for jobs, and a fork COPIES the whole session (messages keep
# their original time_created): 11k "user messages" were ~1.7k real ones. A session
# is a copy when its first message predates it; what happens in a copy after it was
# made is the fork's own job (task prompts, merge reports), never Diego talking.
FORK_SLACK_MS = 60_000
sessions = {}
for sid, created, first in c.execute(
    """select s.id, s.time_created, (select min(m.time_created) from message m where m.session_id = s.id) from session s"""
):
    copy = first is not None and first < created - FORK_SLACK_MS
    sessions[sid] = {'created': created, 'copy': copy}

rows = c.execute(
    """select m.id, m.session_id, m.time_created, json_extract(m.data,'$.role'), json_extract(m.data,'$.parentID'),
              json_extract(p.data,'$.type'), json_extract(p.data,'$.text'), json_extract(p.data,'$.tool')
       from message m join part p on p.message_id = m.id
       where json_extract(m.data,'$.agent') = 'telegram'
       order by m.time_created, p.time_created"""
)

raw = {}
raw_order = []
for mid, sid, ts, role, parent, typ, text, tool in rows:
    if mid not in raw:
        raw[mid] = {'id': mid, 'sid': sid, 'ts': ts, 'role': role, 'parent': parent, 'texts': [], 'tools': []}
        raw_order.append(mid)
    m = raw[mid]
    if typ == 'text' and text:
        m['texts'].append(text)
    elif typ == 'tool' and tool:
        m['tools'].append(tool)

# one canonical message per (role, time, text); every copy's id maps to it
stats = {'raw_messages': len(raw_order), 'fork_job_messages': 0, 'copies': 0}
canon_of = {}
by_key = {}
msgs = {}
order = []
for mid in raw_order:
    m = raw[mid]
    s = sessions.get(m['sid'], {'created': 0, 'copy': False})
    if s['copy'] and m['ts'] >= s['created'] - FORK_SLACK_MS:
        stats['fork_job_messages'] += 1
        continue
    key = (m['role'], m['ts'], '\n'.join(m['texts'])[:300])
    if key in by_key:
        canon_of[mid] = by_key[key]
        stats['copies'] += 1
        continue
    by_key[key] = mid
    canon_of[mid] = mid
    msgs[mid] = m
    order.append(mid)

# her delivered words, grouped under the (canonical) user message they answer
answers = {}
for mid in order:
    m = msgs[mid]
    if m['role'] != 'assistant' or m['parent'] is None:
        continue
    parent = canon_of.get(m['parent'])
    if parent is None:
        continue
    a = answers.setdefault(parent, {'ts': None, 'texts': [], 'tools': []})
    a['tools'].extend(m['tools'])
    for t in m['texts']:
        if TG not in t:
            continue
        s = t.split(TG)[-1].strip()
        if s and s not in a['texts']:
            a['texts'].append(s)
            a['ts'] = m['ts'] if a['ts'] is None else a['ts']


def unquote(s):
    s = s.strip()
    if len(s) >= 2 and s.startswith('"') and s.endswith('"'):
        try:
            return json.loads(s)
        except Exception:
            return s[1:-1]
    return s


def classify(text):
    """→ (kind, his_text). kind: his | first | resend | skip"""
    s = unquote(text)
    if s.startswith('(you are texting Diego FIRST') or s.startswith('(nobody has said anything yet'):
        return 'first', ''
    if s.startswith('(system'):
        return 'resend', ''
    if s.startswith('(') or s.startswith('[operator'):
        return 'skip', ''  # a scene, a location prompt, a call hand-off: not his words
    s = re.sub(r'^\[thread:\d+\]\s*', '', s)
    m = re.match(r'^\[image received: ([^\]]*)\]\s*(.*)$', s, re.S)
    if m:
        return 'his', ('[a photo] ' + m.group(2)).strip()
    m = re.match(r'^\[file received: ([^\]]*)\]\s*(.*)$', s, re.S)
    if m:
        return 'his', (f'[a file: {os.path.basename(m.group(1))}] ' + m.group(2)).strip()
    if s.startswith('['):
        return 'skip', ''
    return ('his', s) if s.strip() else ('skip', '')


def bubbles(text):
    return [b.strip() for b in re.split(r'\n\s*\n', text) if b.strip()]


pairs = []
stats.update({'his': 0, 'repeats': 0, 'answered': 0, 'first': 0, 'via_resend': 0, 'unanswered': 0})
history = []  # real lines only: {who, text}
pending = []  # his messages since her last delivered reply
his_times = []  # (ts, text) of every real message of his, for "next"


def emit(kind, a):
    global pending
    hers = [b for t in a['texts'] for b in bubbles(t)]
    before = history[: len(history) - len(pending)][-3:]
    pairs.append({
        'ts': a['ts'],
        'kind': kind,
        'before': before,
        'his': '\n'.join(pending[-3:]),
        'hers': hers,
        'tools': sorted(set(a['tools'])),
    })
    for b in hers:
        history.append({'who': 'her', 'text': b})
    pending = []


for mid in order:
    m = msgs[mid]
    if m['role'] != 'user':
        continue
    text = '\n'.join(m['texts'])
    kind, his = classify(text) if text else ('skip', '')
    a = answers.get(mid)
    said = a is not None and len(a['texts']) > 0
    if kind == 'his':
        stats['his'] += 1
        # the old retry path re-sent his message as a new one: one message, not three
        if pending and pending[-1] == his:
            stats['repeats'] += 1
        else:
            pending.append(his)
            history.append({'who': 'him', 'text': his})
            his_times.append((m['ts'], his))
        if said:
            stats['answered'] += 1
            emit('reply', a)
    elif kind == 'first':
        if said and not pending:
            stats['first'] += 1
            emit('text_first', a)
    elif kind == 'resend':
        if said and pending:
            stats['via_resend'] += 1
            emit('reply', a)
stats['unanswered'] = len(pending)

ts_only = [t for t, _ in his_times]
for p in pairs:
    k = bisect_right(ts_only, p['ts'])
    if k < len(his_times):
        nts, ntext = his_times[k]
        p['next'] = {'text': ntext[:400], 'gapH': round((nts - p['ts']) / 3600_000, 3)}
    else:
        p['next'] = None
    sys.stdout.write(json.dumps(p, ensure_ascii=False) + '\n')

sys.stderr.write(f'exchanges {len(pairs)} (reply {sum(p["kind"] == "reply" for p in pairs)}, '
                 f'text_first {sum(p["kind"] == "text_first" for p in pairs)}) · {stats}\n')
