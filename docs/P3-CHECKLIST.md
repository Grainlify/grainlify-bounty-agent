# P3 checklist: first real bounty on mainnet

P3 does not start until every box is checked and the P1 report is in.

## Blockers

- [ ] **P1 paid spike report delivered.** It must answer:
  - whether routing is honoured on x402;
  - what `PAYMENT-RESPONSE` contains;
  - whether balance drawdown works live;
  - spend against the $0.50 allocation.
- [ ] **Webhook moved off the public smee.io relay** before the App is installed on any real repo.
  - [ ] Agent deployed to the new, separate Railway project (not Grainlify production).
  - [ ] App webhook URL points at that endpoint over HTTPS.
  - [ ] HMAC signature verification enforced (it already is in code: `verifyWebhookSignature`, and any unsigned or bad-signature delivery gets a 401). Confirm against the deployed endpoint with one bad-signature request.
  - [ ] Webhook secret rotated in the App settings and in the deployment. The current secret is used only with the sandbox relay.
- [ ] **Payout signer switched to mainnet deliberately.**
  - `PAYOUT_NETWORK=solana-mainnet` and `PAYOUT_ALLOW_MAINNET=yes`.
  - Mainnet USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
  - A new payout float keypair (mainnet), separate from the inference wallet and from the treasury.
- [ ] **Agent gate allows `solana-mainnet`.** Mainnet is not in `allowedNetworks` today, so the gate refuses it.
- [ ] **Payout float funded by the maintainer** (about $15 USDC + 0.05 SOL). Only its public address is shared.
- [ ] **Caps unchanged:** $50 per bounty, $150/day, and manual approval for every payout.
- [ ] **Allowlist moves to Grainlify org repos** only after the webhook item above.
