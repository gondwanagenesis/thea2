// M20 app — the process edge. The ONLY file that touches process/env/signals;
// everything below it stays injected and testable. `thea2 <verb>` dispatches
// here; SIGINT/SIGTERM drain the system (in-flight turn settles, scheduler
// stops) instead of killing a half-said reply.

import { pathToFileURL } from 'node:url';
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

// Self-invocation when run as the process entry (`tsx src/app/main.ts thead`).
// Guarded so test/barrel imports of this module stay inert. Case-insensitive
// compare: Windows drive letters can differ in case between argv and the
// module URL (C:\ vs c:\).
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (invokedDirectly) {
  void main(process.argv).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`fatal: ${String(e)}\n`);
      process.exit(1);
    },
  );
}
