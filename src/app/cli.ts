// M20 app — the CLI. Pure: argv and env arrive injected (main.ts owns process).
// Verbs live or name their stage (AGENTS rule 5) — an unbuilt verb prints
// `not built yet (stage SX)` and exits nonzero, it never pretends.
//
// Read-only verbs (P-CLOSE CL.6): `doctor` opens var/ WITHOUT compose — no
// mkdir, no emit, no lock — so it is safe beside a live thead and on a broken
// install. `ack` is the one exception in the other direction: it WRITES (an
// operator abandon row) but still avoids composing, so closing a loss never
// needs the model, the corpus, or the network.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_RECONCILE_WINDOW_MS,
  emitLostReplyAlarms,
  openMessageLedger,
  reconcileLedgerRows,
  type Discrepancy,
  type LedgerRow,
} from '../bridge/index.js';
import { openJsonl, SystemClock, type Clock } from '../kernel/index.js';
import type { EventEnvelope } from '../events/index.js';
import { exportProposals } from '../consolidate/index.js';
import { loadConfig } from './config.js';
import { compose, type System } from './compose.js';
import { processIsAlive, readLock, THEAD_LOCK_PATH } from './lock.js';
import { startThead, type TheadHandle } from './thead.js';
import { corpusCheckVerb, deriveVerb } from './derive-cli.js';

export const NOT_BUILT: Record<string, string> = {
  probe: 'S8',
  import: 'S9',
};

const USAGE = `thea2 — usage:
  thea2 thead [--config thea2.config.yaml]   run the companion process
  thea2 reconcile [--config ...]             ledger reconcile + lost-reply alarms, now
  thea2 doctor                               read-only health: incidents, open losses, backup, uptime
  thea2 ack <updateId>                       record an operator abandon (reconcile stops owing it)
  thea2 status [--config ...]                boot and report live state
  thea2 derive [--config ...]                spin the corpus flywheel (real model)
  thea2 corpus:check                         hermetic derived-corpus check (no model)
  thea2 proposals:export <dir> [--config ...]  copy var/proposals out for review
  thea2 probe|import                         (not built yet — staged S8/S9)`;

export interface CliIo {
  out(s: string): void;
  err(s: string): void;
}

export const cliMain = async (
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
  onThead?: ((h: TheadHandle) => void) | undefined,
): Promise<number> => {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === '--help' || verb === '-h') {
    io.out(USAGE);
    return verb === undefined ? 1 : 0;
  }

  const configIdx = rest.indexOf('--config');
  const configPath = configIdx >= 0 ? (rest[configIdx + 1] ?? 'thea2.config.yaml') : 'thea2.config.yaml';

  const notBuilt = NOT_BUILT[verb];
  if (notBuilt !== undefined) {
    io.err(`not built yet (stage ${notBuilt})`);
    return 1;
  }

  switch (verb) {
    case 'thead': {
      const sys = await compose(loadConfig(configPath, env), 'prod');
      const handle = startThead(sys);
      io.out(`thea2 thead up — chat ${sys.cfg.bridge.allowedChatIds.join(', ')}, model ${sys.cfg.models.tiers.main}`);
      onThead?.(handle); // main.ts wires SIGINT/SIGTERM → handle.stop()
      await new Promise<void>(() => {
        /* runs until the process exits */
      });
      return 0;
    }
    case 'reconcile':
      return reconcileVerb(configPath, env, io);
    case 'doctor':
      return doctorVerb(io);
    case 'ack':
      return ackVerb(rest, configIdx, io);
    case 'status':
      return statusVerb(configPath, env, io);
    case 'derive':
      return deriveVerb(configPath, env, io);
    case 'corpus:check':
      return corpusCheckVerb(io); // hermetic: no config, no env, no model
    case 'proposals:export':
      return proposalsExportVerb(configPath, env, io, rest, configIdx);
    default:
      io.err(`unknown verb '${verb}'\n${USAGE}`);
      return 1;
  }
};

const loadCompose = async (configPath: string, env: Record<string, string | undefined>): Promise<System> =>
  compose(loadConfig(configPath, env), 'prod');

/**
 * The verb's positional argument: the first argv entry that is neither the
 * `--config` flag nor its value (`configIdx` is -1 when the flag is absent).
 * Exported for the verb's hermetic tests.
 */
