// A small GitHub App client: App JWT, cached installation tokens, and the
// handful of REST/GraphQL calls the agent needs. Facts used by the payout
// gate are always read fresh from here, never from a webhook payload.

import { createSign } from 'node:crypto';
import type { RepoPermission } from '../../../packages/gate/src/gate.ts';

export interface PullInfo {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  mergedByLogin: string | null;
  mergedAt: string | null;
  authorId: number;
  authorLogin: string;
  authorType: string;
  headSha: string;
  title: string;
  body: string;
}

export interface UserInfo {
  id: number;
  login: string;
  type: string;
  createdAt: Date;
}

export type CiState = 'success' | 'failure' | 'pending' | 'none';

export interface GitHubApi {
  installationIdFor(repo: string): Promise<number>;
  getIssue(repo: string, n: number): Promise<{ number: number; title: string; body: string; state: string; authorLogin: string }>;
  getPull(repo: string, n: number): Promise<PullInfo>;
  getPullDiff(repo: string, n: number, maxChars: number): Promise<string>;
  closingIssues(repo: string, prNumber: number): Promise<number[]>;
  /** Read with the repo's installation token (higher rate limit than anonymous). */
  getUser(repo: string, login: string): Promise<UserInfo>;
  permission(repo: string, login: string): Promise<RepoPermission>;
  ciState(repo: string, sha: string): Promise<CiState>;
  comment(repo: string, issueNumber: number, body: string): Promise<{ id: number; url: string }>;
  review(repo: string, prNumber: number, commitSha: string, body: string): Promise<{ id: number }>;
  /**
   * Public evidence about one contributor, for the fit assessment.
   *
   * Everything here is on their GitHub profile already. Note what is NOT
   * gathered: followers, stars, total commits, total contributions. They are
   * not fetched rather than fetched-and-ignored, so no later change can
   * quietly start weighting them.
   */
  contributorEvidence(repo: string, login: string, issueLanguage: string): Promise<ContributorEvidence>;
}

export interface ContributorEvidence {
  account_age_days: number;
  public_repo_count: number;
  languages: { lang: string; bytes: number; repo_count: number }[];
  recent_repos: { name: string; description: string; language: string; last_commit: string }[];
  sample_diffs: { repo: string; title: string; diff: string }[];
  /** Set when something could not be read, so a thin snapshot is explainable. */
  note?: string;
}

export class GitHubAppClient implements GitHubApi {
  private tokens = new Map<number, { token: string; expiresAt: number }>();
  private installations = new Map<string, number>();

  constructor(private readonly appId: number, private readonly privateKeyPem: string, private readonly f: typeof fetch = fetch) {}

  appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 540, iss: this.appId })}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(this.privateKeyPem).toString('base64url');
    return `${unsigned}.${sig}`;
  }

  async installationIdFor(repo: string) {
    const cached = this.installations.get(repo);
    if (cached) return cached;
    const r = await this.req('GET', `/repos/${repo}/installation`, undefined, `Bearer ${this.appJwt()}`);
    const id = (r as { id: number }).id;
    this.installations.set(repo, id);
    return id;
  }

  private async token(repo: string): Promise<string> {
    const inst = await this.installationIdFor(repo);
    const c = this.tokens.get(inst);
    if (c && c.expiresAt - 5 * 60_000 > Date.now()) return c.token;
    const r = (await this.req('POST', `/app/installations/${inst}/access_tokens`, undefined, `Bearer ${this.appJwt()}`)) as { token: string; expires_at: string };
    this.tokens.set(inst, { token: r.token, expiresAt: Date.parse(r.expires_at) });
    return r.token;
  }

  private async req(method: string, path: string, body?: unknown, auth?: string, accept = 'application/vnd.github+json'): Promise<unknown> {
    const r = await this.f(`https://api.github.com${path}`, {
      method,
      headers: { accept, 'user-agent': 'grainlify-agent', 'x-github-api-version': '2022-11-28', ...(auth ? { authorization: auth } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`GitHub ${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
    return accept.includes('diff') ? text : text ? JSON.parse(text) : null;
  }

  private async repoReq(repo: string, method: string, path: string, body?: unknown, accept?: string) {
    return this.req(method, path, body, `token ${await this.token(repo)}`, accept);
  }

  async getIssue(repo: string, n: number) {
    const i = (await this.repoReq(repo, 'GET', `/repos/${repo}/issues/${n}`)) as { number: number; title: string; body: string | null; state: string; user: { login: string } };
    return { number: i.number, title: i.title, body: i.body ?? '', state: i.state, authorLogin: i.user.login };
  }

  async getPull(repo: string, n: number): Promise<PullInfo> {
    const p = (await this.repoReq(repo, 'GET', `/repos/${repo}/pulls/${n}`)) as {
      number: number; state: 'open' | 'closed'; merged: boolean; merged_by: { login: string } | null; merged_at: string | null;
      user: { id: number; login: string; type: string }; head: { sha: string }; title: string; body: string | null;
    };
    return {
      number: p.number, state: p.state, merged: p.merged === true, mergedByLogin: p.merged_by?.login ?? null, mergedAt: p.merged_at,
      authorId: p.user.id, authorLogin: p.user.login, authorType: p.user.type, headSha: p.head.sha, title: p.title, body: p.body ?? '',
    };
  }

  async getPullDiff(repo: string, n: number, maxChars: number) {
    const d = (await this.repoReq(repo, 'GET', `/repos/${repo}/pulls/${n}`, undefined, 'application/vnd.github.diff')) as string;
    return d.length > maxChars ? `${d.slice(0, maxChars)}\n[diff truncated at ${maxChars} characters]` : d;
  }

  async closingIssues(repo: string, prNumber: number) {
    const [owner, name] = repo.split('/');
    const q = `query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){closingIssuesReferences(first:20){nodes{number repository{nameWithOwner}}}}}}`;
    const r = (await this.repoReq(repo, 'POST', '/graphql', { query: q, variables: { o: owner, n: name, p: prNumber } })) as {
      data?: { repository?: { pullRequest?: { closingIssuesReferences?: { nodes: { number: number; repository: { nameWithOwner: string } }[] } } } };
      errors?: unknown[];
    };
    if (r.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(r.errors).slice(0, 300)}`);
    const nodes = r.data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [];
    // Same-repository issues only: a PR here can't claim a bounty elsewhere.
    return nodes.filter((x) => x.repository.nameWithOwner.toLowerCase() === repo.toLowerCase()).map((x) => x.number);
  }

  async getUser(repo: string, login: string): Promise<UserInfo> {
    const u = (await this.repoReq(repo, 'GET', `/users/${encodeURIComponent(login)}`)) as {
      id: number; login: string; type: string; created_at: string;
    };
    return { id: u.id, login: u.login, type: u.type, createdAt: new Date(u.created_at) };
  }

  async permission(repo: string, login: string): Promise<RepoPermission> {
    const r = (await this.repoReq(repo, 'GET', `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`)) as { permission: string; role_name?: string };
    const role = r.role_name ?? r.permission;
    return (['admin', 'maintain', 'write', 'triage', 'read'].includes(role) ? role : r.permission === 'none' ? 'none' : 'read') as RepoPermission;
  }

  async contributorEvidence(repo: string, login: string, issueLanguage: string): Promise<ContributorEvidence> {
    const user = await this.getUser(repo, login);
    const ageDays = Math.floor((Date.now() - user.createdAt.getTime()) / 86_400_000);
    const out: ContributorEvidence = {
      account_age_days: ageDays,
      public_repo_count: 0,
      languages: [],
      recent_repos: [],
      sample_diffs: [],
    };

    let repos: { name: string; description: string | null; language: string | null; pushed_at: string; fork: boolean }[] = [];
    try {
      repos = (await this.repoReq(repo, 'GET', `/users/${encodeURIComponent(login)}/repos?sort=pushed&per_page=30`)) as typeof repos;
    } catch {
      // A profile we cannot read is not a profile with nothing in it, and the
      // prompt is told not to punish absence. Recording why keeps those two
      // cases apart for anyone reading the assessment later.
      out.note = 'public repositories could not be read';
      return out;
    }
    const own = repos.filter((r) => !r.fork);
    out.public_repo_count = own.length;

    // Language rollup from repo primaries: one field already present on each
    // repo, rather than a /languages call per repo. Byte counts are not
    // available that cheaply, so repo_count carries the signal and bytes stays
    // 0 - honest about what was measured rather than inventing a number.
    const byLang = new Map<string, number>();
    for (const r of own) if (r.language) byLang.set(r.language, (byLang.get(r.language) ?? 0) + 1);
    out.languages = [...byLang.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([lang, repo_count]) => ({ lang, bytes: 0, repo_count }));

    out.recent_repos = own.slice(0, 6).map((r) => ({
      name: r.name,
      description: (r.description ?? '').slice(0, 200),
      language: r.language ?? '',
      last_commit: r.pushed_at,
    }));

    // §4.3: "up to 3 merged PRs matching the issue language, truncated to 200
    // lines each".
    try {
      const q = `is:pr is:merged author:${login}${issueLanguage ? ` language:${issueLanguage}` : ''}`;
      const found = (await this.repoReq(repo, 'GET', `/search/issues?q=${encodeURIComponent(q)}&sort=updated&per_page=3`)) as {
        items: { title: string; repository_url: string; number: number }[];
      };
      for (const item of (found.items ?? []).slice(0, 3)) {
        const full = item.repository_url.replace('https://api.github.com/repos/', '');
        const diff = await this.getPullDiff(full, item.number, 20_000).catch(() => '');
        if (!diff) continue;
        out.sample_diffs.push({ repo: full, title: item.title, diff: diff.split('\n').slice(0, 200).join('\n') });
      }
    } catch {
      // Search is the flakiest call here and the least essential: the
      // languages and repos already say most of what the prompt needs.
      out.note = out.note ? `${out.note}; merged pull requests could not be searched` : 'merged pull requests could not be searched';
    }
    return out;
  }

  async ciState(repo: string, sha: string): Promise<CiState> {
    const [status, checks] = await Promise.all([
      this.repoReq(repo, 'GET', `/repos/${repo}/commits/${sha}/status`) as Promise<{ state: string; total_count: number }>,
      this.repoReq(repo, 'GET', `/repos/${repo}/commits/${sha}/check-runs`) as Promise<{ total_count: number; check_runs: { status: string; conclusion: string | null }[] }>,
    ]);
    const runs = checks.check_runs ?? [];
    if (status.total_count === 0 && runs.length === 0) return 'none';
    if (status.state === 'failure' || status.state === 'error' || runs.some((c) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(c.conclusion ?? ''))) return 'failure';
    if ((status.total_count > 0 && status.state === 'pending') || runs.some((c) => c.status !== 'completed')) return 'pending';
    return 'success';
  }

  async comment(repo: string, issueNumber: number, body: string) {
    const c = (await this.repoReq(repo, 'POST', `/repos/${repo}/issues/${issueNumber}/comments`, { body })) as { id: number; html_url: string };
    return { id: c.id, url: c.html_url };
  }

  async review(repo: string, prNumber: number, commitSha: string, body: string) {
    // COMMENT only. The agent never approves a PR: merge is a maintainer's decision.
    const r = (await this.repoReq(repo, 'POST', `/repos/${repo}/pulls/${prNumber}/reviews`, { commit_id: commitSha, event: 'COMMENT', body })) as { id: number };
    return { id: r.id };
  }
}
