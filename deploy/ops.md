# Thea2 ops — runbook

`syncedTo: spec-v1 (deploy scaffolding; completes in S8)`

One process, two systemd files, one timer. ADR-002 put the bridge, the
scheduler, and the turn pipeline inside a single `thead` process — M16's
in-process scheduler is what replaces Thea1's 97 units.

## 1. Layout

| Path | What |
|---|---|
| `/opt/thea2` | the repo (installed by `install.sh`) |
| `/opt/thea2/var` | ALL runtime state: `events/` (L0), `ledger/`, affect/memory/sched stores |
| `/opt/thea2/bin/thead` | process entry (wraps the M20 CLI) |
| `/opt/thea2/bin/backup` | backup body |
| `/etc/thea2/keys.env` | secrets, root-owned 0600, read by systemd before the privilege drop |
| `/etc/systemd/system/thea2*.service`, `thea2-backup.timer` | the whole unit footprint |
| `/var/backups/thea2` | daily `var/` snapshots + git bundles (retention in `bin/backup`) |

Secrets discipline (AGENTS rule 7): nothing secret ever lives in the repo or
the config file. The bot token and the model API key come from
`/etc/thea2/keys.env` only.

## 2. Install

```sh
sudo ./deploy/install.sh          # as root, from a clone of this repo
sudoedit /etc/thea2/keys.env      # NEW bot token + model key
```

**The bot token must be a NEW bot created with @BotFather — never Thea1's
@Demigourgosbot.** This is a standing decree, not a preference: Thea2 rides
its own identity so Thea1 stays intact until cutover.

`npm ci` installs devDependencies on purpose: the process runs under `tsx`
until a build step earns its keep. Re-deploys are `git pull && sudo
./deploy/install.sh` (rsync is `--delete`, state in `var/` survives).

## 3. First start (after S5★)

```sh
systemctl start thea2
journalctl -u thea2 -f
```

Boot order is M20's: config → kernel → L0 → stores → gate/coupling compile →
pipeline → scheduler → bridge, each stage an `app.boot` event; a failed boot
names its stage. Invalid `inhibitions.yaml`/`coupling.yaml` abort at compile —
that is loud-by-design, fix the file.

Then the **live smoke** (M20 spec, once per endpoint change): real Telegram +
real model behind an env flag, specifically watching how the backend handles
the trailing inhibition system message; flip `inhibitionPlacement: merged` in
config if it mangles it. Only after the smoke passes does the service stay up.

## 4. Operating

- **Status**: `thea2 status` (CLI verb — recent decisions, affect weather,
  sched state, last reports).
- **Reconcile**: automatic every 5 min (scheduler job); manual `thea2
  reconcile`. `LOST_REPLY` discrepancies are alarms, not log lines — silence by
  design is typed, silence by failure pages.
- **Backup check** (weekly): `systemctl list-timers thea2-backup` — the timer
  fired within ~26h, newest snapshot exists. A failed backup unit is loud.
- **Restore drill** (quarterly, dry): `git clone repo.bundle work && tar -xf
  var-*.tar.zst -C work` — if that boots under `thea2 status`, DR is real.

## 5. Cutover — supplanting Thea1 (EXPLICIT GO REQUIRED)

Thea2 runs in parallel on its own bot until Diego says the word. Nothing here
stops Thea1 automatically.

1. Thea2 verified live: golden-turn + live smoke + a few days of clean
   reconcile on the new bot.
2. On Diego's explicit go:
   ```sh
   systemctl list-units --type=service --all 'thea*'   # discover Thea1's units
   systemctl disable --now <thea1 units...>            # disable, DO NOT delete
   ```
   Units are disabled, never removed — rollback is `systemctl enable --now`,
   and Thea1's state on disk stays untouched.
3. Door content is **never migrated** (standing decree). S9 `thea2 import` may
   carry journals/threads/affect only, behind its own CLI verb, only if Diego
   opts in later.

## 6. Failure playbook

| Symptom | First move |
|---|---|
| Boot fails at a named stage | read the stage; config/compile failures are file fixes, not code fixes |
| `bridge.send_failed` events | check token/network; realizer pacing makes 429 a should-never path |
| `sched.alarm` | a job failed 3× consecutively — `journalctl -u thea2 | grep sched.fail` |
| `sched.wedged` | the job is locked out until process restart (`systemctl restart thea2`) |
| Model 5xx storm | restart is safe: ledger dedupe + at-least-once means no loss, no dupes |
