// `pnpm approve-event <hackathon_id>`: a person approves an event's GrainHack
// payouts, one winner at a time, on their own machine.
//
// It shows the whole table and the totals first. Then, for each row awaiting
// approval, it shows exactly what will be signed and asks for the amount to be
// typed; only then does it sign, with the approver key that never leaves this
// machine, and post that one approval to the agent, which checks it against
// its records and forwards it to the grainhack-signer. One signature per row;
// there is no "approve all".
//
// It does not take the agent's word for the amounts: the statement the agent
// serves must verify against the backend's results key here, and every set of
// terms must match a payable line of that statement.

import { signGrainhackApproval, type GrainhackTerms } from '../../../../packages/gate/src/grainhack-approval.ts';
import { publicKeyOf } from '../../../../packages/gate/src/ed25519.ts';
import { lineFor, statementSha256, verifyStatement } from '../../../../packages/gate/src/grainhack-statement.ts';
import { formatAmount } from '../config.ts';

interface ViewRow {
  payoutId: string;
  githubUserId: number;
  login: string;
  amountMinor: string;
  currency: string;
  network: string;
  status: string;
  recipient: string | null;
  walletChanged: boolean;
  txUrl: string | null;
  lastError: string | null;
  terms: GrainhackTerms | null;
}
interface View {
  hackathonId: string;
  network: string;
  statement: { statementId: string; hackathonName: string; poolMinor: string; currency: string; network: string; statement: string; signature: string } | null;
  rows: ViewRow[];
  totals: Record<string, string | null>;
}

export interface ApproveEventDeps {
  agentUrl: string;
  /** PAYOUTS_API_TOKEN: the GrainHack routes are not public. */
  token: string;
  approverSecret: Uint8Array;
  resultsPubkey: string;
  ask: (question: string) => Promise<string>;
  log: (line: string) => void;
  f?: typeof fetch;
  now?: () => Date;
  decimals?: (currency: string) => number;
}

