#!/usr/bin/env python3
# The salon, fix 3 (2026-09-27, Diego: "the 2 need to track who's talking, she gets confused"): in
# Thea1's session history a salon line was plain text like Diego's (who.js names the speaker only for
# the current turn). Her sister's lines now carry her name, so the history says who said what.
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else '/opt/holobionte/telegram-opencode.mjs'
s = open(SRC, encoding='utf-8').read()
if "text: 'Thea2: ' + text" in s:
    print('already patched'); sys.exit(0)
old = "date: Math.floor(Date.now() / 1000), text });"
if s.count(old) != 1:
    print(f'FAIL names: matched {s.count(old)} times'); sys.exit(2)
s = s.replace(old, "date: Math.floor(Date.now() / 1000), text: 'Thea2: ' + text }); // her name rides with her words, in the history too")
open(SRC + '.salon-new', 'w', encoding='utf-8').write(s)
print('ok   names; wrote', SRC + '.salon-new')
