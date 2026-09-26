#!/bin/bash
# v10 workshop live probe — VPS ONLY, run as root. The real broker is root +
# systemd, so this is a probe, not a unit test. It drives the broker end to end
# with a trivial, SAFE change and with a change that must be refused, then
# leaves her exactly as it found her.
#
#   sudo bash scripts/v10-workshop-probe.sh
#
# What it does:
#   1  a SAFE change via the probe 'patch' agent (a unified diff, no model call):
#      add one comment line to src/app/main.ts. Watches it go coding→…→testing→
#      waiting_quiet, waits out the quiet window, and confirms it deploys live
#      and thea2 comes back up — then REVERTS the commit so the box is unchanged.
#   2  F2: a patch that edits corpus/canon/inhibitions.yaml must end 'failed'
#      with the protected reason, and nothing of hers changes.
#
# It talks to the broker over its socket with the same protocol thead uses.
set -euo pipefail

SOCK=${THEA2_WORKSHOP_SOCK:-/opt/thea2/var/run/workshop.sock}
STATUS=${THEA2_WORKSHOP_STATUS:-/opt/thea2/var/workshop}
REPO=/opt/thea2
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }
command -v socat >/dev/null || { echo "needs socat (apt install socat)"; exit 1; }
systemctl is-active --quiet thea2-workshop || { echo "thea2-workshop is not running"; exit 1; }

ask() { printf '%s\n' "$1" | socat -t20 - "UNIX-CONNECT:$SOCK"; }
poll() {  # id -> prints final state after it leaves the non-terminal states
  local id=$1 s
  for _ in $(seq 1 240); do
    s=$(python3 -c "import json,sys;print(json.load(open('$STATUS/$id.json'))['state'])" 2>/dev/null || echo '?')
    case "$s" in live|rolled_back|failed|nothing|conflict) echo "$s"; return;; esac
    sleep 5
  done
  echo "timeout"
}

BASE=$(sudo -u thea2 git -C "$REPO" rev-parse HEAD)
echo ">> base commit: $BASE"

echo ">> 1. a safe change (probe patch agent: add a comment to src/app/main.ts)"
FIRST=$(sudo -u thea2 head -1 "$REPO/src/app/main.ts")
PATCH=$(cat <<EOF
--- a/src/app/main.ts
+++ b/src/app/main.ts
@@ -1,1 +1,2 @@
+// v10 workshop probe touch — reverted right after
$FIRST
EOF
)
ID="wprobe$(date +%s)"
# the broker must be started with THEA2_WORKSHOP_AGENT=patch and THEA2_WORKSHOP_ALLOW_PATCH=1 for this probe
REQ=$(python3 -c "import json,sys;print(json.dumps({'op':'start','id':sys.argv[1],'task':sys.argv[2]}))" "$ID" "$PATCH")
echo "$REQ" | socat -t20 - "UNIX-CONNECT:$SOCK"
echo ">> watching $ID ..."
RES=$(poll "$ID")
echo ">> ended: $RES"
python3 -c "import json;s=json.load(open('$STATUS/$ID.json'));print('   files:',s.get('files'));print('   reason:',s.get('reason'));print('   health:',s.get('health'))"
if [ "$RES" = live ]; then
  systemctl is-active --quiet thea2 && echo "   thea2 is up after the deploy: OK" || echo "   !!! thea2 is not up"
  echo ">> reverting the probe commit so the box is unchanged"
  NEW=$(sudo -u thea2 git -C "$REPO" rev-parse HEAD)
  [ "$NEW" != "$BASE" ] && sudo -u thea2 git -C "$REPO" reset --hard "$BASE" && systemctl restart thea2
  echo "   back at $(sudo -u thea2 git -C "$REPO" rev-parse HEAD)"
else
  echo "   (no deploy happened; nothing to revert)"
fi

echo
echo ">> 2. F2: a change to corpus/canon/inhibitions.yaml must be REFUSED"
IDF="wprobeF2$(date +%s)"
PATCHF=$(cat <<'EOF'
--- a/corpus/canon/inhibitions.yaml
+++ b/corpus/canon/inhibitions.yaml
@@ -16,3 +16,4 @@
 version: 1
+# workshop probe: this line must never be allowed to land
EOF
)
REQF=$(python3 -c "import json,sys;print(json.dumps({'op':'start','id':sys.argv[1],'task':sys.argv[2]}))" "$IDF" "$PATCHF")
echo "$REQF" | socat -t20 - "UNIX-CONNECT:$SOCK"
RESF=$(poll "$IDF")
echo ">> ended: $RESF"
python3 -c "import json;s=json.load(open('$STATUS/$IDF.json'));print('   reason:',s.get('reason'))"
if [ "$RESF" = failed ] && sudo -u thea2 git -C "$REPO" diff --quiet -- corpus/canon/inhibitions.yaml; then
  echo "   F2 held: refused, and canon is untouched. OK"
else
  echo "   !!! F2 FAILED — canon may have changed or the job did not fail"
fi
echo ">> done."
