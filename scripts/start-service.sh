#!/bin/sh
# Container entrypoint: runs exactly one service, chosen by $SERVICE.
set -eu
case "${SERVICE:-}" in
  agent)            exec npx tsx apps/agent/src/main.ts ;;
  inference-signer) exec npx tsx services/signer/src/main.ts ;;
  payout-signer)    exec npx tsx services/signer/src/payout/main.ts ;;
  mock-gateway)     exec npx tsx packages/mock-gateway/src/main.ts ;;
  *) echo "SERVICE must be one of: agent, inference-signer, payout-signer, mock-gateway" >&2; exit 64 ;;
esac
