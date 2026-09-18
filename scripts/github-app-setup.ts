// Creates the "Grainlify Agent" GitHub App through GitHub's manifest flow.
//
// 1. Serves a one-button page on 127.0.0.1 that POSTs the manifest to GitHub.
// 2. GitHub shows the owner a "Create GitHub App" button.
// 3. GitHub redirects back here with a one-time code, which we exchange for
//    the App's id, private key and webhook secret.
// 4. Credentials are written OUTSIDE the repo (mode 600), then the browser is
//    sent to the install page so the App can be installed on the sandbox only.
//
// Usage: WEBHOOK_URL=https://smee.io/... pnpm tsx scripts/github-app-setup.ts

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ORG = process.env.GITHUB_ORG ?? 'Grainlify';
const PORT = Number(process.env.SETUP_PORT ?? 3978);
const webhookUrl = process.env.WEBHOOK_URL;
if (!webhookUrl) throw new Error('set WEBHOOK_URL (e.g. a smee.io channel for local development)');

const outDir = join(homedir(), '.config', 'grainlify-bounty-agent');
const outFile = join(outDir, 'github-app.json');
if (existsSync(outFile)) throw new Error(`${outFile} already exists; refusing to create a second App`);

const state = randomBytes(16).toString('hex');
const manifest = {
  name: process.env.APP_NAME ?? 'Grainlify Agent',
  url: 'https://github.com/Grainlify/grainlify-bounty-agent',
  description: "Grainlify's bounty agent: prices and posts bounties on issues, reviews pull requests, and pays contributors on Solana after a maintainer merges.",
  hook_attributes: { url: webhookUrl, active: true },
  redirect_url: `http://127.0.0.1:${PORT}/callback`,
  // Installable only on the Grainlify org.
  public: false,
  default_permissions: {
    metadata: 'read',
    contents: 'read', // read diffs
    issues: 'write', // bounty comments
    pull_requests: 'write', // post reviews
    checks: 'read', // CI state for the review
    statuses: 'read',
  },
  default_events: ['issues', 'issue_comment', 'pull_request', 'pull_request_review'],
};

const page = `<!doctype html><meta charset="utf-8"><title>Create Grainlify Agent</title>
<body style="font:16px system-ui;max-width:640px;margin:48px auto;padding:0 16px">
<h1>Create the Grainlify Agent GitHub App</h1>
<p>This sends the App definition to GitHub for the <b>${ORG}</b> organization. GitHub then asks you to confirm.</p>
<form action="https://github.com/organizations/${ORG}/settings/apps/new?state=${state}" method="post">
<input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, '&#39;')}'>
<button type="submit" style="font-size:18px;padding:10px 20px">Continue to GitHub</button>
</form></body>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(page);
  }
  if (url.pathname === '/callback') {
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400);
      return res.end('state mismatch; start again');
    }
    const code = url.searchParams.get('code');
    const r = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, { method: 'POST', headers: { accept: 'application/vnd.github+json' } });
    if (!r.ok) {
      res.writeHead(502);
      return res.end(`GitHub conversion failed: ${r.status} ${await r.text()}`);
    }
    const app = (await r.json()) as { id: number; slug: string; html_url: string; pem: string; webhook_secret: string; client_id: string; client_secret: string };
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    writeFileSync(outFile, JSON.stringify({ id: app.id, slug: app.slug, html_url: app.html_url, client_id: app.client_id, client_secret: app.client_secret, webhook_secret: app.webhook_secret, webhook_url: webhookUrl }, null, 2), { mode: 0o600 });
    writeFileSync(join(outDir, 'github-app.private-key.pem'), app.pem, { mode: 0o600 });
    chmodSync(outFile, 0o600);
    console.log(`Created App ${app.slug} (id ${app.id}). Credentials saved to ${outDir}.`);
    res.writeHead(302, { location: `https://github.com/apps/${app.slug}/installations/new` });
    res.end();
    setTimeout(() => server.close(), 500);
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => console.log(`Open http://127.0.0.1:${PORT}/ and click "Continue to GitHub".`));
