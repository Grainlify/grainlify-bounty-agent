// grainhack-signer HTTP surface: private network only, a bearer token, and one
// write endpoint that takes a human-signed approval plus the backend-signed
// statement it refers to. No bounty routes exist here, and this process has
// no bounty key to use with them.

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { GrainhackSigner, GrainhackPayRequest } from './grainhack-signer.ts';
import type { GrainhackJournal } from './journal.ts';

export function createGrainhackServer(signer: GrainhackSigner, journal: GrainhackJournal, token: string): Server {
  if (token.length < 24) throw new Error('GRAINHACK_SIGNER_TOKEN must be at least 24 characters');
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
      // What this signer will enforce, for the agent's boot check. Public
      // addresses and numbers only; never a key.
      if (req.method === 'GET' && req.url === '/v1/config') {
        return send(200, { service: 'grainhack-signer', network: signer.network(), mints: signer.mints(), caps: signer.caps(), address: signer.address() });
      }
      if (req.method === 'GET' && req.url === '/v1/grainhack/payouts') return send(200, { payouts: journal.all() });
      if (req.method === 'POST' && req.url === '/v1/grainhack/pay') {
        const body = (await readJson(req)) as GrainhackPayRequest;
        const r = await signer.pay(body);
        if (r.ok) return send(200, r);
        const { ok: _ok, status, ...rest } = r;
        return send(status, rest);
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
    // A statement for a large event is longer than a bounty approval.
    if (size > 512 * 1024) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