export async function approveEvent(hackathonId: string, d: ApproveEventDeps): Promise<{ paid: number; skipped: number; failed: number }> {
  const f = d.f ?? fetch;
  const base = d.agentUrl.replace(/\/+$/, '');
  const auth = { authorization: `Bearer ${d.token}` };
  const dec = d.decimals ?? (() => 6);
  const amount = (minor: string, currency: string) => formatAmount(BigInt(minor), dec(currency), currency);
  if (!/^[0-9a-f-]{36}$/.test(hackathonId)) throw new Error('hackathon id must be a uuid');

  // Bring rows up to date first: payments the signer confirmed, wallets linked since.
  const refreshed = await f(`${base}/api/grainhack/events/${hackathonId}/refresh`, { method: 'POST', headers: auth }).catch(() => null);
  if (!refreshed?.ok) d.log(`(could not refresh: ${refreshed ? refreshed.status : 'agent unreachable'}; showing what the agent has)`);
  const r = await f(`${base}/api/grainhack/events/${hackathonId}`, { headers: auth });
  if (!r.ok) throw new Error(`agent: ${r.status} ${await r.text()}`);
  const v = (await r.json()) as View;
  if (!v.statement) throw new Error('no results statement has been imported for this event (pnpm cli grainhack import <statement_id>)');

  const checked = verifyStatement(v.statement.statement, v.statement.signature, d.resultsPubkey);
  if (!checked.ok) throw new Error(`the statement the agent served does not verify against GRAINHACK_RESULTS_PUBKEY (${checked.reason}); nothing signed`);
  const st = checked.statement;
  const sha = statementSha256(v.statement.statement);

  d.log(`\n${st.hackathon_name}  (${st.network}, ${st.pool} pool, statement ${st.statement_id})`);
  d.log(`pool ${amount(st.pool_minor, st.currency)}\n`);
  d.log(`${'login'.padEnd(24)} ${'github id'.padStart(10)} ${'amount'.padStart(16)}  ${'status'.padEnd(18)} recipient / transaction`);
  for (const row of v.rows) {
    d.log(`${row.login.padEnd(24)} ${String(row.githubUserId).padStart(10)} ${amount(row.amountMinor, row.currency).padStart(16)}  ${row.status.padEnd(18)} ${row.txUrl ?? row.recipient ?? ''}${row.walletChanged ? '  WALLET CHANGED' : ''}`);
    if (row.lastError && row.status !== 'paid') d.log(`${''.padEnd(24)} last error: ${row.lastError}`);
  }
  const t = v.totals;
  const cur = st.currency;
  d.log(`\npaid ${amount(t.paidMinor ?? '0', cur)} · awaiting approval ${amount(t.awaitingApprovalMinor ?? '0', cur)} · held ${amount(t.heldMinor ?? '0', cur)} · awaiting wallet ${amount(t.awaitingWalletMinor ?? '0', cur)} · in flight ${amount(t.inFlightMinor ?? '0', cur)}`);

  const pending = v.rows.filter((row) => row.status === 'awaiting_approval');
  if (!pending.length) {
    d.log('\nNothing is awaiting approval.');
    return { paid: 0, skipped: 0, failed: 0 };
  }
  d.log(`\n${pending.length} payout(s) awaiting approval. Each one is signed separately.`);

  const out = { paid: 0, skipped: 0, failed: 0 };
  for (const row of pending) {
    const terms = row.terms;
    // Everything signed must come from the verified statement, not from the agent.
    const line = terms ? lineFor(st, terms.github_user_id) : undefined;
    const problem = !terms ? 'the agent sent no terms'
      : row.walletChanged ? 'the winner\'s live wallet link changed since this row was frozen (grainhack refreeze)'
      : terms.statement_id !== st.statement_id || terms.statement_sha256 !== sha ? 'the terms are for a different statement than the one shown'
      : terms.hackathon_id !== st.hackathon_id || terms.pool !== st.pool || terms.network !== st.network || terms.currency !== st.currency ? 'the terms are for another event, network or currency'
      : !line || line.status !== 'payable' ? 'the statement does not list this winner as payable'
      : line.amount_minor !== terms.amount_minor || line.login !== terms.login ? 'the amount or login differs from the statement'
      : terms.payout_id !== row.payoutId ? 'the terms are for another payout'
      : null;
    if (problem || !terms) {
      d.log(`\nSKIPPED ${row.login}: ${problem}. Nothing signed.`);
      out.skipped++;
      continue;
    }
    const shown = amount(terms.amount_minor, terms.currency);
    d.log(`\nPay ${terms.login} (GitHub id ${terms.github_user_id})`);
    d.log(`  ${shown} on ${terms.network} (mint ${terms.mint})`);
    d.log(`  to ${terms.recipient}`);
    d.log(`  ${st.hackathon_name}, ${terms.pool} pool; statement ${terms.statement_id}; payout ${terms.payout_id}`);
    const answer = (await d.ask(`Type the amount (${shown}) exactly to approve, "s" to skip, "q" to stop: `)).trim();
    if (answer === 'q') {
      d.log('Stopped. Nothing more was signed.');
      break;
    }
    if (answer !== shown) {
      d.log('Skipped. Nothing was signed for this winner.');
      out.skipped++;
      continue;
    }
    const approval = signGrainhackApproval(terms, d.approverSecret, publicKeyOf(d.approverSecret), d.now ? d.now() : new Date());
    const res = await f(`${base}/api/grainhack/payouts/${row.payoutId}/approve`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ approval }),
    }).catch((e: unknown) => ({ ok: false, status: 0, text: async () => String(e) }) as unknown as Response);
    const body = await res.text();
    if (res.ok) {
      const j = JSON.parse(body) as { signature: string; txUrl: string };
      d.log(`Paid: ${j.txUrl}`);
      out.paid++;
    } else {
      d.log(`NOT PAID (${res.status}): ${body}`);
      out.failed++;
    }
  }
  d.log(`\n${out.paid} paid, ${out.skipped} skipped, ${out.failed} not paid.`);
  return out;
}
