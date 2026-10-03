// The public side of GrainHack payouts: the append-only grainhack_ledger
// (pool deposits and payouts), event 1's testnet history, and the per-event
// public view. Nothing here exposes who is held for KYC: a held winner and a
// winner with no wallet yet look the same publicly ("waiting").

import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type pg from 'pg';
import { explorerTx } from '../config.ts';
import { loadErased, shownLogin, type ErasedSet } from '../erasure-service.ts';
import type { GrainhackConfig } from './config.ts';

// --- pool deposits --------------------------------------------------------

export interface TokenBalanceChange {
  account: string;
  mint: string;
  owner: string | null;
  pre: bigint;
  post: bigint;
}

export interface DepositFacts {
  err: unknown;
  blockTime: number | null;
  changes: TokenBalanceChange[];
}

/** What a deposit check needs from the chain. Finalized only: a ledger row must not be rolled back under it. */
export interface DepositChain {
  deposit(signature: string): Promise<DepositFacts | null>;
}

export class SolanaDepositChain implements DepositChain {
  private readonly conn: Connection;
  constructor(rpcUrl: string) {
    this.conn = new Connection(rpcUrl, 'finalized');
  }
  async deposit(signature: string): Promise<DepositFacts | null> {
    const tx = await this.conn.getParsedTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) return null;
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    const by = new Map<number, TokenBalanceChange>();
    for (const [side, list] of [['pre', tx.meta.preTokenBalances ?? []], ['post', tx.meta.postTokenBalances ?? []]] as const) {
      for (const b of list) {
        const c = by.get(b.accountIndex) ?? { account: keys[b.accountIndex] ?? '', mint: b.mint, owner: b.owner ?? null, pre: 0n, post: 0n };
        c[side] = BigInt(b.uiTokenAmount.amount);
        by.set(b.accountIndex, c);
      }
    }
    return { err: tx.meta.err, blockTime: tx.blockTime ?? null, changes: [...by.values()] };
  }
}

export type FundingResult =
  | { ok: true; recorded: boolean; amountMinor: string; at: string; account: string }
  | { ok: false; error: string };

/**
 * Records a deposit to the GrainHack float as `grainhack_pool_funded`, after
 * reading the transaction from the chain: it succeeded, it moved the
 * configured mint, the account it credited is the float's associated token
 * account, and it credited exactly the amount the operator says it did.
 */
export async function recordPoolFunding(
  d: { db: pg.Pool; cfg: GrainhackConfig; chain: DepositChain },
  a: { hackathonId: string; txSignature: string; expectedAmountMinor: bigint; currency?: string; actor: string; note?: string },
): Promise<FundingResult> {
  if (!/^[0-9a-f-]{36}$/.test(a.hackathonId)) return { ok: false, error: 'hackathon id must be a uuid' };
  if (!a.actor.trim()) return { ok: false, error: '--actor is required: the ledger records who recorded the deposit' };
  const currency = a.currency ?? 'USDC';
  const m = d.cfg.mints[currency];
  if (!m) return { ok: false, error: `no GrainHack mint configured for ${currency}` };
  if (!d.cfg.floatAddress) return { ok: false, error: 'GRAINHACK_FLOAT_ADDRESS is not set: cannot tell which account a deposit must reach' };
  const facts = await d.chain.deposit(a.txSignature);
  if (!facts) return { ok: false, error: `transaction ${a.txSignature} not found at finalized commitment on ${d.cfg.network}` };
  if (facts.err) return { ok: false, error: `transaction failed on chain: ${JSON.stringify(facts.err)}` };
  const mint = new PublicKey(m.mint);
  const float = new PublicKey(d.cfg.floatAddress);
  const atas = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((p) => getAssociatedTokenAddressSync(mint, float, false, p).toBase58());
  const credit = facts.changes.find((c) => atas.includes(c.account) && c.mint === m.mint);
  if (!credit) return { ok: false, error: `the transaction did not touch the GrainHack float's ${currency} account (${atas[0]})` };
  if (credit.owner && credit.owner !== d.cfg.floatAddress) return { ok: false, error: `that account is owned by ${credit.owner}, not the float` };
  const delta = credit.post - credit.pre;
  if (delta <= 0n) return { ok: false, error: 'the transaction did not credit the float' };
  if (delta !== a.expectedAmountMinor) return { ok: false, error: `the transaction credited ${delta} minor units, not the ${a.expectedAmountMinor} you said` };
  const at = facts.blockTime ? new Date(facts.blockTime * 1000).toISOString() : new Date().toISOString();
  const name = (await d.db.query<{ hackathon_name: string }>(`SELECT hackathon_name FROM grainhack_statements WHERE hackathon_id = $1 ORDER BY imported_at DESC LIMIT 1`, [a.hackathonId])).rows[0]?.hackathon_name ?? null;
  const r = await d.db.query(
    `INSERT INTO grainhack_ledger (kind, hackathon_id, hackathon_name, network, currency, decimals, amount_minor, tx_signature, recorded_by, at, note)
     VALUES ('grainhack_pool_funded', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (network, tx_signature, kind) DO NOTHING`,
    [a.hackathonId, name, d.cfg.network, currency, m.decimals, delta.toString(), a.txSignature, a.actor, at, a.note ?? null],
  );
  return { ok: true, recorded: (r.rowCount ?? 0) > 0, amountMinor: delta.toString(), at, account: credit.account };
}

