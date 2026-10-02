// HTTP surface of the agent: the GitHub webhook, the read-only public API
// for grainlify.com, and a small payouts API used by the approve command.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type pg from 'pg';
import type { Approval } from '../../../packages/gate/src/approval.ts';
import type { BountyService } from './service.ts';
import type { DrawService } from './draw-service.ts';
import type { EscrowService } from './escrow-service.ts';
import type { FundedService } from './funded-service.ts';
import { corsHeaders, type PublicApi } from './public.ts';
import { verifySessionAction } from '../../../packages/gate/src/session-action.ts';
import { eraseAccount } from './erasure-service.ts';

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
  /**
   * Bearer token for the payouts API (PAYOUTS_API_TOKEN).
   *
   * Reading a payout tells you the recipient's wallet address and the whole
   * gate result, for a bounty that has not been paid yet. That was readable by
   * anyone who knew the id, and payout ids travel in approval requests and
   * logs. Unset means the read is refused (503), never opened: a service that
   * boots without its token must not serve the data it is missing the key for.
   */
  payoutsApiToken?: string;
  /**
   * Maintainer-funded bounties. Absent until the escrow is configured, and the
   * routes answer 503 rather than pretending the feature is merely switched
   * off - "not wired up" and "turned off" are different answers and an
   * operator needs to tell them apart.
   */
  escrow?: EscrowService;
  /** Funded bounties' lifecycle: funding, assigning, unassigning, disputes. Present whenever `escrow` is. */
  funded?: FundedService;
  /**
   * Applications, the draw and the admin controls. Absent in the tests that
   * only exercise the webhook and the link routes, so those routes answer 503
   * rather than crashing - a half-wired server should say which half.
   */
  draw?: DrawService;
  /**
   * Public half of the key Grainlify-Backend signs apply and admin messages
   * with. The same key as the wallet link; different domains inside it.
   */
  linkCountersignKey?: string;
  /**
   * One line per request. Default console.log; tests pass their own.
   *
   * It exists because when a link did not appear, the logs held only the boot
   * line: there was no way to tell a request that never arrived from one that
   * arrived and was refused. It carries the method, the path, the status, how
   * long it took, and - for a link attempt - the outcome and the GitHub id the
   * countersignature named.
   *
   * It never carries a secret: no Authorization header, no bearer token, no
   * wallet or Grainlify signature, no countersignature, and not the signed
   * message. The wallet address stays out too; the database holds the link,
   * and a log is a worse place for it than a table with access control.
   */
  log?: (line: string) => void;
  onError?: (e: unknown) => void;
  /**
   * The clock the signed-message checks use. Injectable for the same reason
   * the service's is: a route that reads new Date() directly cannot have its
   * expiry behaviour tested, and one of the three message verifiers already
   * shipped with that gap.
   */
  now?: () => Date;
}

