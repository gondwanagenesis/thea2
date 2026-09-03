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

# ===== BEGIN spine provisioning (P-SPINE-1 / M21, appended 2026-09-03 — v7) =====
# The pinned OpenCode spine child (ADR-001/ADR-002 amendments, D.7-2): thead
# spawns and supervises it; this block only provisions the binary and Bun.
# The pin MUST equal thea2.config.yaml `spine.version` (M.6). Upgrades are
# explicit M-items gated on the probe suite — bump both places in one change.
SPINE_VERSION="1.18.3"

spine_version_ok() {
  command -v opencode >/dev/null 2>&1 || return 1
  opencode --version 2>/dev/null | grep -q "$SPINE_VERSION"
}

if spine_version_ok; then
  echo ">> spine: opencode $SPINE_VERSION already provisioned"
else
  echo ">> spine: provisioning opencode $SPINE_VERSION (pinned)"
  # OpenCode's official installer honors VERSION= for an exact pin.
  curl -fsSL https://opencode.ai/install | VERSION="$SPINE_VERSION" bash
  spine_version_ok || { echo ">> spine: opencode $SPINE_VERSION failed to provision — fix before enabling thea2"; exit 1; }
fi

# Bun is OpenCode's runtime; custom tools/plugins (M22/M23) need it present.
if ! command -v bun >/dev/null 2>&1; then
  echo ">> spine: provisioning bun"
  curl -fsSL https://bun.sh/install | bash
fi

# Spine secrets ride keys.env like every other secret (AGENTS rule 7): the
# auth token the child requires on every request, the secret VALUES the gate
# plugin scans tool args for, and the thead endpoint it posts gate events to.
if ! grep -q '^THEA2_SPINE_TOKEN=' "$KEYS" 2>/dev/null; then
  cat >> "$KEYS" <<'EOF'
THEA2_SPINE_TOKEN=PLACEHOLDER_SPINE_TOKEN
THEA2_SPINE_SECRETS=
THEA2_SPINE_EVENT_URL=http://127.0.0.1:8087/spine/gate-events
EOF
  echo ">> spine: appended THEA2_SPINE_TOKEN to $KEYS — fill it in (openssl rand -hex 32)"
fi
# ===== END spine provisioning =====
