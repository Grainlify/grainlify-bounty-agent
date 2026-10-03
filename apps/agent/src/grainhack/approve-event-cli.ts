// Entry point for `pnpm approve-event <hackathon_id>`; see approve-event.ts.
// Runs on the approver's machine. Needs AGENT_URL, PAYOUTS_API_TOKEN,
// GRAINHACK_RESULTS_PUBKEY and the approver keypair (APPROVER_KEYPAIR, or the
// same default path the bounty `approve` command uses).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { approveEvent } from './approve-event.ts';

const hackathonId = process.argv[2];
const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`${k} is required`);
  return v;
};
if (!hackathonId) {
  console.error('usage: pnpm approve-event <hackathon_id>');
  process.exit(2);
}
const keyPath = process.env.APPROVER_KEYPAIR ?? join(homedir(), '.config', 'grainlify-bounty-agent', 'approver.keypair.json');
const secret = Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8')) as number[]);
const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  const r = await approveEvent(hackathonId, {
    agentUrl: process.env.AGENT_URL ?? 'http://127.0.0.1:3000',
    token: need('PAYOUTS_API_TOKEN'),
    approverSecret: secret,
    resultsPubkey: need('GRAINHACK_RESULTS_PUBKEY'),
    ask: (q) => rl.question(q),
    log: (l) => console.log(l),
  });
  if (r.failed) process.exitCode = 1;
} finally {
  rl.close();
}
