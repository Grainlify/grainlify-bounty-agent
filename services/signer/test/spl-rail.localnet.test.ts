// The real payout rail against a local validator (solana-test-validator):
// builds, signs, broadcasts and confirms an SPL transfer, creating the
// recipient's token account on the way. Needs LOCALNET_RPC_URL.

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { describe, expect, it } from 'vitest';
import { setupTestUsdc } from '../../../scripts/test-usdc-setup.ts';
import { SplPayoutRail } from '../src/payout/rail.ts';

const rpc = process.env.LOCALNET_RPC_URL;

describe.skipIf(!rpc)('SplPayoutRail on a local validator', () => {
  it('pays test USDC to a brand-new wallet', { timeout: 60_000 }, async () => {
    const authority = Keypair.generate();
    const float = Keypair.generate();
    const { mint } = await setupTestUsdc(rpc!, authority, float.publicKey, { airdrop: true, floatSol: 0.5 });

    const recipient = Keypair.generate().publicKey;
    const rail = new SplPayoutRail(float.secretKey, rpc!);
    const t = await rail.prepareTransfer({ mint, decimals: 6, to: recipient.toBase58(), amountMinor: 20_000_000n });
    await t.broadcast();

    const conn = new Connection(rpc!, 'confirmed');
    const bal = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(new PublicKey(mint), recipient));
    expect(bal.value.amount).toBe('20000000');
    const tx = await conn.getTransaction(t.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    expect(tx?.meta?.err).toBeNull();
  });
});