// --- event 1 history ---------------------------------------------------------

/** Event 1: "First GrainHack Event (Base Sepolia)" (public: api.grainlify.com/hackathons). */
export const EVENT1_HACKATHON_ID = 'e11e77b0-8d8d-40c5-a8dd-b525a491374b';
export const EVENT1_HACKATHON_NAME = 'First GrainHack Event (Base Sepolia)';

/**
 * Event 1's two GrainHack payouts, made through KeeperHub on Base Sepolia on
 * 19 September 2026 (IST) before this path existed. Test USDC with no value.
 * From the archived KeeperHub legs; recorded as history, never as payouts
 * made by the grainhack-signer. The GitHub user ids are public (api.github.com
 * /users/<login>) and key the rows the way every other payout row is keyed,
 * so the command needs no lookup and an erased account is masked like any other.
 */
export const EVENT1_KEEPERHUB_HISTORY = [
  { login: 'Baskarayelu', githubUserId: 198364062, amountMinor: '4000000', tx: '0xf54c1f583103af5342865909ea0c5df35d464aee340e16da82b621adebaae7b6', at: '2026-09-18T21:30:00Z' },
  { login: 'arisu6804', githubUserId: 293078336, amountMinor: '4000000', tx: '0x0b4c2ba2f74b60045145c01c7260da0393d79676350456ebc319028b1ac9221c', at: '2026-09-18T22:25:00Z' },
] as const;

export const EVENT1_HISTORY_NOTE = 'Testnet history: paid through KeeperHub on Base Sepolia before the Solana payout path existed. Test USDC with no value; pro-rata, not the published figures.';

/**
 * Idempotent: a second run records nothing. Returns how many rows it added.
 * Only for event 1: these are its legs, and recording them under any other
 * event would put a false row on a public ledger.
 */
export async function recordEvent1History(db: pg.Pool, a: { hackathonId?: string; hackathonName?: string; actor: string }): Promise<number> {
  const hackathonId = a.hackathonId ?? EVENT1_HACKATHON_ID;
  if (hackathonId !== EVENT1_HACKATHON_ID) throw new Error(`these are event 1's KeeperHub legs; event 1 is ${EVENT1_HACKATHON_ID}, not ${hackathonId}`);
  if (!a.actor.trim()) throw new Error('--actor is required');
  let added = 0;
  for (const h of EVENT1_KEEPERHUB_HISTORY) {
    const r = await db.query(
      `INSERT INTO grainhack_ledger (kind, hackathon_id, hackathon_name, network, currency, decimals, amount_minor, tx_signature, login, github_user_id, is_history, note, recorded_by, at)
       VALUES ('grainhack_payout', $1, $2, 'base-sepolia', 'USDC', 6, $3, $4, $5, $6, true, $7, $8, $9) ON CONFLICT (network, tx_signature, kind) DO NOTHING`,
      [hackathonId, a.hackathonName ?? EVENT1_HACKATHON_NAME, h.amountMinor, h.tx, h.login, h.githubUserId, EVENT1_HISTORY_NOTE, a.actor, h.at],
    );
    added += r.rowCount ?? 0;
  }
  return added;
}

