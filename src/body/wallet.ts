// v9 body — her wallet (Thea1's two purses, re-done). HERS is her monthly
// allowance for things SHE chose to make; HOUSE is everything Diego asked for
// and the cost of her being alive. When in doubt it is HOUSE: billing herself
// for existing is the worse failure. The ledger is an append-only jsonl in her
// house; balances are folded from it, never kept as a number she could edit.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Clock } from '../kernel/index.js';
import type { House } from './house.js';

export type Purse = 'hers' | 'house';

export interface WalletRow {
  at: number;
  purse: Purse;
  usd: number;
  what: string;
}

export interface Wallet {
  status(): { month: string; hersSpent: number; hersLeft: number; houseSpent: number; monthUsd: number };
  /** Can she spend this from her purse? House spending is never refused here. */
  canSpend(usd: number, purse: Purse): boolean;
  record(usd: number, purse: Purse, what: string): void;
}

/** Estimated prices (fal does not return cost). Conservative; per image / per clip. */
export const PRICES = {
  image: 0.05,
  video: 0.45,
} as const;

export const makeWallet = (house: House, clock: Clock, monthUsd: number): Wallet => {
  const file = path.join(house.root, 'wallet.jsonl');
  const monthOf = (t: number): string => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', timeZone: 'UTC' }).format(t);
  const rows = (): WalletRow[] => {
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as WalletRow];
        } catch {
          return [];
        }
      });
  };
  const status = (): ReturnType<Wallet['status']> => {
    const month = monthOf(clock.epochMs());
    const mine = rows().filter((r) => monthOf(r.at) === month);
    const hersSpent = mine.filter((r) => r.purse === 'hers').reduce((a, r) => a + r.usd, 0);
    const houseSpent = mine.filter((r) => r.purse === 'house').reduce((a, r) => a + r.usd, 0);
    return { month, hersSpent, hersLeft: Math.max(0, monthUsd - hersSpent), houseSpent, monthUsd };
  };
  return {
    status,
    canSpend: (usd, purse) => purse === 'house' || status().hersLeft >= usd,
    record: (usd, purse, what) => {
      fs.appendFileSync(file, `${JSON.stringify({ at: clock.epochMs(), purse, usd: Math.round(usd * 10000) / 10000, what: what.slice(0, 200) })}\n`);
    },
  };
};
