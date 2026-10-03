// Resolving a GrainHack payout the signer could not confirm. Used by a person,
// never automatically: an `unknown` outcome is not retried by anything.
//
//   pnpm grainhack-resolve list
//   pnpm grainhack-resolve <payout_id> --actor <name> --reason <text>
//
// It reads the chain and decides from what it finds, never from the person's
// say-so: confirmed if the transaction landed without error; failed_unsent if
// it landed with an error (no tokens moved) or if its blockhash has expired
// without it landing (it never can now). Anything else - not yet visible but
// still able to land - is left as it is, and it says to wait. The decision is
// recorded with who ran it, why, and the chain evidence.
//
// Runs where the journal is (the grainhack-signer service's volume). Needs
// GRAINHACK_JOURNAL_PATH and GRAINHACK_PAYOUT_RPC_URL; it never needs the key.

import { Connection } from '@solana/web3.js';
import type { GrainhackJournal, GrainhackJournalRow } from './journal.ts';

export type ChainStatus =
  | { found: false; finalizedBlockHeight: number }
  | { found: true; err: unknown; confirmationStatus: string | null; slot: number };

export interface ResolveChain {
  status(signature: string): Promise<ChainStatus>;
}

export class SolanaResolveChain implements ResolveChain {
  private readonly conn: Connection;
  constructor(rpcUrl: string) {
    this.conn = new Connection(rpcUrl, 'confirmed');
  }
  async status(signature: string): Promise<ChainStatus> {
    const s = (await this.conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (!s) return { found: false, finalizedBlockHeight: await this.conn.getBlockHeight('finalized') };
    return { found: true, err: s.err, confirmationStatus: s.confirmationStatus ?? null, slot: s.slot };
  }
}

export type Decision = { to: 'confirmed' | 'failed_unsent'; why: string } | { to: null; why: string };

export function decide(row: Pick<GrainhackJournalRow, 'status' | 'last_valid_block_height'>, chain: ChainStatus): Decision {
  if (row.status === 'confirmed' || row.status === 'failed_unsent') return { to: null, why: `already ${row.status}` };
  if (chain.found) {
    if (chain.confirmationStatus !== 'confirmed' && chain.confirmationStatus !== 'finalized') return { to: null, why: `seen at ${chain.confirmationStatus ?? 'unknown'} commitment only; wait and run again` };
    if (chain.err === null || chain.err === undefined) return { to: 'confirmed', why: `landed without error in slot ${chain.slot} (${chain.confirmationStatus})` };
    return { to: 'failed_unsent', why: `landed with error ${JSON.stringify(chain.err)} in slot ${chain.slot}; no tokens moved` };
  }
  if (row.last_valid_block_height === null) return { to: null, why: 'not on chain, and the journal has no last valid block height to prove it never can be; decide by hand outside this tool' };
  if (chain.finalizedBlockHeight > row.last_valid_block_height) {
    return { to: 'failed_unsent', why: `not on chain and its blockhash expired (finalized height ${chain.finalizedBlockHeight} > last valid ${row.last_valid_block_height}); it can never land` };
  }
  return { to: null, why: `not on chain yet but could still land until block height ${row.last_valid_block_height} (now ${chain.finalizedBlockHeight}); wait and run again` };
}

export async function resolvePayout(journal: GrainhackJournal, chain: ResolveChain, payoutId: string, actor: string, reason: string) {
  if (!actor.trim() || !reason.trim()) throw new Error('--actor and --reason are required: the journal records who resolved it and why');
  const row = journal.byPayoutId(payoutId);
  if (!row) throw new Error(`no journal row for payout ${payoutId}`);
  const status = await chain.status(row.tx_signature);
  const d = decide(row, status);
  if (!d.to) return { resolved: false as const, row, why: d.why };
  const after = journal.resolve(payoutId, d.to, actor, reason, { chain: status, decision: d.why, at: new Date().toISOString() });
  return { resolved: true as const, row: after, why: d.why };
}

export async function main() {
  const { GrainhackJournal } = await import('./journal.ts');
  const [cmd, ...rest] = process.argv.slice(2);
  const journalPath = process.env.GRAINHACK_JOURNAL_PATH?.trim() || 'data/grainhack-journal.sqlite';
  const journal = new GrainhackJournal(journalPath);
  try {
    if (cmd === 'list') {
      const open = journal.all().filter((r) => r.status !== 'confirmed' && r.status !== 'failed_unsent');
      if (!open.length) console.log('nothing to resolve');
      for (const r of open) console.log(`${r.payout_id}  ${r.status}  ${r.login} (${r.github_user_id})  ${r.amount_minor} ${r.currency} on ${r.network}  tx ${r.tx_signature}  ${r.error ?? ''}`);
      return;
    }
    const flag = (name: string) => {
      const i = rest.indexOf(`--${name}`);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const rpc = process.env.GRAINHACK_PAYOUT_RPC_URL?.trim();
    if (!cmd || !rpc) {
      console.error('usage: grainhack-resolve list | <payout_id> --actor <name> --reason <text>   (needs GRAINHACK_PAYOUT_RPC_URL)');
      process.exitCode = 2;
      return;
    }
    const r = await resolvePayout(journal, new SolanaResolveChain(rpc), cmd, flag('actor') ?? '', flag('reason') ?? '');
    console.log(r.resolved ? `resolved ${cmd}: ${r.row.status} - ${r.why}` : `not resolved: ${r.why}`);
    if (!r.resolved) process.exitCode = 1;
  } finally {
    journal.close();
  }
}
