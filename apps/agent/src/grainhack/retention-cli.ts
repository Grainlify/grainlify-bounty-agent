// `pnpm cli retention --dry-run`: what one pass of the GrainHack retention job
// (retention.ts) would remove now, and nothing else.
//
// There is no real run here. The pass runs only inside the agent process, and
// only when RETENTION_JOB_ENABLED is exactly "true"; this command refuses to
// run without --dry-run, so the obvious command can never be the one that
// deletes. It needs only DATABASE_URL, opens its connection with
// default_transaction_read_only on, reads inside BEGIN ... READ ONLY, and does
// not migrate: it can be read against the production database before the job
// is switched on there.

import pg from 'pg';
import { dryRunText, retentionDryRun } from './retention.ts';

export async function retentionCli(args: string[], env: Record<string, string | undefined> = process.env): Promise<void> {
  if (args.length !== 1 || args[0] !== '--dry-run') {
    console.error('refusing to run: this command only does the dry run (retention --dry-run).\n' +
      'The retention pass itself runs only in the agent process, when RETENTION_JOB_ENABLED=true.');
    process.exitCode = 2;
    return;
  }
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = new pg.Pool({ connectionString: url, max: 1, options: '-c default_transaction_read_only=on', application_name: 'retention-dry-run' });
  try {
    const { ids: _ids, ...rep } = await retentionDryRun(db);
    process.stdout.write(dryRunText(rep));
    console.log('\n--- JSON ---');
    console.log(JSON.stringify(rep, null, 2));
  } finally {
    await db.end();
  }
}
