// Gives each test file its own freshly migrated database, so files can run in parallel.

import pg from 'pg';
import { migrate } from './pg.ts';

export async function freshDatabase(baseUrl: string, name: string): Promise<pg.Pool> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error('test database name must be [a-z0-9_]');
  const admin = new pg.Pool({ connectionString: baseUrl, max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 20 });
  await migrate(pool);
  return pool;
}
