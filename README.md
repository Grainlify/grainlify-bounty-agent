# Grainlify bounty agent

Grainlify's bounty agent funds open-source work. Creator fees from the project's token (GRAIN, launched on ClawPump) flow into a treasury. The agent picks GitHub issues worth funding, prices them, posts bounties, and reviews the pull requests. When a maintainer merges, the contributor is paid on Solana.

Every reasoning step the agent takes is inference bought from [UsePod](https://usepod.ai), paid per request over **x402** from the agent's own wallet. Each call leaves a receipt linked to the bounty it served.

This is an entry for the AnsemHack Clawrena (Inference Markets and ClawPump × pump.fun tracks).

## Status

| Piece | State |
|---|---|
| UsePod x402 client (`packages/x402`) | Built and tested against the mock. Supports on-chain payment and surplus-credit drawdown. |
| Local x402 mock gateway (`packages/mock-gateway`) | Built from recorded live 402 captures and probed error strings. |
| Inference budget governor (`packages/budget`) | $5.00 lifetime ceiling, per-phase allocations, and atomic reservations. |
| Signer service (`services/signer`) | Separate process with its own spend journal and ceiling. It can only pay allowlisted UsePod quotes. |
| Receipts and spend ledger (`packages/db`) | Postgres. |
| Public ledger metrics | Served-call counts by scheme, inference and network-fee totals, cost per served call and per merged PR (`null` when the denominator is 0). |
| Payout gate (`packages/gate`) | A deterministic function with 13 checks that fails closed. No model output is an input. |
| Wallet linking | A signed `/grainlify link …` comment. GitHub proves the account and the signature proves the wallet. |
| Human approval | Ed25519-signed by an approver key that never reaches the agent. It commits to recipient, amount, mint, network and bounty. |
| Payout signer (`services/signer/src/payout`) | Separate key and journal. Pays only with a valid approval, and re-checks the merge on GitHub, its own repo allowlist, the $50/bounty and $150/day hard caps, and "paid once". |
| Agent (`apps/agent`) | GitHub App webhooks (HMAC checked, delivery-deduped), bounty pricing and PR review over x402, gate on merge, approve CLI. |

## Public ledger

The public ledger endpoint returns each receipt plus a `metrics` object:

| Field | Meaning |
|---|---|
| `servedCalls.onChain` / `surplusCredit` / `total` | Counts of served inference calls by x402 scheme. Always numbers; `0` when empty. |
| `inferenceTotal` | Sum of inference cost for served calls. `0` when empty. |
| `networkFeeTotal` | Sum of Solana network fees for served calls. `0` when empty. |
| `costPerServedCall` | Mean of inference + network fee per served call, or `null` if none have been served. |
| `costPerMergedPr` | Those same totals divided by merged PRs, or `null` if none have merged yet. |

Attach it from the handler with `metrics: buildLedgerMetrics({ servedCalls, mergedPrCount })` (`apps/agent/src/ledger-metrics.ts`). Ratios use `null` when the denominator is 0 so an empty ledger is not reported as free.

## Money safety

- **Model output never authorizes a payment.**
  - Payouts will be gated by deterministic checks (P2): allowlisted repo, merged by a maintainer who is not the author, a linked wallet, and caps.
  - During the hackathon every payout also needs manual approval.
- **Keys never enter the agent.**
  - Only the signer process reads a keypair file, and that file lives outside this repo.
  - The signer has no general "transfer" endpoint. It pays a UsePod quote only when:
    - the destination is on the allowlist;
    - the network is Solana mainnet and the asset is USDC;
    - the amount is under a per-call maximum.
- **Inference spend is capped at $5.00 for the lifetime of the project,** including Solana network fees and any deposit.
  - The agent's governor reserves budget before every payment.
  - The signer keeps its own journal and refuses independently once the ceiling is reached.
  - Neither ceiling can be raised by configuration; it can only be lowered.
- **Issue, PR and comment text is untrusted input.**
- No secrets live in this repo. `.gitignore` covers keyfiles and env files, and GitHub secret scanning with push protection is on.

## x402 on UsePod: what we learned

These findings come from live probes; the full catalogue is in [fixtures/usepod/x402-errors.json](fixtures/usepod/x402-errors.json).

**The flow.** An unpaid request returns `402` with a base64 JSON quote in `PAYMENT-REQUIRED`. The quote is bound to `sha256("POST\n<path>\n<body>")`. You pay USDC to `pay_to` on Solana, then retry the byte-identical request with `PAYMENT-SIGNATURE`.

**Surplus credit.** The quote is a cap. The unused part is credited to the payer wallet, and a later call can spend that credit with no on-chain transaction:

```json
{ "quote_id": "…", "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "asset": "USDC",
  "payer_wallet": "<pubkey>", "scheme": "balance",
  "proof": "<ed25519 signature of 'usepod-x402-spend:<quote_id>'>" }
```

The gateway's own error message says `payload.proof`, but it reads the **top-level** `proof` field.

**Constraints:**
- `max_tokens` is required.
- Streaming is rejected.
- Mainnet only; there is no devnet.

## Development

```bash
pnpm install
docker compose up -d postgres
TEST_DATABASE_URL=postgres://agent:agent-local-only@127.0.0.1:55432/agent pnpm test
pnpm typecheck

# Run everything locally at $0:
pnpm mock                                   # mock UsePod gateway on :8402
SIGNER_RAIL=mock SIGNER_TOKEN=… pnpm signer # signer on :8787
DATABASE_URL=… SIGNER_TOKEN=… pnpm spike baseline overpay routing
DATABASE_URL=… pnpm ledger                  # spend vs allocation
```

`pnpm spike` refuses to call the real gateway unless `SPIKE_CONFIRM=spend-real-money` is set.

## Running the P2 loop on devnet

P2 pays **devnet test USDC only**. That is a mint we created, with no value. All inference goes to the local mock gateway. Keys live in `~/.config/grainlify-bounty-agent/`, never in this repo.

### Steps

1. **Test token.** Create the test token and fund the payout float. The mint authority needs devnet SOL first.
   ```
   pnpm tsx scripts/test-usdc-setup.ts https://api.devnet.solana.com <mint-authority.json> <payout-float-pubkey>
   ```
2. **Processes.** Start them, each in its own shell:
   - `pnpm mock`
   - `SIGNER_RAIL=mock pnpm signer`
   - `PAYOUT_NETWORK=solana-devnet … pnpm payout-signer`
   - `pnpm agent`
   - `npx smee-client --url <smee channel> --target http://127.0.0.1:3000/github/webhook`
3. **Allowlist the sandbox repo.** `pnpm cli repo add Grainlify/grainlify-agent-sandbox`
4. **Post a bounty.** `pnpm cli bounty propose Grainlify/grainlify-agent-sandbox <issue>`
5. **Contributor steps.**
   - Link a wallet with `pnpm tsx scripts/sign-link.ts <login> <keypair>` and post the output as a comment.
   - Open a PR that says `Closes #<issue>`.
6. **Merge and approve.** A maintainer merges, then `pnpm approve <payout-id>`.