// --- public views ------------------------------------------------------------

export type PublicWinnerStatus = 'waiting' | 'sending' | 'paid';

/** No KYC status in public: held, no wallet yet, and awaiting approval are all "waiting". */
export function publicStatus(s: string): PublicWinnerStatus {
  if (s === 'paid') return 'paid';
  if (s === 'submitted' || s === 'unknown') return 'sending';
  return 'waiting';
}

/** Every digit the token has, never rounded: 3.333333, not 3.33. At least two decimals. */
export function formatMinor(minor: string, decimals: number): string {
  const digits = BigInt(minor).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals) || '0';
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '').padEnd(Math.min(2, decimals), '0');
  return frac ? `${whole}.${frac}` : whole;
}

const fmt = (minor: string, decimals: number, currency: string, network: string) =>
  `${formatMinor(minor, decimals)} ${network === 'solana-mainnet' ? currency : `test ${currency}`}`;

export interface PublicGrainhackWinner {
  login: string;
  amountMinor: string;
  decimals: number;
  currency: string;
  network: string;
  amount: string;
  status: PublicWinnerStatus;
  txSignature: string | null;
  txUrl: string | null;
  paidAt: string | null;
  /** True on network !== solana-mainnet: test tokens with no value. */
  test: boolean;
  /** True on rows carried over from before this path (event 1 on Base Sepolia). */
  history: boolean;
  note: string | null;
}

interface LedgerRow {
  kind: 'grainhack_pool_funded' | 'grainhack_payout';
  hackathon_id: string;
  hackathon_name: string | null;
  network: string;
  currency: string;
  decimals: number;
  amount_minor: string;
  tx_signature: string;
  login: string | null;
  github_user_id: string | null;
  payout_id: string | null;
  is_history: boolean;
  note: string | null;
  at: Date;
}
const LEDGER_COLS = `kind, hackathon_id, hackathon_name, network, currency, decimals, amount_minor::text AS amount_minor, tx_signature, login, github_user_id::text AS github_user_id, payout_id, is_history, note, at`;

