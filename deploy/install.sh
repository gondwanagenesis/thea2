#!/bin/sh
# Thea2 VPS install — run as root on the target host.
#   ./install.sh
# Installs to /opt/thea2, creates the thea2 system user, wires the two systemd
# units + timer, and lays down /etc/thea2/keys.env (0600) if absent.
# NEVER echoes secret values; only checks presence/placeholder state.
set -eu

PREFIX=/opt/thea2
KEYS=/etc/thea2/keys.env
SRC="$(cd "$(dirname "$0")/.." && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

# --- host prereqs -----------------------------------------------------------
command -v node >/dev/null || { echo "node missing"; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { echo "node >= 20 required, got $NODE_MAJOR"; exit 1; }
command -v zstd >/dev/null || { echo "zstd missing (apt install zstd)"; exit 1; }

# --- user + tree ------------------------------------------------------------
id -u thea2 >/dev/null 2>&1 || useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin thea2

mkdir -p "$PREFIX" "$PREFIX/var" /var/backups/thea2 /etc/thea2
rsync -a --delete \
      --exclude node_modules --exclude var --exclude scratch --exclude .claude \
      "$SRC/" "$PREFIX/"
mkdir -p "$PREFIX/node_modules"
npm ci --prefix "$PREFIX" --no-audit --no-fund

install -d -o thea2 -g thea2 "$PREFIX/var" /var/backups/thea2
chown -R thea2:thea2 "$PREFIX"

# --- bin wrappers -----------------------------------------------------------
mkdir -p "$PREFIX/bin"
install -m 0755 "$PREFIX/deploy/bin/thead"  "$PREFIX/bin/thead"
install -m 0755 "$PREFIX/deploy/bin/backup" "$PREFIX/bin/backup"

# --- secrets ----------------------------------------------------------------
# AGENTS rule 7: keys never in the tree. Bot token MUST be a NEW bot — never
# Thea1's @Demigourgosbot. Create it with BotFather before filling this file.
if [ ! -f "$KEYS" ]; then
  umask 077
  cat > "$KEYS" <<'EOF'
# Thea2 secrets — sourced by systemd before the privilege drop.
# Fill these in; the service refuses to be meaningful without them.
THEA2_BOT_TOKEN=PLACEHOLDER_NEW_BOT_TOKEN
THEA2_MODEL_API_KEY=PLACEHOLDER
EOF
  chown root:root "$KEYS"
  echo ">> created $KEYS — fill it in (NEW bot token, never @Demigourgosbot)"
fi

if grep -q 'PLACEHOLDER' "$KEYS"; then
  echo ">> $KEYS still has placeholders: enabling the unit but NOT starting it."
  START=0
else
  START=0   # operator starts explicitly after the S5 smoke (ops.md §3)
fi

# --- systemd ----------------------------------------------------------------
install -m 0644 "$PREFIX/deploy/thea2.service"         /etc/systemd/system/thea2.service
install -m 0644 "$PREFIX/deploy/thea2-backup.service"  /etc/systemd/system/thea2-backup.service
install -m 0644 "$PREFIX/deploy/thea2-backup.timer"    /etc/systemd/system/thea2-backup.timer
systemctl daemon-reload
systemctl enable thea2.service thea2-backup.timer >/dev/null

cat <<'EOF'
>> install done. Remaining operator steps (deploy/ops.md):
   1. fill /etc/thea2/keys.env  (NEW Telegram bot token — never Thea1's)
   2. thea2.config.yaml sanity pass
   3. systemctl start thea2  — ONLY after S5★ lands and live smoke passes
   4. systemctl start thea2-backup.timer
   Thea1 keeps running until the explicit cutover decision (ops.md §5).
EOF
