// The grainhack-signer accepts the backend's golden statements (copied in
// packages/gate/test/testdata) under the backend's test key: it pays an
// approved payable line of each and refuses a held one. The verifier half is
// packages/gate/test/grainhack-golden.test.ts.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { signGrainhackApproval, type GrainhackTerms } from '../../../packages/gate/src/grainhack-approval.ts';
import type { ResultsStatement } from '../../../packages/gate/src/grainhack-statement.ts';
import { golden } from '../../../packages/gate/test/grainhack-golden.ts';
import { GrainhackSigner } from '../src/grainhack/grainhack-signer.ts';
import { GrainhackJournal } from '../src/grainhack/journal.ts';
import type { PayoutRail } from '../src/payout/rail.ts';

const approver = Keypair.generate();
const MINT = Keypair.generate().publicKey.toBase58();
const FLOAT = Keypair.generate().publicKey.toBase58();
let n = 0;

class FakeRail implements PayoutRail {
  sent: bigint[] = [];
  address() {
    return FLOAT;
  }
  async prepareTransfer(a: { amountMinor: bigint }) {
    return { signature: `golden-tx-${++n}`, lastValidBlockHeight: 1, broadcast: async () => void this.sent.push(a.amountMinor) };
  }
}

describe('grainhack-signer on the backend golden statements', () => {
  for (const v of golden.vectors) {
    it(`${v.name}: pays an approved payable line, refuses a held one`, async () => {
      const s = JSON.parse(v.statement) as ResultsStatement;
      const now = new Date('2026-10-03T12:30:00Z');
      const rail = new FakeRail();
      const signer = new GrainhackSigner(
        { network: s.network, mints: { USDC: { mint: MINT, decimals: 6 } }, caps: {}, trustedApprovers: [approver.publicKey.toBase58()], resultsPubkey: golden.public_key_b64 },
        new GrainhackJournal(join(mkdtempSync(join(tmpdir(), 'ghg-')), 'j.sqlite')),
        rail,
        () => now,
      );
      const terms = (line: ResultsStatement['lines'][number]): GrainhackTerms => ({
        payout_id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, statement_id: s.statement_id, statement_sha256: v.statement_sha256,
        hackathon_id: s.hackathon_id, pool: s.pool, github_user_id: line.github_user_id, login: line.login, recipient: Keypair.generate().publicKey.toBase58(),
        amount_minor: line.amount_minor, currency: s.currency, mint: MINT, network: s.network,
      });
      const pay = (line: ResultsStatement['lines'][number]) =>
        signer.pay({ approval: signGrainhackApproval(terms(line), approver.secretKey, approver.publicKey.toBase58(), now), statement: v.statement, statement_signature: v.signature_b64 });

      for (const line of s.lines) {
        const r = await pay(line);
        if (line.status === 'payable') expect(r, line.login).toMatchObject({ ok: true, payer: FLOAT });
        else expect(r, line.login).toMatchObject({ ok: false, error: expect.stringMatching(/held_kyc on this statement, not payable/) });
      }
      expect(rail.sent).toEqual(s.lines.filter((l) => l.status === 'payable').map((l) => BigInt(l.amount_minor)));
    });
  }
});
