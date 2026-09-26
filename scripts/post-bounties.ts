// Posts the drafted bounty issues from the Grainlify Agent App, then allowlists
// the repo so the end-to-end flow works. Idempotent: it refuses to post a second
// issue with the same title.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import pg from 'pg';
import { GitHubAppClient } from '../apps/agent/src/github.ts';

const cfgDir = `${homedir()}/.config/grainlify-bounty-agent`;
const app = JSON.parse(readFileSync(`${cfgDir}/github-app.json`, 'utf8')) as { id: number; slug: string };
const pem = readFileSync(`${cfgDir}/github-app.private-key.pem`, 'utf8');
const gh = new GitHubAppClient(app.id, pem) as unknown as {
  installationIdFor(repo: string): Promise<number>;
  repoReq(repo: string, method: string, path: string, body?: unknown): Promise<unknown>;
};

const REPO = process.env.BOUNTY_REPO ?? 'Grainlify/grainlify-bounty-agent';
const inst = await gh.installationIdFor(REPO);
console.log(`app ${app.slug} (id ${app.id}) installed on ${REPO} as installation ${inst}`);

const issues = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as { title: string; body: string; labels: string[] }[];

const existing = (await gh.repoReq(REPO, 'GET', `/repos/${REPO}/issues?state=all&per_page=100`)) as { title: string; html_url: string }[];
const seen = new Set(existing.map((i) => i.title));

const posted: { title: string; url: string; number: number }[] = [];
for (const i of issues) {
  if (seen.has(i.title)) { console.log(`  SKIP (already exists): ${i.title}`); continue; }
  const r = (await gh.repoReq(REPO, 'POST', `/repos/${REPO}/issues`, i)) as { number: number; html_url: string };
  console.log(`  posted #${r.number}: ${r.html_url}`);
  posted.push({ title: i.title, url: r.html_url, number: r.number });
}

if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const [owner, name] = REPO.split('/');
  await pool.query(
    `INSERT INTO repos (owner, name, installation_id, enabled) VALUES ($1,$2,$3,true)
     ON CONFLICT (owner, name) DO UPDATE SET installation_id = EXCLUDED.installation_id, enabled = true`,
    [owner, name, inst],
  );
  const r = await pool.query(`SELECT owner, name, installation_id, enabled FROM repos WHERE owner=$1 AND name=$2`, [owner, name]);
  console.log('allowlist:', JSON.stringify(r.rows[0]));
  await pool.end();
}
console.log(`\n${posted.length} issue(s) posted.`);