/** Constant-time bearer check, so a wrong token cannot be found a byte at a time. */
function bearerOk(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const got = Buffer.from(header.slice(7));
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
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
    const log = d.log ?? ((line: string) => console.log(line));
    const startedAt = Date.now();
    // Only the path: a query string is caller-controlled and would put
    // whatever somebody sent us into the log.
    const path = (req.url ?? '/').split('?')[0];
    let note = '';
    res.on('finish', () => log(`${req.method} ${path} ${res.statusCode} ${Date.now() - startedAt}ms${note}`));

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
        if (url.pathname === '/public/rules') return pub(200, await d.publicApi.rules());
        if (url.pathname === '/public/ledger') return pub(200, await d.publicApi.ledger());
        if (url.pathname === '/public/bounties') return pub(200, { status: d.publicApi.status(), bounties: await d.publicApi.bounties() });
        const funder = /^\/public\/funders\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/.exec(url.pathname);
        if (funder) {
          if (!d.funded) return pub(404, { error: 'not found' });
          return pub(200, { profile: await d.funded.profile(funder[1]!) });
        }
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
      // Reading your own link. Separate route, separate domain, no nonce spend.
      if (url.pathname === '/link/session/read') {
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
        let raw: Buffer;
        try {
          raw = await readRaw(req, 16 * 1024);
        } catch {
          // Reading the body failed outright: too large, or the connection
          // ended early. Distinct from "arrived but is not JSON".
          note = ' read=refused reason=body_unreadable';
          return reply(400, { error: 'body_unreadable', detail: 'the request body could not be read' });
        }
        try {
          body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          // This branch used to return without logging anything, which is how a
          // malformed body spent a round of diagnosis being mistaken for a bad
          // signature: same 400, no note, nothing to tell them apart. The size
          // and content type say whether the body went missing in transit.
          note = ` read=refused reason=malformed bytes=${raw.length} ctype=${String(req.headers['content-type'] ?? 'none')}`;
          return reply(400, { error: 'malformed', detail: `the body must be JSON under 16 KB; received ${raw.length} bytes` });
        }
        const r = await d.service.readLinkFromSession({ message: body?.message, countersignature: body?.countersignature });
        // Whose link was asked for and whether one exists, without putting the
        // signed material or the address in a log line.
        note = r.ok ? ` read=${r.wallet ? 'linked' : 'none'} github=${r.githubUserId}` : ` read=refused reason=${r.error}`;
        return r.ok
          ? reply(r.status, { linked: r.wallet !== null, wallet: r.wallet, linkedAt: r.linkedAt, githubLogin: r.githubLogin })
          : reply(r.status, { error: r.error, detail: r.detail });
      }

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
        // Enough to answer "did this attempt reach us, whose was it, and what
        // did we decide" without putting the signed material in a log file.
        note = r.ok
          ? ` link=${r.unchanged ? 'unchanged' : r.replaced ? 'replaced' : 'linked'} github=${r.githubUserId}`
          : ` link=refused reason=${r.error}`;
        return r.ok
          ? reply(r.status, { linked: true, wallet: r.wallet, githubLogin: r.githubLogin, replaced: r.replaced, unchanged: r.unchanged })
          : reply(r.status, { error: r.error, detail: r.detail });
      }

      // Erasing a person's account at their request (erasure-service.ts).
      // Called by Grainlify-Backend's erasure executor, never by a browser, so
      // no CORS. What authorises it is the countersignature under the erasure
      // domain, which only that executor produces.
      //
      // No nonce is spent. Erasure is idempotent, so a replay inside the
      // ten-minute window changes nothing - and spending one would write a
      // link_nonces row naming the person straight after erasing theirs.
      if (req.method === 'POST' && url.pathname === '/account/erase') {
        if (!d.linkCountersignKey) return send(503, { error: 'erasure_not_configured' });
        let body: Record<string, unknown>;
        try {
          body = JSON.parse((await readRaw(req, 16 * 1024)).toString('utf8')) as Record<string, unknown>;
        } catch {
          note = ' erase=refused reason=malformed';
          return send(400, { error: 'malformed' });
        }
        const v = verifySessionAction(
          { message: body?.message, countersignature: body?.countersignature },
          d.linkCountersignKey,
          'erasure',
          (d.now ?? (() => new Date()))(),
        );
        if (!v.ok) {
          note = ` erase=refused reason=${v.code}`;
          return send(400, { error: v.code, detail: v.reason });
        }
        const r = await eraseAccount(d.db, v.fields.githubUserId);
        if (!r.ok) {
          note = ` erase=held github=${v.fields.githubUserId}`;
          return send(409, { error: 'in_flight', detail: r.inFlight.join('; ') });
        }
        note = ` erase=${r.alreadyErased ? 'already' : 'done'} github=${v.fields.githubUserId}`;
        return send(200, { erased: true, alreadyErased: r.alreadyErased, removed: r.removed });
      }

      // One real inference call, to verify the deployed service can buy
      // reasoning on the live market. Behind the same bearer token as the
      // payouts read, because it spends real money -- a little, once, with no
      // caller-supplied prompt or budget.
      if (req.method === 'POST' && url.pathname === '/admin/inference/verify') {
        if (!d.payoutsApiToken) return send(503, { error: 'payouts_api_token_not_configured' });
        if (!bearerOk(req.headers.authorization, d.payoutsApiToken)) return send(401, { error: 'unauthorized' });
        const r = await d.service.verifyInference();
        note = ` verify=${r.scheme} charged=${r.chargedMicro} fee=${r.feeMicro}`;
        return send(200, r);
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

      // ---------------------------------------------------------- the draw
      //
      // Both routes take a message Grainlify-Backend countersigned, naming the
      // person and the action. The browser never asserts who it is here, for
      // the same reason it no longer asks about its own wallet: a page can
      // claim any login, and an extension rewrites every request it makes.
      //
      // Authorisation is split deliberately. That the caller IS who the
      // message says is proved by the signature; that they are ALLOWED to run
      // an admin action is Grainlify's judgement, made before it signs. This
      // service checks the first and trusts the second, and the admin domain
      // is what keeps a contributor's apply message from reaching either.
      if (req.method === 'POST' && (url.pathname === '/bounties/apply' || url.pathname === '/bounties/mine' || url.pathname === '/admin/draw' || url.pathname === '/maintainer/draw')) {
        const isAdmin = url.pathname === '/admin/draw';
        const isMaintainer = url.pathname === '/maintainer/draw';
        const isRead = url.pathname === '/bounties/mine';
        const cors = corsHeaders(req.headers.origin, d.publicOrigins ?? [], 'POST, OPTIONS');
        const reply = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors });
          res.end(JSON.stringify(body));
        };
        if (!d.draw || !d.linkCountersignKey) return reply(503, { error: 'draw_not_configured', detail: 'the draw is not switched on for this agent' });

        let body: Record<string, unknown>;
        try {
          body = JSON.parse((await readRaw(req, 16 * 1024)).toString('utf8')) as Record<string, unknown>;
        } catch {
          note = ' draw=refused reason=malformed';
          return reply(400, { error: 'malformed', detail: 'the body must be JSON under 16 KB' });
        }
        const v = verifySessionAction(
          { message: body?.message, countersignature: body?.countersignature },
          d.linkCountersignKey,
          isAdmin ? 'admin' : isMaintainer ? 'maintainer' : 'apply',
          (d.now ?? (() => new Date()))(),
        );
        if (!v.ok) {
          note = ` draw=refused reason=${v.code}`;
          return reply(400, { error: v.code, detail: v.reason });
        }
        const f = v.fields;

        // One use per message, whoever replays it. Shared with the wallet
        // link's nonce table: a nonce is a nonce, and two tables would mean
        // two places to get the uniqueness wrong.
        //
        // Reads are exempt, as the wallet read is. Spending a nonce to answer
        // "what have I applied for" would mean a page that reloads twice in
        // the same second refuses to tell you the second time, and there is
        // nothing to replay: the answer is the same however often it is asked.
        if (!isRead) {
          const spent = await d.db.query(
            `INSERT INTO link_nonces (nonce, github_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING nonce`,
            [f.nonce, f.githubUserId],
          );
          if (!spent.rowCount) {
            note = ' draw=refused reason=nonce_used';
            return reply(409, { error: 'nonce_used', detail: 'that request was already used; try again' });
          }
        }

        if (isRead) {
          const [applications, assignments] = await Promise.all([
            d.draw.applicationsForUser(f.githubUserId),
            d.draw.assignmentsForUser(f.githubUserId),
          ]);
          note = ` mine=${Object.keys(applications).length} github=${f.githubUserId}`;
          return reply(200, { githubLogin: f.login, applications, assignments });
        }

        // The contributor's side of unassigning once a pull request is open.
        // Same channel as applying: it is the contributor acting on their own
        // assignment, and the funded service checks it is theirs by GitHub id.
        if (!isAdmin && !isMaintainer && f.action.startsWith('unassign_')) {
          if (!d.funded) return reply(503, { error: 'escrow_not_configured' });
          note = ` contributor=${f.action} github=${f.githubUserId}`;
          const text = typeof body.text === 'string' ? body.text : '';
          const r = f.action === 'unassign_propose'
            ? await d.funded.propose(f.subject, f.login, f.githubUserId, text)
            : f.action === 'unassign_accept' || f.action === 'unassign_refuse'
              ? await d.funded.respond(f.subject, f.login, f.githubUserId, f.action === 'unassign_accept', text)
              : f.action === 'unassign_withdraw'
                ? await d.funded.withdraw(f.subject, f.login)
                : { ok: false as const, status: 400, error: 'unknown_action', detail: `no contributor action named ${f.action}` };
          return r.ok ? reply(200, r) : reply(r.status, { error: r.error, detail: r.detail });
        }

        if (!isAdmin && !isMaintainer) {
          const r = await d.draw.apply({
            bountyId: f.subject,
            githubUserId: f.githubUserId,
            githubLogin: f.login,
            // Optional, untrusted, never weighted. It is outside the signed
            // message on purpose: signing it would imply Grainlify vouches
            // for words the applicant wrote.
            applicationText: typeof body.applicationText === 'string' ? body.applicationText : undefined,
          });
          note = ` apply=${r.ok ? 'accepted' : r.error} github=${f.githubUserId}`;
          return r.ok
            ? reply(r.status, { applied: true, applicationId: r.applicationId, closesAt: r.closesAt })
            : reply(r.status, { error: r.error, detail: r.detail });
        }

        // Maintainer actions. Grainlify signs these for anybody signed in, so
        // every per-bounty action is checked HERE against GitHub permission
        // on that bounty's own repository, or against who funded it. Nothing
        // on this channel touches platform settings.
        if (isMaintainer) {
          note = ` maintainer=${f.action} by=${f.login}`;
          if (f.action === 'bounties') {
            // Who maintains what is GitHub's answer, not ours.
            return reply(200, { bounties: await d.draw.bountiesForMaintainer(f.login) });
          }
          // Funded bounties are unreachable while switched off - refused for
          // being off before anything else is looked at, so a disabled feature
          // never answers a question about whether a bounty exists.
          if (f.action.startsWith('escrow_')) {
            if (!d.escrow) return reply(503, { error: 'escrow_not_configured' });
            if (!(await d.escrow.enabledFor(f.login))) return reply(403, { error: 'funded_bounties_disabled' });
          }
          // A quote is arithmetic on an amount, about no bounty in particular.
          switch (f.action) {
            case 'escrow_quote': {
              if (!d.escrow) return reply(503, { error: 'escrow_not_configured' });
              let amount: bigint;
              try { amount = BigInt(String(body.amountMinor ?? '')); }
              catch { return reply(400, { error: 'bad_amount' }); }
              if (amount <= 0n) return reply(400, { error: 'bad_amount' });
              const q = await d.escrow.quoteFor(amount);
              return reply(200, {
                amountMinor: q.amountMinor.toString(),
                feeBps: q.feeBps,
                feeMinimumMinor: q.feeMinimumMinor.toString(),
                feeAmountMinor: q.feeAmountMinor.toString(),
                totalMinor: q.totalMinor.toString(),
                effectiveRate: q.effectiveRate,
                flooredByMinimum: q.flooredByMinimum,
              });
            }
          }
          // --- funded bounties: the funder runs their own --------------
          //
          // Each is checked inside the funded service: the switch (or a
          // tester), and that the caller FUNDED this bounty - a repository
          // maintainer who did not fund it does not run it.
          if (f.action.startsWith('funded_')) {
            if (!d.funded) return reply(503, { error: 'escrow_not_configured' });
            const fd = d.funded;
            const text = typeof body.reason === 'string' ? body.reason : '';
            const sig = String(body.signature ?? '');
            const out = await (async () => {
              switch (f.action) {
                case 'funded_prepare': {
                  // Subject is owner/name:issue. Whether it is a verified
                  // Grainlify project is the backend's answer, which it gives
                  // before signing; verifiedProject repeats it.
                  const m = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):([1-9][0-9]{0,9})$/.exec(f.subject);
                  if (!m) return { ok: false as const, status: 400, error: 'bad_subject', detail: 'expected owner/name:issue' };
                  let amount: bigint;
                  try { amount = BigInt(String(body.amountMinor ?? '')); } catch { return { ok: false as const, status: 400, error: 'bad_amount', detail: 'amountMinor must be an integer' }; }
                  const mode = body.mode === 'self_assign' ? 'self_assign' as const : body.mode === 'draw' ? 'draw' as const : null;
                  if (!mode) return { ok: false as const, status: 400, error: 'bad_mode', detail: 'mode is draw or self_assign' };
                  return fd.prepare({
                    login: f.login, githubUserId: f.githubUserId, repo: m[1]!, issueNumber: Number(m[2]), amountMinor: amount,
                    currency: String(body.currency ?? ''), mode, deadline: new Date(String(body.deadline ?? '')),
                    funderWallet: String(body.funderWallet ?? ''), verifiedProject: body.verifiedProject === true,
                  });
                }
                case 'funded_status':
                  return fd.status(f.login);
                case 'funded_confirm':
                  // The signature is optional: a funder whose page closed
                  // after signing comes back without it, and the chain is
                  // what is believed either way.
                  return fd.confirm(f.subject, f.login, sig || null);
                case 'funded_reclaim':
                  return fd.reclaim(f.subject, f.login);
                case 'funded_reclaim_confirm':
                  return fd.reclaimConfirm(f.subject, f.login);
                case 'funded_view':
                  return fd.view(f.subject, f.login);
                case 'funded_assign_prepare':
                  return fd.assignPrepare(f.subject, f.login, String(body.applicant ?? ''));
                case 'funded_assign_confirm':
                  return fd.assignConfirm(f.subject, f.login, String(body.applicant ?? ''), sig);
                case 'funded_draw':
                  return fd.runDraw(f.subject, f.login, body.simulate === true);
                case 'funded_unassign':
                  return fd.unassign(f.subject, f.login, text);
                case 'funded_unassign_confirm':
                  return fd.unassignConfirm(f.subject, f.login, text, sig);
                case 'funded_propose':
                  return fd.propose(f.subject, f.login, f.githubUserId, text);
                case 'funded_accept':
                case 'funded_refuse':
                  return fd.respond(f.subject, f.login, f.githubUserId, f.action === 'funded_accept', text);
                case 'funded_withdraw':
                  return fd.withdraw(f.subject, f.login);
                default:
                  return { ok: false as const, status: 400, error: 'unknown_action', detail: `no maintainer action named ${f.action}` };
              }
            })();
            if (!out.ok) note += ` refused=${out.error}`;
            return out.ok ? reply(200, out) : reply(out.status, { error: out.error, detail: out.detail });
          }

          // Named before anything is looked up: an action this channel does
          // not have, or a subject that is not a bounty id, is a bad request,
          // not a database error.
          const PER_BOUNTY = ['view', 'unassign', 'set_assignment_deadline', 'run_draw', 'escrow_state', 'escrow_confirm'];
          if (!PER_BOUNTY.includes(f.action)) {
            return reply(400, { error: 'unknown_action', detail: `no maintainer action named ${f.action}` });
          }
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(f.subject)) {
            return reply(400, { error: 'bad_subject', detail: 'the subject must be a bounty id' });
          }
          const may = await d.draw.canManageBounty(f.subject, f.login);
          if (!may.ok) {
            note += ` refused=${may.error}`;
            return reply(may.error === 'no_such_bounty' ? 404 : 403, {
              error: may.error,
              detail: may.error === 'no_such_bounty' ? 'that bounty does not exist' : 'you do not maintain this bounty\'s repository and did not fund it',
            });
          }
          // The agent's own draw controls do not run a funded bounty: they know
          // nothing of the escrow, and would leave the chain and this table
          // disagreeing about who holds it.
          if (['unassign', 'set_assignment_deadline', 'run_draw'].includes(f.action)) {
            const funded = await d.db.query('SELECT 1 FROM bounties WHERE id = $1 AND funded_by IS NOT NULL', [f.subject]);
            if (funded.rowCount) return reply(409, { error: 'funded_bounty', detail: 'this bounty is funded; its funder runs it from the funded controls' });
          }
          switch (f.action) {
            case 'view': {
              // What they may SEE is decided by the clock, and would be the
              // same answer however the question were asked.
              const v = await d.draw.maintainerView(f.subject);
              return 'error' in v ? reply(404, v) : reply(200, v);
            }
            case 'unassign': {
              const r = await d.draw.unassignByDecision({ bountyId: f.subject, actor: f.login, reason: String(body.reason ?? '') });
              return r.ok ? reply(200, r) : reply(409, r);
            }
            case 'set_assignment_deadline': {
              const r = await d.draw.setAssignmentDeadline({
                bountyId: f.subject, newAt: new Date(String(body.deadline ?? '')), actor: f.login, reason: String(body.reason ?? ''),
              });
              return r.ok ? reply(200, r) : reply(409, r);
            }
            // --- funded bounties: the funder's own escrow ---------------
            // Every one refuses while funded_bounties_enabled is off; state
            // is now checked per bounty too, where on the admin channel it
            // answered for any escrow to anybody signed in.
            case 'escrow_state': {
              if (!d.escrow) return reply(503, { error: 'escrow_not_configured' });
              const e = await d.escrow.detail(f.subject);
              return e ? reply(200, { escrow: e }) : reply(404, { error: 'no_escrow' });
            }
            case 'escrow_confirm': {
              if (!d.escrow) return reply(503, { error: 'escrow_not_configured' });
              const sig = String(body.signature ?? '');
              if (!sig) return reply(400, { error: 'signature_required' });
              if (d.funded) {
                const r = await d.funded.confirm(f.subject, f.login, sig);
                return r.ok ? reply(200, r) : reply(r.status, { error: r.error, detail: r.detail });
              }
              const r = await d.escrow.confirmFunding(f.subject, sig);
              return r.ok ? reply(200, r) : reply(409, r);
            }
            case 'run_draw': {
              const staleHours = body.staleHours === undefined ? undefined : Number(body.staleHours);
              if (staleHours !== undefined && (!Number.isFinite(staleHours) || staleHours <= 0)) {
                return reply(400, { error: 'bad_deadline' });
              }
              const r = await d.draw.runDrawFor(f.subject, { triggeredBy: f.login, simulate: body.simulate === true, staleHours });
              return 'error' in r ? reply(409, r) : reply(200, r);
            }
            default:
              return reply(400, { error: 'unknown_action', detail: `no maintainer action named ${f.action}` });
          }
        }

        // Admin actions: platform-wide settings, the repository allowlist and
        // escrow arbitration. Per-bounty controls are maintainers' and live
        // on the channel above; they were removed from here so that "the
        // admin keeps only platform settings and disputes" holds in the
        // agent, not just in a screen. Each action names itself in the signed
        // message, so a signature issued for one cannot run another.
        note = ` admin=${f.action} by=${f.login}`;
        switch (f.action) {
          case 'list_settings':
            return reply(200, { settings: await d.draw.settings() });
          case 'set_setting': {
            const r = await d.draw.setSetting(f.subject, String(body.value ?? ''), f.login);
            return r.ok ? reply(200, { ok: true, settings: await d.draw.settings() }) : reply(400, { error: 'invalid_value', detail: r.error });
          }
          case 'reset_setting': {
            const r = await d.draw.resetSetting(f.subject);
            return r.ok ? reply(200, { ok: true, settings: await d.draw.settings() }) : reply(400, { error: 'unknown_setting', detail: r.error });
          }
          // --- funded bounties -------------------------------------------
          //
          // Every one of these refuses outright while funded_bounties_enabled
          // is off, rather than rendering a disabled screen: a feature that is
          // switched off should not have a reachable back door.
          case 'escrow_state': {
            // Arbitration: an admin reading any escrow. Only reachable after
            // Grainlify's live admin check.
            if (!d.escrow) return reply(503, { error: 'escrow_not_configured' });
            const e = await d.escrow.detail(f.subject);
            return e ? reply(200, { escrow: e }) : reply(404, { error: 'no_escrow' });
          }
          case 'escrow_list': {
            if (!d.escrow) return reply(503, { error: 'escrow_not_configured' });
            return reply(200, { escrows: await d.escrow.all() });
          }
          // Disputes: refused proposals to unassign once a pull request was
          // open. The admin can leave it to the deadline or record a conduct
          // note. There is no action that ends a dispute in the funder's
          // favour early, because nothing could: refund is the funder's,
          // after the deadline, and the program has no other way back.
          case 'dispute_list':
            if (!d.funded) return reply(503, { error: 'escrow_not_configured' });
            return reply(200, { disputes: await d.funded.disputes() });
          case 'dispute_view': {
            if (!d.funded) return reply(503, { error: 'escrow_not_configured' });
            const r = await d.funded.dispute(f.subject);
            return r.ok ? reply(200, r) : reply(r.status, { error: r.error, detail: r.detail });
          }
          case 'dispute_leave': {
            if (!d.funded) return reply(503, { error: 'escrow_not_configured' });
            const r = await d.funded.leaveToDeadline(f.subject, f.login);
            return r.ok ? reply(200, r) : reply(r.status, { error: r.error, detail: r.detail });
          }
          case 'dispute_note': {
            if (!d.funded) return reply(503, { error: 'escrow_not_configured' });
            const r = await d.funded.conductNote(f.subject, f.login, String(body.note ?? ''));
            return r.ok ? reply(200, r) : reply(r.status, { error: r.error, detail: r.detail });
          }
          case 'list_repos':
            return reply(200, { repos: await d.service.repoBountyStates() });
          case 'set_repo_bounties': {
            // registeredProject is Grainlify's assertion, carried in the body
            // of a message this admin signed. This service has no projects
            // table and cannot check it; what it can do is record who said so.
            const r = await d.service.setRepoBounties(f.subject, {
              enabled: body.enabled === true,
              registeredProject: body.registeredProject === true,
              changedBy: f.login,
            });
            return r.ok ? reply(200, { ...r, repos: await d.service.repoBountyStates() }) : reply(409, { error: r.error, detail: r.detail });
          }
          default:
            return reply(400, { error: 'unknown_action', detail: `no admin action named ${f.action}` });
        }
      }

      const m = /^\/api\/payouts\/([0-9a-f-]{36})(\/approve)?$/.exec(url.pathname);
      if (m) {
        if (req.method === 'GET' && !m[2]) {
          // Authorised before the payout is looked up, so a refusal cannot be
          // used to tell an existing payout id from a made-up one.
          if (!d.payoutsApiToken) return send(503, { error: 'payouts_api_token_not_configured' });
          if (!bearerOk(req.headers.authorization, d.payoutsApiToken)) return send(401, { error: 'unauthorized' });
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
      // This used to answer 400 with the raw error string. Both halves were
      // wrong. A database fault is not a bad request, and reporting it as one
      // cost a full round of diagnosis chasing a signature that was fine; and
      // the raw text put internal detail (a column name, in the case that
      // finally exposed this) in front of whoever asked. The caller now gets a
      // reference, and the detail stays in our log where it belongs.
      const ref = randomUUID().slice(0, 8);
      note = ` error ref=${ref} detail=${JSON.stringify(String(e).slice(0, 500))}`;
      // If the failure came after a reply had already started there is no
      // status left to set; the log line above is the whole record of it.
      if (res.headersSent) return res.end();
      // Error responses carry the same CORS headers as successful ones -
      // otherwise a browser reports every server fault as a CORS problem and
      // hides the status that would have explained it.
      res.writeHead(500, {
        'content-type': 'application/json',
        ...corsHeaders(req.headers.origin, d.publicOrigins ?? [], 'GET, POST, OPTIONS'),
      });
      return res.end(JSON.stringify({ error: 'internal', ref }));
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
