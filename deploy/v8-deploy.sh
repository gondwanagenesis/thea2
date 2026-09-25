#!/bin/bash
# Thea2 v8 deploy (run as root on the VPS). Stages the v8 commit from a git
# bundle, installs to /opt/thea2, archives the v7 runtime state (never deletes
# it), forks Thea1's memories READ-ONLY into a fresh var/mind, and leaves the
# service STOPPED — starting it is a separate, deliberate step.
#
#   bash deploy/v8-deploy.sh /root/thea2-v8.bundle
#
# Thea1 is never written: the importer only reads /opt/holobionte + /root/house,
# and thea2.service runs sandboxed (ProtectHome, ProtectSystem=strict,
# ReadWritePaths=/opt/thea2/var).
set -euo pipefail

BUNDLE="${1:?usage: v8-deploy.sh <bundle>}"
STAGING=/root/thea2-staging
PREFIX=/opt/thea2
TS=$(date -u +%Y%m%dT%H%M%SZ)

echo ">> stage: v8 from $BUNDLE"
cd "$STAGING"
git fetch "$BUNDLE" v8:refs/remotes/bundle/v8 --force
git checkout -B v8 refs/remotes/bundle/v8
git reset --hard refs/remotes/bundle/v8
git log --oneline -1

echo ">> stop thea2 (it should already be stopped)"
systemctl stop thea2 2>/dev/null || true

if [ -d "$PREFIX/var" ] && [ ! -f "$PREFIX/var/mind/fork.json" ]; then
  echo ">> archive v7 runtime state → $PREFIX/var.v7-archive-$TS (kept, never deleted)"
  mv "$PREFIX/var" "$PREFIX/var.v7-archive-$TS"
fi

echo ">> install"
sh "$STAGING/deploy/install.sh"

if [ ! -f "$PREFIX/var/mind/fork.json" ]; then
  echo ">> fork: import Thea1's memories (read-only on Thea1)"
  cd "$PREFIX"
  set -a; . /etc/thea2/keys.env; set +a
  ./node_modules/.bin/tsx scripts/import-thea1.ts --config thea2.config.yaml --out "$PREFIX/var/mind" --affect-out "$PREFIX/var/affect/state.json"
  chown -R thea2:thea2 "$PREFIX/var"
else
  echo ">> fork already present ($(cat "$PREFIX/var/mind/fork.json" | head -c 200)) — not re-forking"
fi

echo ">> done. service left stopped. next: probe, then systemctl start thea2"
