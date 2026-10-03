// Test-only: the backend's golden results statements, from the copy in testdata.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GoldenFile {
  domain: string;
  signing_key_seed_b64: string;
  public_key_b64: string;
  vectors: { name: string; statement: string; statement_sha256: string; signature_b64: string }[];
}

export const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'testdata/grainhack_results_golden.json'), 'utf8')) as GoldenFile;
