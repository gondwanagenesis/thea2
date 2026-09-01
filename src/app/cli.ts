// M20 app — the CLI. Pure: argv and env arrive injected (main.ts owns process).
// Verbs live or name their stage (AGENTS rule 5) — an unbuilt verb prints
// `not built yet (stage SX)` and exits nonzero, it never pretends.

import { emitLostReplyAlarms, type Discrepancy } from '../bridge/index.js';
import { loadConfig } from './config.js';
import { compose, type System } from './compose.js';
import { startThead, type TheadHandle } from './thead.js';

export const NOT_BUILT: Record<string, string> = {
  derive: 'S7',
  'corpus:check': 'S7',
  probe: 'S8',
  import: 'S9',
};

const USAGE = `thea2 — usage:
  thea2 thead [--config thea2.config.yaml]   run the companion process
  thea2 reconcile [--config ...]             ledger reconcile + lost-reply alarms, now
  thea2 status [--config ...]                boot and report live state
  thea2 derive|corpus:check|probe|import     (not built yet — staged S7/S8/S9)`;

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
    case 'status':
      return statusVerb(configPath, env, io);
    default:
      io.err(`unknown verb '${verb}'\n${USAGE}`);
      return 1;
  }
};

const loadCompose = async (configPath: string, env: Record<string, string | undefined>): Promise<System> =>
  compose(loadConfig(configPath, env), 'prod');

const reconcileVerb = async (configPath: string, env: Record<string, string | undefined>, io: CliIo): Promise<number> => {
  const sys = await loadCompose(configPath, env);
  try {
    const discrepancies = await sys.ledger.reconcile(sys.clock.epochMs());
    await emitLostReplyAlarms(sys.events, discrepancies);
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
    io.out(`sched jobs    0 (S5 — life/siblings land at S6/S8)`);
    return 0;
  } finally {
    await sys.stop();
  }
};
