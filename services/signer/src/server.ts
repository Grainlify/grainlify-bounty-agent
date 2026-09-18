// Signer HTTP surface. Loopback only, bearer token required. The only things
// it can do are pay an allowlisted UsePod quote, sign a balance proof, and
// report spend. There is deliberately no "transfer to address X" endpoint.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Signer } from './signer.ts';

const MAX_BODY = 16 * 1024;

export function createSignerServer(signer: Signer, token: string): Server {
  if (token.length < 24) throw new Error('SIGNER_TOKEN must be at least 24 characters');
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
      if (req.method === 'GET' && req.url === '/v1/spend') return send(200, signer.spend());

      if (req.method === 'POST' && req.url === '/v1/inference/pay') {
        const body = (await readJson(req)) as Parameters<Signer['payQuote']>[0];
        const r = await signer.payQuote(body);
        return r.ok ? send(200, r) : send(r.status, { error: r.error });
      }
      if (req.method === 'POST' && req.url === '/v1/inference/balance-proof') {
        const body = (await readJson(req)) as { quote_id: string };
        const r = signer.balanceProof(body.quote_id);
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
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
