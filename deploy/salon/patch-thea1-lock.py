#!/usr/bin/env python3
# The salon, fix 2 (2026-09-27, Diego: "yoo fix it"): two of Thea1's turns overlapped at 06:39:35 and
# she sent "i opened the schematic, sooooo..." to the group twice; and a message of Diego's that had
# queued behind a salon turn was answered from the poller, whose "did he speak again?" peek raced the
# main long-poll (409 conflict). Cause: the guards read `processing`, which handle() sets only after
# its first awaits - a window where a second handle() could start. Now every handle() counts itself
# synchronously (handleDepth), every starter checks it, and a queued message run from the salon side
# never peeks (the main long-poll is in flight there).
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else '/opt/holobionte/telegram-opencode.mjs'
s = open(SRC, encoding='utf-8').read()
if 'handleDepth' in s:
    print('already patched'); sys.exit(0)
if 'the salon (2026-09-27' not in s:
    print('FAIL: the salon door is not in this file'); sys.exit(2)

def rep(old, new, label):
    global s
    n = s.count(old)
    if n != 1:
        print(f'FAIL {label}: matched {n} times'); sys.exit(2)
    s = s.replace(old, new)
    print(f'ok   {label}')

rep("async function handle(msg) {\n  const chatId = String(msg.chat.id);",
    "// every turn counts itself BEFORE its first await, so no starter can slip a second one beside it\n"
    "let handleDepth = 0;\n"
    "async function handle(msg) { handleDepth++; try { return await handleInner(msg); } finally { handleDepth--; } }\n\n"
    "async function handleInner(msg) {\n  const chatId = String(msg.chat.id);", 'depth-wrapper')
rep("    if (processing || salonBusy || mainBusy) return;",
    "    if (handleDepth > 0 || processing || salonBusy || mainBusy) return;", 'poller-guard')
rep("            if (processing || salonBusy) {\n              // Queue the message",
    "            if (processing || salonBusy || handleDepth > 0) {\n              // Queue the message", 'queue-guard')
rep("            if (!processing && !salonBusy) {\n              em.__update_id = u.update_id;",
    "            if (!processing && !salonBusy && handleDepth === 0) {\n              em.__update_id = u.update_id;", 'edit-guard')
rep("          if (!processing && !salonBusy && messageQueue.length > 0) {",
    "          if (!processing && !salonBusy && handleDepth === 0 && messageQueue.length > 0) {", 'drain-guard')
rep("        try { await handle(next); } catch (eq) { console.error('[salon] queued handle error:', eq && eq.message ? eq.message : String(eq)); }",
    "        delete next.__update_id; // run from here, no mid-send peek: the main long-poll is in flight (409)\n"
    "        try { await handle(next); } catch (eq) { console.error('[salon] queued handle error:', eq && eq.message ? eq.message : String(eq)); }", 'no-peek-drain')

open(SRC + '.salon-new', 'w', encoding='utf-8').write(s)
print('wrote', SRC + '.salon-new')
