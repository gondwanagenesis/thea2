#!/bin/bash
# tunnel-url.sh — after Thea2's quick tunnel starts, find its URL and point her
# bot's menu button at it (Thea1's capture-tunnel-url.sh, for Thea2's own bot).
# A quick tunnel's hostname changes on every restart; a stale menu button would
# leave Diego tapping a dead link, so this re-derives it every start.
#
#   /opt/thea2/var/run/tunnel-url.txt   bare URL (no key)
#
# The key and the bot token come from /etc/thea2/keys.env and are never printed.
set -euo pipefail

UNIT=thea2-dashboard-tunnel.service
OUT=/opt/thea2/var/run/tunnel-url.txt
KEYS=/etc/thea2/keys.env
CHAT=6971556140

SINCE=$(systemctl show "$UNIT" -p ActiveEnterTimestamp --value)
[ -z "$SINCE" ] && SINCE="-1 day"
URL=""
for _ in $(seq 1 24); do
  URL=$(journalctl -u "$UNIT" --since "$SINCE" --no-pager -o cat 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
  [ -n "$URL" ] && break
  sleep 5
done
if [ -z "$URL" ]; then
  echo "tunnel-url: no tunnel URL in $UNIT logs since $SINCE" >&2
  exit 1
fi
printf '%s\n' "$URL" > "$OUT"
chown thea2:thea2 "$OUT" 2>/dev/null || true

TOKEN=$(grep -E '^THEA2_BOT_TOKEN=' "$KEYS" | head -1 | cut -d= -f2-)
KEY=$(grep -E '^THEA2_DASHBOARD_KEY=' "$KEYS" | head -1 | cut -d= -f2-)
if [ -z "$TOKEN" ] || [ -z "$KEY" ]; then
  echo "tunnel-url: bot token or dashboard key missing in $KEYS" >&2
  exit 1
fi
APP="${URL}/?k=${KEY}"
for scope in "\"chat_id\": \"${CHAT}\", " ""; do
  curl -s --max-time 10 "https://api.telegram.org/bot${TOKEN}/setChatMenuButton" \
    -H 'content-type: application/json' \
    -d "{${scope}\"menu_button\": {\"type\": \"web_app\", \"text\": \"Thea\", \"web_app\": {\"url\": \"${APP}\"}}}" >/dev/null
done
echo "tunnel-url: ${URL} (menu button re-pointed)"
