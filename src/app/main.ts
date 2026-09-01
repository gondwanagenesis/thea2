// M20 app — the process edge. The ONLY file that touches process/env/signals;
// everything below it stays injected and testable. `thea2 <verb>` dispatches
// here; SIGINT/SIGTERM drain the system (in-flight turn settles, scheduler
// stops) instead of killing a half-said reply.

import { cliMain } from './cli.js';

/** @internal — process entry, not for tests. */
export const main = async (argv: string[]): Promise<number> => {
  let stop: (() => Promise<void>) | undefined;
  const shutdown = (sig: string): void => {
    process.stderr.write(`\n${sig} — draining...\n`);
    void (stop ?? (() => Promise.resolve()))().then(
      () => process.exit(0),
      (e) => {
        process.stderr.write(`shutdown error: ${String(e)}\n`);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return cliMain(
    argv.slice(2),
    { ...process.env },
    { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') },
    (handle) => {
      stop = () => handle.stop();
    },
  );
};