export async function publicGrainhackEvent(db: pg.Pool, hackathonId: string, decimalsFor: (currency: string) => number = () => 6) {
  if (!/^[0-9a-f-]{36}$/.test(hackathonId)) return null;
  // An account erased at its owner's request keeps its rows and loses its
  // name here, as on the rest of the public ledger (erasure-service.ts).
  const erased = await loadErased(db);
  const show = (login: string | null, id: string | null) => shownLogin(erased, login, id) ?? '';
  const st = (await db.query<{ hackathon_name: string; pool: string; currency: string; network: string; pool_minor: string; issued_at: Date }>(
    `SELECT hackathon_name, pool, currency, network, pool_minor::text AS pool_minor, issued_at FROM grainhack_statements
      WHERE hackathon_id = $1 AND pool = 'contributor' AND superseded_by IS NULL`,
    [hackathonId],
  )).rows[0];
  const rows = (await db.query<{ login: string; github_user_id: string; amount_minor: string; currency: string; network: string; status: string; tx_signature: string | null; paid_at: Date | null }>(
    `SELECT login, github_user_id::text AS github_user_id, amount_minor::text AS amount_minor, currency, network, status, tx_signature, paid_at FROM grainhack_payouts
      WHERE hackathon_id = $1 AND pool = 'contributor' AND status <> 'removed' ORDER BY lower(login)`,
    [hackathonId],
  )).rows;
  const ledger = (await db.query<LedgerRow>(`SELECT ${LEDGER_COLS} FROM grainhack_ledger WHERE hackathon_id = $1 ORDER BY at`, [hackathonId])).rows;
  if (!st && !rows.length && !ledger.length) return null;

  const winners: PublicGrainhackWinner[] = rows.map((r) => {
    const decimals = decimalsFor(r.currency);
    const status = publicStatus(r.status);
    const tx = status === 'paid' ? r.tx_signature : null;
    return {
      login: show(r.login, r.github_user_id), amountMinor: r.amount_minor, decimals, currency: r.currency, network: r.network, amount: fmt(r.amount_minor, decimals, r.currency, r.network), status,
      txSignature: tx, txUrl: tx ? explorerTx(r.network, tx) : null, paidAt: status === 'paid' && r.paid_at ? new Date(r.paid_at).toISOString() : null,
      test: r.network !== 'solana-mainnet', history: false, note: null,
    };
  });
  const history: PublicGrainhackWinner[] = ledger
    .filter((l) => l.kind === 'grainhack_payout' && l.is_history)
    .map((l) => ({
      login: show(l.login, l.github_user_id), amountMinor: l.amount_minor, decimals: l.decimals, currency: l.currency, network: l.network, amount: fmt(l.amount_minor, l.decimals, l.currency, l.network),
      status: 'paid', txSignature: l.tx_signature, txUrl: explorerTx(l.network, l.tx_signature), paidAt: new Date(l.at).toISOString(),
      test: l.network !== 'solana-mainnet', history: true, note: l.note,
    }));
  const funding = ledger
    .filter((l) => l.kind === 'grainhack_pool_funded')
    .map((l) => ({ amountMinor: l.amount_minor, decimals: l.decimals, currency: l.currency, network: l.network, amount: fmt(l.amount_minor, l.decimals, l.currency, l.network),
      txSignature: l.tx_signature, txUrl: explorerTx(l.network, l.tx_signature), at: new Date(l.at).toISOString(), test: l.network !== 'solana-mainnet' }));
  const sum = (list: { amountMinor: string }[]) => list.reduce((a, x) => a + BigInt(x.amountMinor), 0n).toString();
  const network = st?.network ?? rows[0]?.network ?? ledger[0]?.network ?? null;
  return {
    hackathonId,
    hackathonName: st?.hackathon_name ?? ledger.find((l) => l.hackathon_name)?.hackathon_name ?? null,
    pool: 'contributor',
    network,
    test: network !== 'solana-mainnet',
    currency: st?.currency ?? rows[0]?.currency ?? ledger[0]?.currency ?? null,
    statement: st ? { issuedAt: new Date(st.issued_at).toISOString(), poolMinor: st.pool_minor } : null,
    winners,
    history,
    funding,
    totals: {
      poolMinor: st?.pool_minor ?? null,
      paidMinor: sum(winners.filter((w) => w.status === 'paid')),
      waitingMinor: sum(winners.filter((w) => w.status !== 'paid')),
      paidCount: winners.filter((w) => w.status === 'paid').length,
      waitingCount: winners.filter((w) => w.status !== 'paid').length,
      fundedMinor: sum(funding),
      historyPaidMinor: sum(history),
    },
  };
}

/** Every GrainHack ledger row, newest first, for the public ledger. */
export async function grainhackLedgerRows(db: pg.Pool, limit = 300): Promise<LedgerRow[]> {
  return (await db.query<LedgerRow>(`SELECT ${LEDGER_COLS} FROM grainhack_ledger ORDER BY at DESC, id DESC LIMIT $1`, [limit])).rows;
}

/** One ledger row as a public ledger event. `erased` masks an erased account's login, as everywhere else on the ledger. */
export function grainhackLedgerEvent(l: LedgerRow, erased?: ErasedSet) {
  const name = l.hackathon_name ?? 'event';
  const login = erased ? shownLogin(erased, l.login, l.github_user_id) : l.login;
  const detail = l.kind === 'grainhack_pool_funded'
    ? `GrainHack ${name} pool funded`
    : `GrainHack ${name} → ${login ?? 'winner'}${l.is_history ? ' (testnet history, KeeperHub on Base Sepolia)' : ''}`;
  return {
    at: new Date(l.at).toISOString(),
    kind: l.kind,
    bountyId: null,
    hackathonId: l.hackathon_id,
    test: l.network !== 'solana-mainnet',
    history: l.is_history,
    detail,
    amount: fmt(l.amount_minor, l.decimals, l.currency, l.network),
    proof: { label: `${l.tx_signature.slice(0, 5)}…${l.tx_signature.slice(-4)}`, url: explorerTx(l.network, l.tx_signature) },
  };
}