export const firstPositional = (rest: readonly string[], configIdx: number): string | undefined =>
  rest.filter((a, i) => a !== '--config' && (configIdx < 0 || i !== configIdx + 1))[0];

/**
 * `thea2 proposals:export <dir>` — copies var/proposals (the consolidators'
 * runtime-state output, round 2) into `<dir>` for Diego's review. Booting the
 * system keeps the path decision in compose's hands; a missing/unreadable
 * source is a typed error the verb renders and exits nonzero on.
 */
const proposalsExportVerb = async (
  configPath: string,
  env: Record<string, string | undefined>,
  io: CliIo,
  rest: string[],
  configIdx: number,
): Promise<number> => {
  const target = firstPositional(rest, configIdx);
  if (target === undefined) {
    io.err('proposals:export requires a target directory — thea2 proposals:export <dir> [--config ...]');
    return 1;
  }
  const sys = await loadCompose(configPath, env);
  try {
    const source = path.resolve(sys.paths.base, 'var', 'proposals');
    const result = await exportProposals(source, target);
    io.out(
      result.copied.length === 0
        ? `no proposals yet — nothing to export (looked in ${source})`
        : `exported ${result.copied.length} file(s) from ${source} to ${result.targetDir}`,
    );
    return 0;
  } catch (e) {
    io.err(`proposals:export failed: ${(e as Error).message}`);
    return 1;
  } finally {
    await sys.stop();
  }
};

const reconcileVerb = async (configPath: string, env: Record<string, string | undefined>, io: CliIo): Promise<number> => {
  const sys = await loadCompose(configPath, env);
  try {
    const discrepancies = await sys.ledger.reconcile(sys.clock.epochMs());
    // The ledger rides along so the alarm ladder state advances with the emit
    // (once per updateId, then 1h/6h/24h — P-CLOSE CL.2).
    await emitLostReplyAlarms(sys.events, discrepancies, sys.ledger);
    if (discrepancies.length === 0) {
      io.out('reconcile: clean');
      return 0;
    }
    for (const d of discrepancies as Discrepancy[]) {
      if (d.kind === 'LOST_REPLY') io.out(`LOST_REPLY chat=${d.inbound.chatId} update=${d.inbound.updateId} ageMs=${d.ageMs} turn=${d.turnId ?? '-'}`);
      else io.out(`DUPLICATE_INBOUND update=${d.updateId}`);
    }
    const lost = discrepancies.filter((d) => d.kind === 'LOST_REPLY').length;
    io.out(`reconcile: ${lost} lost, ${discrepancies.length - lost} duplicate`);
    return 0;
  } finally {
    await sys.stop();
  }
};

// ---------------------------------------------------------------------------
// doctor (P-CLOSE CL.6) — read-only over var/: no compose, no mkdir, no emit,
// no lock. Safe beside a live thead; the only diagnostic that never writes.
// ---------------------------------------------------------------------------

const DOCTOR_BACKUP_DIR = '/var/backups/thea2';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const fmtDuration = (ms: number): string => {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
};

