// Test-only: a stand-in for the backend's results key, and a statement builder.
// The backend holds the real key; nothing outside tests signs statements here.

import { createPrivateKey, sign } from 'node:crypto';
import { canonicalJson, type ResultsStatement, RESULTS_DOMAIN } from '../src/grainhack-statement.ts';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function resultsKey(seed32: Buffer) {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed32]), format: 'der', type: 'pkcs8' });
  const jwk = priv.export({ format: 'jwk' }) as { x: string };
  const pubkeyB64 = Buffer.from(jwk.x, 'base64url').toString('base64');
  return {
    pubkeyB64,
    sign: (statementJson: string) => sign(null, Buffer.from(RESULTS_DOMAIN + statementJson, 'utf8'), priv).toString('base64'),
  };
}

export function statement(over: Partial<ResultsStatement> = {}): ResultsStatement {
  return {
    v: 1,
    kind: 'grainhack_results',
    statement_id: '6f9a1c52-6a4e-4f4b-9b8e-1d2c3b4a5f60',
    supersedes: null,
    hackathon_id: '0d6e8a3c-7b1f-4c5e-9a2d-4e5f6a7b8c9d',
    hackathon_name: 'GrainHack Test Event',
    pool: 'contributor',
    computation_id: '9b2f4e6a-1c3d-4e5f-8a7b-6c5d4e3f2a1b',
    currency: 'USDC',
    network: 'solana-devnet',
    pool_minor: '10000000',
    lines: [
      { github_user_id: 101, login: 'alice', amount_minor: '4000000', status: 'payable' },
      { github_user_id: 202, login: 'bob', amount_minor: '3500000', status: 'held_kyc' },
      { github_user_id: 303, login: 'carol', amount_minor: '2500000', status: 'payable' },
    ],
    issued_at: '2026-10-03T08:00:00Z',
    ...over,
  };
}

export function signed(key: ReturnType<typeof resultsKey>, s: ResultsStatement) {
  const json = canonicalJson(s);
  return { statement: json, signature: key.sign(json) };
}
