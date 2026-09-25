# UsePod x402 error reference

> GENERATED FILE — do not edit by hand. It is produced from
> `fixtures/usepod/x402-errors.json` by `scripts/generate-x402-errors-doc.ts`.
> Regenerate with `pnpm docs:x402-errors` after changing the fixture.

Endpoint: `POST https://api.usepod.ai/proxy/x402/v1/chat/completions`
Fixture captured: 2026-09-18T19:50Z

## Provenance

observed = returned by the live gateway to an unpaid probe (cost $0). assumed = not yet seen live; the mock uses this text until the paid spike replaces it.

18 errors recorded: 15 observed, 3 assumed.

## Errors

| Key | Status | Type | Provenance | Message |
| --- | --- | --- | --- | --- |
| `invalid_json_body` | 400 | `bad_request` | observed | bad request: invalid JSON: expected ident at line 1 column 2 |
| `missing_max_tokens` | 400 | `bad_request` | observed | bad request: x402 requests must include max_tokens or max_completion_tokens |
| `stream_not_supported` | 400 | `bad_request` | observed | bad request: x402 tokenless streaming is not enabled; use an MPP session |
| `no_provider` | 503 | `no_provider` | observed | no healthy provider for model: {model} |
| `invalid_payment_json` | 400 | `bad_request` | observed | bad request: invalid payment header JSON: expected ident at line 1 column 2 |
| `missing_tx_signature` | 400 | `bad_request` | observed | bad request: PAYMENT-SIGNATURE is missing the Solana transaction signature |
| `unknown_quote` | 400 | `bad_request` | observed | bad request: unknown x402 quote |
| `unsupported_network` | 400 | `bad_request` | observed | bad request: only Solana and Base x402 payments are supported |
| `tx_not_found` | 400 | `bad_request` | observed | bad request: Solana transaction not found or not yet confirmed |
| `quote_mismatch` | 400 | `bad_request` | observed (phase-0 probe) | bad request: x402 quote does not match this request |
| `balance_missing_proof` | 400 | `bad_request` | observed | bad request: balance spend requires payload.proof (signed quote id) |
| `balance_missing_payer` | 400 | `bad_request` | observed | bad request: balance spend requires payer_wallet |
| `balance_proof_malformed` | 400 | `bad_request` | observed | bad request: proof is not a 64-byte ed25519 signature |
| `balance_proof_invalid` | 400 | `bad_request` | observed | bad request: proof signature does not verify for payer_wallet |
| `balance_insufficient` | 400 | `bad_request` | observed | bad request: x402 wallet balance is below the quote cap ({cap} microunits); pay on-chain instead |
| `quote_expired` | 400 | `bad_request` | assumed | bad request: x402 quote expired |
| `signature_replayed` | 400 | `bad_request` | assumed | bad request: transaction signature already used for another quote |
| `underpaid` | 400 | `bad_request` | assumed | bad request: payment is below the quoted amount |

## Balance payment envelope

Provenance: observed: the gateway gets past its format and signature checks and reaches the balance check

Header: `PAYMENT-SIGNATURE: base64(JSON)`

```json
{
  "quote_id": "<from PAYMENT-REQUIRED>",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "asset": "USDC",
  "payer_wallet": "<base58 pubkey>",
  "scheme": "balance",
  "proof": "<ed25519 signature over utf8 'usepod-x402-spend:<quote_id>', base58 or base64>"
}
```

Checks run in this order:

1. payer_wallet present
2. proof decodes to 64 bytes
3. signature verifies
4. balance >= quote cap

> Gotcha: The error text says payload.proof, but a nested payload.proof is NOT read. The proof must be the top-level field 'proof'.
