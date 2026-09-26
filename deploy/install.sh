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

# Deploy only from a clean, committed tree: what runs must be what git has
# (the 2026-09-02 review found the box one commit behind plus 49 uncommitted
# files, and the docs describing the working tree instead of the deploy).
# Not a git checkout (or no git): the rule cannot be enforced, so it degrades
# to a loud warning rather than either blocking the install or passing silent.
if git -C "$SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # Tracked dirt only: the deploy target's own runtime artifacts (bin/,
  # corpus/derived/, var/) are untracked by design and must not block a redeploy.
  if [ -n "$(git -C "$SRC" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    echo ">> $SRC has uncommitted changes — commit or stash first (deploy/ops.md §2)"; exit 1
  fi
else
  echo ">> WARNING: $SRC is not a git checkout — deploying WITHOUT the clean-tree guarantee (deploy/ops.md §2)"
fi

mkdir -p "$PREFIX" /etc/thea2
install -d -m 0750 "$PREFIX/var" /var/backups/thea2
# Runtime-written paths survive a redeploy: rsync --delete must never wipe
# what the box learned (lived scenes, proposals, the probe baseline).
rsync -a --delete \
      --exclude node_modules --exclude var --exclude scratch --exclude .claude \
      --exclude corpus/lived --exclude corpus/proposals --exclude probes/baseline.json \
      "$SRC/" "$PREFIX/"
mkdir -p "$PREFIX/node_modules"
npm ci --prefix "$PREFIX" --no-audit --no-fund

install -d -m 0750 -o thea2 -g thea2 "$PREFIX/var" /var/backups/thea2
chown -R thea2:thea2 "$PREFIX"

[ -f "$PREFIX/corpus/derived/manifest.json" ] || \
  echo ">> WARNING: corpus/derived/manifest.json is absent — she boots on canon alone (ADR-007: derive on a dev machine, commit the output)"

# --- bin wrappers -----------------------------------------------------------
mkdir -p "$PREFIX/bin"
install -m 0755 "$PREFIX/deploy/bin/thead"  "$PREFIX/bin/thead"
install -m 0755 "$PREFIX/deploy/bin/backup" "$PREFIX/bin/backup"
install -m 0755 "$PREFIX/deploy/bin/thea2"  "$PREFIX/bin/thea2"
ln -sf "$PREFIX/bin/thea2" /usr/local/bin/thea2

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
fi
# The operator starts the unit explicitly (ops.md §3); install never does.

# --- systemd ----------------------------------------------------------------
install -m 0644 "$PREFIX/deploy/thea2.service"         /etc/systemd/system/thea2.service
install -m 0644 "$PREFIX/deploy/thea2-backup.service"  /etc/systemd/system/thea2-backup.service
install -m 0644 "$PREFIX/deploy/thea2-backup.timer"    /etc/systemd/system/thea2-backup.timer
# v9 body: the code sandbox broker (root, so it can hand each script to
# systemd-run as a throwaway user with no network). Its socket lives in var/run.
install -m 0644 "$PREFIX/deploy/thea2-exec.service"    /etc/systemd/system/thea2-exec.service
# v9 face: the Mini App's own quick tunnel (never Thea1's), and the script that
# re-points @dodonotnobot's menu button at it after every start.
install -m 0644 "$PREFIX/deploy/thea2-dashboard-tunnel.service" /etc/systemd/system/thea2-dashboard-tunnel.service
# v9 browser: Thea1's browser code, her own instance (port 8442, own data dir, own key).
install -m 0644 "$PREFIX/deploy/thea2-browser.service" /etc/systemd/system/thea2-browser.service
npm ci --prefix "$PREFIX/deploy/browser" --no-audit --no-fund >/dev/null
install -d -m 0750 "$PREFIX/var/browser"
grep -q '^THEA2_PRESENT_KEY=' /etc/thea2/keys.env 2>/dev/null || { printf 'THEA2_PRESENT_KEY=%s
' "$(openssl rand -hex 32)" >> /etc/thea2/keys.env; chmod 600 /etc/thea2/keys.env; }
chmod 0755 "$PREFIX/deploy/tunnel-url.sh"
grep -q '^THEA2_DASHBOARD_KEY=' /etc/thea2/keys.env 2>/dev/null || { printf 'THEA2_DASHBOARD_KEY=%s
' "$(openssl rand -hex 24)" >> /etc/thea2/keys.env; chmod 600 /etc/thea2/keys.env; }
install -d -m 0750 -o thea2 -g thea2 "$PREFIX/var/run" "$PREFIX/var/house"
systemctl daemon-reload
systemctl enable thea2.service thea2-backup.timer thea2-exec.service thea2-dashboard-tunnel.service thea2-browser.service >/dev/null
systemctl restart thea2-exec.service thea2-browser.service

# v9 body: her assets, COPIED once from Thea1's install (read-only on Thea1;
# never linked, never written back): her face references + canonical look,
# and the cast's canon files. An existing copy is never overwritten.
if [ -d /opt/thea/imagine/refs ] && [ ! -d "$PREFIX/var/house/refs" ]; then
  cp -r /opt/thea/imagine/refs "$PREFIX/var/house/refs"
fi
if [ -f /opt/thea/selfie/persona.md ] && [ -d "$PREFIX/var/house/refs/thea" ] && [ ! -f "$PREFIX/var/house/refs/thea/look.md" ]; then
  sed -n '/^## What I actually look like/,/^## /p' /opt/thea/selfie/persona.md | sed '$d' > "$PREFIX/var/house/refs/thea/look.md"
fi
if [ -f /root/house/world/map.yaml ] && [ ! -f "$PREFIX/var/house/world/map.yaml" ]; then
  mkdir -p "$PREFIX/var/house/world" && cp /root/house/world/map.yaml "$PREFIX/var/house/world/map.yaml"
fi
if [ -d /opt/thea/cast ] && [ ! -d "$PREFIX/var/house/cast" ]; then
  mkdir -p "$PREFIX/var/house/cast"
  cp /opt/thea/cast/*.md "$PREFIX/var/house/cast/" 2>/dev/null || true
  rm -f "$PREFIX/var/house/cast/door_thea.md"   # the door line is sealed and out of scope for Thea2
fi
chown -R thea2:thea2 "$PREFIX/var/house"

cat <<'EOF'
>> install done. Remaining operator steps (deploy/ops.md):
   1. fill /etc/thea2/keys.env  (NEW Telegram bot token — never Thea1's)
   2. thea2.config.yaml sanity pass
   3. systemctl start thea2  — ONLY after S5★ lands and live smoke passes
   4. systemctl start thea2-backup.timer
   Thea1 keeps running until the explicit cutover decision (ops.md §5).
EOF

# v8 (2026-09-25): the v7 spine provisioning block is REMOVED. v8 runs no
# OpenCode child, and that block ran the OpenCode installer as root whenever
# the pinned 1.18.3 was not on PATH — which REPLACES the SHARED
# /root/.opencode/bin/opencode that the original Thea and every sister bot run
# (1.18.27 today). Thea2 must never touch Thea1 (feedback rule, 2026-09-25).
