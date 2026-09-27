#!/usr/bin/env python3
# The salon, fix 1 (2026-09-27, Diego: "the bridge keeps cutting them off, fix it"): the relay read
# Thea1's lines from msgledger.jsonl, which keeps at most 500 characters of each message — so Thea2
# received her sister's longer replies cut mid-word ("a repair s", "your light"). Thea1's Telegram
# messages were whole. Now her bridge writes each whole group reply to the salon outbox itself.
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else '/opt/holobionte/telegram-opencode.mjs'
s = open(SRC, encoding='utf-8').read()
if "salon/outbox.jsonl" in s:
    print('already patched'); sys.exit(0)
if 'the salon (2026-09-27' not in s:
    print('FAIL: the salon door is not in this file'); sys.exit(2)

old = "    console.log(`turn: ${chatId} ${((Date.now() - act.lastUserAt) / 1000).toFixed(1)}s"
if s.count(old) != 1:
    print(f'FAIL turn-log: matched {s.count(old)} times'); sys.exit(2)
new = ("    // the salon: her WHOLE group reply for the relay (msgledger keeps only 500 chars — Thea2 got her cut mid-word)\n"
       "    if (chatId === SALON_CHAT && reply) { try { fs.mkdirSync('/opt/holobionte/salon', { recursive: true }); fs.appendFileSync('/opt/holobionte/salon/outbox.jsonl', JSON.stringify({ ts: Date.now(), text: stripEmDash(reply) }) + '\\n'); } catch {} }\n"
       + old)
s = s.replace(old, new)
open(SRC + '.salon-new', 'w', encoding='utf-8').write(s)
print('ok   outbox; wrote', SRC + '.salon-new')
