// Switching bounties on for a repository from the admin screen.
// Needs TEST_DATABASE_URL.

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../../../packages/db/src/testing.ts';
import { p2Config } from '../src/config.ts';
import { BountyService } from '../src/service.ts';
import { FakeGitHub } from './fake-github.ts';

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)('switching bounties on for a repository', () => {
  let db: pg.Pool;
  let gh: FakeGitHub;
  let service: BountyService;

  beforeAll(async () => {
    db = await freshDatabase(dbUrl!, 'test_repo_bounties');
  });
  beforeEach(async () => {
    gh = new FakeGitHub();
    await db.query('TRUNCATE repo_bounty_audit, repos CASCADE');
    const cfg = p2Config({ mints: { USDC: { mint: 'MintUSDC', decimals: 6 } }, trustedApprovers: [] });
    service = new BountyService({ db, gh, x402: undefined as never, payoutSigner: {} as never, cfg, now: () => new Date() });
  });
  afterAll(async () => {
    await db?.end();
  });

  // The admin screen lists Grainlify's verified projects. This service knew
  // about one repository, so every row on that screen failed to switch on with
  // repo_not_allowlisted - and the refusal named a CLI command an admin has no
  // way to run.
  it('allowlists a repository it has never heard of, rather than refusing', async () => {
    const r = await service.setRepoBounties('Grainlify/brand-new', {
      enabled: true,
      registeredProject: true,
      changedBy: 'Jagadeeshftw',
    });
    expect(r.ok).toBe(true);

    const row = await db.query<{ enabled: boolean; bounties_enabled: boolean; registered_project: boolean; installation_id: string }>(
      `SELECT enabled, bounties_enabled, registered_project, installation_id FROM repos WHERE lower(owner)='grainlify' AND lower(name)='brand-new'`,
    );
    expect(row.rows[0]).toMatchObject({ enabled: true, bounties_enabled: true, registered_project: true });
    // The installation id came from GitHub, which is the whole check.
    expect(row.rows[0]?.installation_id).toBeTruthy();
  });

  // Allowlisting on demand is not a weaker check: addRepo asks GitHub for the
  // installation, and a repository the App is not on has none.
  it('still refuses a repository the GitHub App is not installed on', async () => {
    gh.installationIdFor = async () => {
      throw new Error('404 Not Found: /repos/Grainlify/not-ours/installation');
    };
    await expect(
      service.setRepoBounties('Grainlify/not-ours', { enabled: true, registeredProject: true, changedBy: 'Jagadeeshftw' }),
    ).rejects.toThrow();

    const row = await db.query(`SELECT 1 FROM repos WHERE lower(name)='not-ours'`);
    expect(row.rowCount).toBe(0);
  });

  // Turning off something we never knew about is already true. Reporting an
  // error would leave the screen claiming a failure while showing the state
  // the admin asked for.
  it('treats switching off an unknown repository as already done', async () => {
    const r = await service.setRepoBounties('Grainlify/never-seen', {
      enabled: false,
      registeredProject: true,
      changedBy: 'Jagadeeshftw',
    });
    expect(r).toMatchObject({ ok: true, bountiesEnabled: false });
    const row = await db.query(`SELECT 1 FROM repos WHERE lower(name)='never-seen'`);
    expect(row.rowCount).toBe(0);
  });

  it('records who switched it on', async () => {
    await service.setRepoBounties('Grainlify/audited', { enabled: true, registeredProject: true, changedBy: 'Jagadeeshftw' });
    const a = await db.query<{ full_name: string; bounties_enabled: boolean; changed_by: string }>(
      `SELECT full_name, bounties_enabled, changed_by FROM repo_bounty_audit ORDER BY id DESC LIMIT 1`,
    );
    expect(a.rows[0]).toMatchObject({ bounties_enabled: true, changed_by: 'Jagadeeshftw' });
  });

  it('turning it off again leaves the repository allowlisted but not bountiable', async () => {
    await service.setRepoBounties('Grainlify/on-then-off', { enabled: true, registeredProject: true, changedBy: 'a' });
    await service.setRepoBounties('Grainlify/on-then-off', { enabled: false, registeredProject: true, changedBy: 'a' });
    const row = await db.query<{ enabled: boolean; bounties_enabled: boolean }>(
      `SELECT enabled, bounties_enabled FROM repos WHERE lower(name)='on-then-off'`,
    );
    expect(row.rows[0]).toMatchObject({ enabled: true, bounties_enabled: false });
  });
});
