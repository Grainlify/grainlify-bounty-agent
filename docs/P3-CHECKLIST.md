# P3 checklist: first real bounty on mainnet

P3 does not start until every box is checked and the P1 report is in.

## Blockers

- [ ] **P1 paid spike report delivered.** It must answer:
  - whether routing is honoured on x402;
  - what `PAYMENT-RESPONSE` contains;
  - whether balance drawdown works live;
  - spend against the $0.50 allocation.
- [x] **Webhook moved off the public smee.io relay** (done 19 Sept).
  - [x] The agent runs in the new Railway project `grainlify-bounty-agent`, separate from Grainlify production. The signers and mock gateway run there too, on the private network only, with no public domains.
  - [x] The App webhook URL is `https://agent-production-ba74.up.railway.app/github/webhook`.
  - [x] HMAC verification is enforced. Checked against the deployed URL, these all get 401: no signature, a garbage signature, the old smee-era secret, and a tampered body. A valid signature gets 202. GitHub's own redelivery to the new URL was accepted with 202.
  - [x] The webhook secret was rotated: a new 32-byte secret is set in the App and in the deployment, and the old one no longer verifies.
- [ ] **Payout signer switched to mainnet deliberately.**
  - `PAYOUT_NETWORK=solana-mainnet` and `PAYOUT_ALLOW_MAINNET=yes`.
  - Mainnet USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
  - A new payout float keypair (mainnet), separate from the inference wallet and from the treasury.
- [ ] **Agent gate allows `solana-mainnet`.** Mainnet is not in `allowedNetworks` today, so the gate refuses it.
- [ ] **Payout float funded by the maintainer** (about $15 USDC + 0.05 SOL). Only its public address is shared.
- [x] **Live inference uses a fresh ledger database and a fresh signer journal.** (Done. Databases and journals are now bound to mock or live on first use and refuse the other, so this can't regress by accident.) The P2 database (`agent_p2`) and `data/p2/inference-journal.sqlite` record mock payments ($0.013525 of pretend money). If they were reused, that mock spend would count against the real $5.00 budget, and mock and real receipts would sit side by side. Point `DATABASE_URL` and `SIGNER_JOURNAL_PATH` at new ones.
- [ ] **Caps unchanged:** $50 per bounty, $150/day, and manual approval for every payout.
- [ ] **Allowlist moves to Grainlify org repos** only after the webhook item above.
