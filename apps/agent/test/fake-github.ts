// An in-memory GitHub for tests: just enough state to drive the bounty loop.

import type { RepoPermission } from '../../../packages/gate/src/gate.ts';
import type { CiState, GitHubApi, PullInfo, UserInfo } from '../src/github.ts';

export class FakeGitHub implements GitHubApi {
  issues = new Map<string, { number: number; title: string; body: string; state: string; authorLogin: string }>();
  pulls = new Map<string, PullInfo & { closes: number[]; diff: string }>();
  users = new Map<string, UserInfo>();
  permissions = new Map<string, RepoPermission>();
  comments: { repo: string; issue: number; body: string }[] = [];
  reviews: { repo: string; pr: number; sha: string; body: string }[] = [];
  failUserLookup = false;
  private nextId = 1000;

  key = (repo: string, n: number) => `${repo.toLowerCase()}#${n}`;

  async installationIdFor() {
    return 42;
  }
  async getIssue(repo: string, n: number) {
    const i = this.issues.get(this.key(repo, n));
    if (!i) throw new Error(`no issue ${repo}#${n}`);
    return i;
  }
  async getPull(repo: string, n: number) {
    const p = this.pulls.get(this.key(repo, n));
    if (!p) throw new Error(`no PR ${repo}#${n}`);
    const { closes: _c, diff: _d, ...info } = p;
    return { ...info };
  }
  async getPullDiff(repo: string, n: number) {
    return this.pulls.get(this.key(repo, n))!.diff;
  }
  async closingIssues(repo: string, n: number) {
    return this.pulls.get(this.key(repo, n))?.closes ?? [];
  }
  async getUser(_repo: string, login: string) {
    if (this.failUserLookup) throw new Error('GitHub 502');
    const u = this.users.get(login.toLowerCase());
    if (!u) throw new Error(`no user ${login}`);
    return u;
  }
  async permission(repo: string, login: string): Promise<RepoPermission> {
    return this.permissions.get(`${repo.toLowerCase()}:${login.toLowerCase()}`) ?? 'read';
  }
  async ciState(): Promise<CiState> {
    return 'success';
  }
  async comment(repo: string, issue: number, body: string) {
    this.comments.push({ repo, issue, body });
    return { id: ++this.nextId, url: `https://github.com/${repo}/issues/${issue}#issuecomment-${this.nextId}` };
  }
  async review(repo: string, pr: number, sha: string, body: string) {
    this.reviews.push({ repo, pr, sha, body });
    return { id: ++this.nextId };
  }

  addUser(login: string, id: number, createdAt: string, type = 'User') {
    this.users.set(login.toLowerCase(), { id, login, type, createdAt: new Date(createdAt) });
  }
}
