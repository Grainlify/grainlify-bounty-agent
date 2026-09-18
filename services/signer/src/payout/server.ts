// Payout signer HTTP surface: loopback, bearer token, and a single write
// endpoint that takes a human-signed approval. There is no way to ask it to
// pay an arbitrary amount to an arbitrary address.

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Approval } from '../../../../packages/gate/src/approval.ts';
import type { PayoutJournal } from './journal.ts';
import type { PayoutSigner } from './payout-signer.ts';

export function createPayoutServer(signer: PayoutSigner, journal: PayoutJournal, token: string): Server {
  if (token.length < 24) throw new Error('PAYOUT_SIGNER_TOKEN must be at least 24 characters');
  const expected = Buffer.from(`Bearer ${token}`);
  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const auth = Buffer.from(req.headers.authorization ?? '');
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return send(401, { error: 'unauthorized' });
      if (req.method === 'GET' && req.url === '/v1/wallet') return send(200, { address: signer.address() });
      if (req.method === 'GET' && req.url === '/v1/payouts') return send(200, { payouts: journal.all() });
      if (req.method === 'POST' && req.url === '/v1/payout/pay') {
        const body = (await readJson(req)) as { approval: Approval };
        const r = await signer.pay(body.approval);
        return r.ok ? send(200, r) : send(r.status, { error: r.error });
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(400, { error: String(e) });
    }
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 32 * 1024) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
