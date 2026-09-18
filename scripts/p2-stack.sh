#!/usr/bin/env bash
# Starts the P2 devnet stack in the background; logs in data/p2/. Env from data/p2.env (gitignored).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . data/p2.env; set +a
mkdir -p data/p2
start() { local name=$1; shift; nohup "$@" >> "data/p2/$name.log" 2>&1 & echo "$! $name" >> data/p2/pids; }
: > data/p2/pids
start mock npx tsx packages/mock-gateway/src/main.ts
start inference-signer npx tsx services/signer/src/main.ts
start payout-signer npx tsx services/signer/src/payout/main.ts
start agent npx tsx apps/agent/src/main.ts
start smee npx --yes smee-client --url "$(python3 -c "import json;print(json.load(open('$GITHUB_APP_CONFIG'))['webhook_url'])")" --target "http://127.0.0.1:${AGENT_PORT:-3000}/github/webhook"
echo "started; stop with: kill \$(cut -d' ' -f1 data/p2/pids)"
