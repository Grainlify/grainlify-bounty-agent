# Bounty escrow

Non-custodial escrow for maintainer-funded Grainlify bounties.

Devnet program id: `6MXnJKEdt1YPUZoxT8LkhL7bVshB68o4mXJiSfD8spDA`
Not deployed to mainnet.

## What it guarantees

The money sits in a token account owned by a PDA of this program. Grainlify
never holds it, and there is no instruction that sends it to an address of
Grainlify's choosing: `release` pays the contributor recorded on the escrow and
the fee destination fixed at funding, and nothing else.

## What it does not

In **draw mode** Grainlify names the winner through `assign`, and `release` then
pays that address — so a dishonest attestor could assign an address it
controls. That is the direct cost of the funder pre-committing at funding time
rather than signing again at release, which is what lets a contributor be paid
for merged work when the funder has gone quiet.

Three things bound it:

- every assignment and release is on-chain and attributable;
- the funder can `refund` **alone** after the deadline, with no Grainlify
  signature anywhere in the transaction — which is where a stalled escrow lands
  by default rather than by anyone's decision;
- **self-assign mode** removes the attestor's power to assign at all.

## The fee

2.5% with a $0.25 minimum, charged **on top** of the amount, so the contributor
receives exactly the figure the bounty advertised. Both the rate and the floor
are recorded on the escrow at funding and read from nowhere else at release: a
fee that could change after funding would not be a quoted fee. The program caps
any rate at `MAX_FEE_BPS` (10%) regardless of what a caller passes.

The floor exists because a percentage alone loses money at the small end —
2.5% of a $1 bounty is 2.5c against roughly 2.3c of cost per bounty, almost all
of it inference. This is margin on top of cost, not cost recovery.

## Where outcomes are recorded

All three closing paths (`release`, `refund`, `cancel`) **close the escrow and
vault accounts and return their rent to the funder** — 0.0032 SOL, about $0.47,
which would otherwise sit in dead accounts forever.

A consequence worth knowing if you are verifying one: once an escrow closes,
its outcome is no longer readable from account state. The record is the
`EscrowReleased` / `EscrowRefunded` event in the transaction logs, which is
permanent in transaction history. `tests/client.ts` has a decoder.

## Running the tests

Local validator:

```
anchor build
solana-test-validator --reset --bpf-program <program-id> target/deploy/bounty_escrow.so
ESCROW_PROGRAM_ID=<program-id> pnpm vitest run --config contracts/escrow/vitest.config.ts
```

Devnet (funds test accounts from the Solana CLI's configured keypair, because
the faucet rate-limits):

```
ESCROW_PROGRAM_ID=<program-id> ESCROW_RPC=https://api.devnet.solana.com \
  pnpm vitest run --config contracts/escrow/vitest.config.ts
```
