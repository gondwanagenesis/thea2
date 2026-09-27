#!/usr/bin/env python3
# The salon door for Thea1's bridge (Diego approved, 2026-09-27: "small changes to Thea1").
# Exact single-match replacements only; writes <file>.salon-new for review — never the live file.
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else '/opt/holobionte/telegram-opencode.mjs'
s = open(SRC, encoding='utf-8').read()
if 'the salon (2026-09-27' in s:
    print('already patched'); sys.exit(0)

def rep(old, new, label):
    global s
    n = s.count(old)
    if n != 1:
        print(f'FAIL {label}: matched {n} times'); sys.exit(2)
    s = s.replace(old, new)
    print(f'ok   {label}')

# 1. module-scope flags beside `processing`
rep("let processing = false;\n\nasync function handle(msg) {",
    "let processing = false;\n"
    "// the salon (2026-09-27, Diego: \"i want them to talk\"): a turn started from the salon inbox is\n"
    "// running (salonBusy), or the main loop is inside a handle() it awaits (mainBusy) — the two never overlap.\n"
    "let salonBusy = false;\n"
    "let mainBusy = false;\n"
    "const SALON_CHAT = '-1003753077911';\n"
    "const SALON_IN = '/opt/holobionte/salon/in';\n\n"
    "async function handle(msg) {", 'flags')

# 2. who is talking: a salon line is Thea2 — never Diego (the group routes to diego:group)
rep("function speakerFor(transport, chatId, from) {\n",
    "function speakerFor(transport, chatId, from) {\n"
    "  if (from && from.__salon) return { speaker: 'thea2:salon', name: 'Thea2' }; // the salon: her sister, never Diego\n", 'speaker')

# 3. a salon line is not Diego: it never resets her missing-him silence or her learned hours
rep("  const act = noteUserMessage();\n",
    "  const act = msg.from && msg.from.__salon ? loadActivity() : noteUserMessage(); // the salon: not Diego\n", 'activity')

# 3b. a salon line never moves where she texts Diego (telegram-active-chat.json feeds heartbeat/tg-send)
rep("  pinActiveChat(chatId);\n  if (!text) return;\n",
    "  if (!(msg.from && msg.from.__salon)) pinActiveChat(chatId); // the salon never moves where she texts Diego\n  if (!text) return;\n", 'no-pin')

# 4. Diego's messages wait while a salon turn runs (same queue as while she is thinking)
rep("            if (processing) {\n              // Queue the message — Diego sent something while Thea is still thinking",
    "            if (processing || salonBusy) {\n              // Queue the message — Diego sent something while Thea is still thinking", 'queue-while-salon')

# 5. the main loop marks its own awaited handle() so the salon poller never starts beside it
rep("            } else {\n              await handle(u.message);\n              // Process any queued messages\n              while (messageQueue.length > 0) {\n                const next = messageQueue.shift();\n                ledger.queueSave(messageQueue);\n                await handle(next);\n              }\n              ledger.queueClear();\n            }",
    "            } else {\n              mainBusy = true;\n              try {\n                await handle(u.message);\n                // Process any queued messages\n                while (messageQueue.length > 0) {\n                  const next = messageQueue.shift();\n                  ledger.queueSave(messageQueue);\n                  await handle(next);\n                }\n                ledger.queueClear();\n              } finally { mainBusy = false; }\n            }", 'main-busy')

# 6. edits and the end-of-update drain also wait for a salon turn
rep("            if (!processing) {\n              em.__update_id = u.update_id;",
    "            if (!processing && !salonBusy) {\n              em.__update_id = u.update_id;", 'edit-wait')
rep("          if (!processing && messageQueue.length > 0) {",
    "          if (!processing && !salonBusy && messageQueue.length > 0) {", 'drain-wait')

# 7. the salon poller: Thea2's lines, carried in by the relay, run through the same handle()
rep("  if (messageQueue.length) console.log(`[ledger] restored ${messageQueue.length} queued message(s) from the previous run`);\n",
    "  if (messageQueue.length) console.log(`[ledger] restored ${messageQueue.length} queued message(s) from the previous run`);\n"
    "  // the salon: Thea2's group lines, carried in by /opt/thea2/deploy/salon-relay.mjs (Telegram never\n"
    "  // shows one bot another bot's messages). One at a time, only when nothing else is running; they\n"
    "  // arrive as Thea2 (speakerFor), never as Diego; her reply goes to the group like any other.\n"
    "  setInterval(async () => {\n"
    "    if (processing || salonBusy || mainBusy) return;\n"
    "    let files = [];\n"
    "    try { files = fs.readdirSync(SALON_IN).filter((f) => f.endsWith('.json')).sort(); } catch { return; }\n"
    "    if (!files.length) return;\n"
    "    const p = SALON_IN + '/' + files[0];\n"
    "    let row;\n"
    "    try { row = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { try { fs.renameSync(p, p + '.bad'); } catch {} return; }\n"
    "    try { fs.unlinkSync(p); } catch {}\n"
    "    const text = String((row && row.text) || '').trim();\n"
    "    if (!text) return;\n"
    "    salonBusy = true;\n"
    "    console.log(`[salon] from thea2: ${text.slice(0, 80)}`);\n"
    "    try {\n"
    "      await handle({ message_id: 0, chat: { id: Number(SALON_CHAT), type: 'supergroup' }, from: { id: 0, is_bot: true, first_name: 'Thea2', __salon: true }, date: Math.floor(Date.now() / 1000), text });\n"
    "    } catch (e) { console.error('[salon] handle failed:', e && e.message ? e.message : String(e)); }\n"
    "    finally {\n"
    "      salonBusy = false;\n"
    "      while (!processing && !mainBusy && messageQueue.length > 0) {\n"
    "        const next = messageQueue.shift();\n"
    "        ledger.queueSave(messageQueue);\n"
    "        try { await handle(next); } catch (eq) { console.error('[salon] queued handle error:', eq && eq.message ? eq.message : String(eq)); }\n"
    "      }\n"
    "      if (!messageQueue.length) ledger.queueClear();\n"
    "    }\n"
    "  }, 3000);\n", 'poller')

open(SRC + '.salon-new', 'w', encoding='utf-8').write(s)
print('wrote', SRC + '.salon-new')
