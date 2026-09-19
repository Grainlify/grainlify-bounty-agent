// HTTP surface of the agent: the GitHub webhook, the read-only public API
// for grainlify.com, and a small payouts API used by the approve command.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type pg from 'pg';
import type { Approval } from '../../../packages/gate/src/approval.ts';
import type { BountyService } from './service.ts';
import { corsHeaders, type PublicApi } from './public.ts';

export function verifyWebhookSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export interface ServerDeps {
  db: pg.Pool;
  service: BountyService;
  webhookSecret: string;
  publicApi?: PublicApi;
  /** Browser origins allowed to read /public/*. */
  publicOrigins?: string[];
  onError?: (e: unknown) => void;
}

export function createAgentServer(d: ServerDeps): Server & { idle: () => Promise<void> } {
  const inflight = new Set<Promise<void>>();

  async function process(delivery: string, event: string, payload: Record<string, unknown>) {
    try {
      const repo = (payload.repository as { full_name?: string } | undefined)?.full_name;
      const action = String(payload.action ?? '');
      if (repo && event === 'issue_comment' && action === 'created') {
        await d.service.onIssueComment(repo, payload as never);
      } else if (repo && event === 'pull_request') {
        const n = (payload.pull_request as { number: number }).number;
        if (['opened', 'reopened', 'synchronize', 'ready_for_review', 'edited'].includes(action)) await d.service.onPullRequestActivity(repo, n);
        else if (action === 'closed') await d.service.onPullRequestClosed(repo, n);
      }
      await d.db.query(`UPDATE webhook_deliveries SET processed_at = now() WHERE delivery_id = $1`, [delivery]);
    } catch (e) {
      await d.db.query(`UPDATE webhook_deliveries SET error = $2 WHERE delivery_id = $1`, [delivery, String(e).slice(0, 1000)]).catch(() => {});
      d.onError?.(e);
    }
  }

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://agent');

      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });

      if (url.pathname.startsWith('/public/') && d.publicApi) {
        const cors = corsHeaders(req.headers.origin, d.publicOrigins ?? []);
        const pub = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'public, max-age=15', ...cors });
          res.end(JSON.stringify(body));
        };
        if (req.method === 'OPTIONS') {
          res.writeHead(204, cors);
          return res.end();
        }
        if (req.method !== 'GET') return pub(405, { error: 'read-only' });
        if (url.pathname === '/public/status') return pub(200, d.publicApi.status());
        if (url.pathname === '/public/ledger') return pub(200, await d.publicApi.ledger());
        if (url.pathname === '/public/bounties') return pub(200, { status: d.publicApi.status(), bounties: await d.publicApi.bounties() });
        const b = /^\/public\/bounties\/([0-9a-f-]{36})$/.exec(url.pathname);
        if (b) {
          const [one] = await d.publicApi.bounties(b[1]);
          return one ? pub(200, { status: d.publicApi.status(), bounty: one }) : pub(404, { error: 'not found' });
        }
        return pub(404, { error: 'not found' });
      }

      // Wallet link from a signed-in Grainlify session. Browser-facing, so the
      // same origin allowlist as /public/*; what authorises it is the two
      // signatures in the body, not the origin.
      if (url.pathname === '/link/session') {
        const cors = corsHeaders(req.headers.origin, d.publicOrigins ?? [], 'POST, OPTIONS');
        const reply = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors });
          res.end(JSON.stringify(body));
        };
        if (req.method === 'OPTIONS') {
          res.writeHead(204, cors);
          return res.end();
        }
        if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
        let body: Record<string, unknown>;
        try {
          body = JSON.parse((await readRaw(req, 16 * 1024)).toString('utf8')) as Record<string, unknown>;
        } catch {
          return reply(400, { error: 'malformed', detail: 'the body must be JSON under 16 KB' });
        }
        const r = await d.service.linkWalletFromSession({ message: body?.message, countersignature: body?.countersignature, walletSignature: body?.walletSignature });
        return r.ok
          ? reply(r.status, { linked: true, wallet: r.wallet, githubLogin: r.githubLogin, replaced: r.replaced, unchanged: r.unchanged })
          : reply(r.status, { error: r.error, detail: r.detail });
      }

      if (req.method === 'POST' && url.pathname === '/github/webhook') {
        const raw = await readRaw(req, 5 * 1024 * 1024);
        if (!verifyWebhookSignature(d.webhookSecret, raw, req.headers['x-hub-signature-256'] as string | undefined)) return send(401, { error: 'bad signature' });
        const delivery = String(req.headers['x-github-delivery'] ?? '');
        const event = String(req.headers['x-github-event'] ?? '');
        if (!delivery || !event) return send(400, { error: 'missing delivery or event header' });
        const payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        // Dedupe gates the side effects: a redelivered event does nothing.
        const ins = await d.db.query(`INSERT INTO webhook_deliveries (delivery_id, event, action) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING delivery_id`, [delivery, event, String(payload.action ?? '')]);
        if (!ins.rowCount) return send(200, { duplicate: true });
        const p = process(delivery, event, payload);
        inflight.add(p);
        void p.finally(() => inflight.delete(p));
        return send(202, { accepted: true });
      }

      const m = /^\/api\/payouts\/([0-9a-f-]{36})(\/approve)?$/.exec(url.pathname);
      if (m) {
        if (req.method === 'GET' && !m[2]) {
          const v = await d.service.payoutTerms(m[1]!);
          return v ? send(200, v) : send(404, { error: 'not found' });
        }
        if (req.method === 'POST' && m[2]) {
          const body = JSON.parse((await readRaw(req, 64 * 1024)).toString('utf8')) as { approval: Approval };
          try {
            return send(200, await d.service.approvePayout(m[1]!, body.approval));
          } catch (e) {
            return send(409, { error: String(e instanceof Error ? e.message : e) });
          }
        }
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(400, { error: String(e) });
    }
  });

  return Object.assign(server, { idle: async () => void (await Promise.all([...inflight])) });
}

async function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}