const doctorVerb = async (io: CliIo): Promise<number> => {
  io.out('thea2 doctor — read-only (var/ opened without compose; no lock, no writes)');
  if (!fs.existsSync('var')) {
    io.out('no var/ in this cwd — nothing has ever booted here');
    return 1;
  }
  const clock: Clock = new SystemClock();
  const now = clock.epochMs();

  // Uptime + incidents: a raw read of the L0 files (no EventLog open — that
  // would be a second seq-recovery beside a live thead).
  const eventsDir = path.join('var', 'events');
  let bootedAt: number | undefined;
  const incidents = new Map<string, number>();
  if (fs.existsSync(eventsDir)) {
    const events = openJsonl<EventEnvelope>(eventsDir, 'events', { rotateDailyUtc: true, clock });
    for await (const ev of events.read()) {
      if (ev.kind === 'app.boot' && (ev.payload as { stage?: string }).stage === 'bridge') bootedAt = ev.ts;
      else if (ev.kind.startsWith('incident.') && ev.ts >= now - DAY_MS) incidents.set(ev.kind, (incidents.get(ev.kind) ?? 0) + 1);
    }
  }
  const lock = readLock(THEAD_LOCK_PATH, { isAlive: processIsAlive });
  const uptime =
    bootedAt === undefined
      ? 'thead boot unknown (no app.boot{bridge} event)'
      : `thead up ${fmtDuration(now - bootedAt)}${lock.alive ? ` (pid ${lock.pid ?? '?'}, running)` : ' (no live lock)'}`;
  io.out(`uptime        ${uptime}`);

  const incidentTotal = [...incidents.values()].reduce((a, b) => a + b, 0);
  const incidentLine =
    incidentTotal === 0
      ? 'none in 24h'
      : `${incidentTotal} (${[...incidents.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ×${n}`).join(', ')})`;
  io.out(`incidents24h  ${incidentLine}`);

  // Open losses: the pure whole-history reconcile — the SAME verdict code the
  // ledger folds, over rows read without opening a writer.
  const ledgerDir = path.join('var', 'ledger');
  const rows = openJsonl<LedgerRow>(ledgerDir, 'messages', { rotateDailyUtc: true, clock });
  const losses = (await reconcileLedgerRows(rows.read(), now, DEFAULT_RECONCILE_WINDOW_MS)).filter((d) => d.kind === 'LOST_REPLY');
  if (losses.length === 0) {
    io.out('open losses   0');
  } else {
    io.out(`open losses   ${losses.length}`);
    for (const d of losses) {
      if (d.kind !== 'LOST_REPLY') continue;
      io.out(`  chat=${d.inbound.chatId} update=${d.inbound.updateId} ageMs=${d.ageMs} turn=${d.turnId ?? '-'} text=${JSON.stringify(d.inbound.text.slice(0, 60))}`);
      io.out('  close it: thea2 ack ' + d.inbound.updateId);
    }
  }

  // Last backup: the deploy layout's snapshot dir; absent on dev boxes is a
  // finding, not an error — said out loud, never guessed.
  let backupLine = `none found (${DOCTOR_BACKUP_DIR})`;
  try {
    const stamps = fs
      .readdirSync(DOCTOR_BACKUP_DIR)
      .filter((n) => n.startsWith('var-') || n.startsWith('repo-'))
      .map((n) => ({ n, m: fs.statSync(path.join(DOCTOR_BACKUP_DIR, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (stamps[0] !== undefined) backupLine = `${fmtDuration(now - stamps[0].m)} ago (${stamps[0].n})`;
  } catch {
    // dev box / no /var/backups — the "none found" line above is the answer
  }
  io.out(`last backup   ${backupLine}`);
  return 0;
};

// ---------------------------------------------------------------------------
// ack (P-CLOSE CL.2) — the operator's terminal row for a loss. Writes the
// ledger DIRECTLY (no compose): closing a loss needs no model, no corpus, no
// network — and the abandon row is what makes reconcile stop owing it.
// ---------------------------------------------------------------------------

const ackVerb = async (rest: string[], configIdx: number, io: CliIo): Promise<number> => {
  const target = firstPositional(rest, configIdx);
  const updateId = target !== undefined ? Number(target) : Number.NaN;
  if (!Number.isInteger(updateId) || updateId <= 0) {
    io.err('ack requires a numeric update id — thea2 ack <updateId>');
    return 1;
  }
  const ledger = openMessageLedger(path.resolve('var', 'ledger'), { clock: new SystemClock() });
  await ledger.abandon(updateId, 'operator');
  io.out(`acked ${updateId} — recorded as an operator abandon; reconcile no longer owes it`);
  return 0;
};

const statusVerb = async (configPath: string, env: Record<string, string | undefined>, io: CliIo): Promise<number> => {
  const sys = await loadCompose(configPath, env);
  try {
    const offset = await sys.offsets.read();
    io.out(`endpoint      ${sys.cfg.models.endpoint}`);
    io.out(`tiers         main=${sys.cfg.models.tiers.main} cheap=${sys.cfg.models.tiers.cheap} reasoning=${sys.cfg.models.tiers.reasoning ?? sys.cfg.models.tiers.main}`);
    io.out(`embedder      ${sys.cfg.embedder.kind}`);
    io.out(`corpus        ${sys.corpus.all().length} exemplars (${sys.corpus.quarantined().length} quarantined)`);
    io.out(`episodes      ${sys.episodes.size()}`);
    io.out(`procedures    ${sys.procedures.all().length}`);
    io.out(`affect        ${sys.affect.weather()}`);
    io.out(`tg offset     ${offset.committed}`);
    io.out(`sched jobs    ${sys.jobCount} (${sys.jobNames.join(', ')})`);
    return 0;
  } finally {
    await sys.stop();
  }
};
