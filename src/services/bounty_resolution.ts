// scripts/generate-x402-docs.ts
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

interface X402Error {
  status: number;
  message: string;
  provenance: 'observed' | 'assumed';
}

const FIXTURE_PATH = resolve(__dirname, '../fixtures/usepod/x402-errors.json');
const OUTPUT_PATH = resolve(__dirname, '../docs/X402-ERRORS.md');

function generateDocs() {
  const data: X402Error[] = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));

  const lines = [
    '# UsePod X402 Error Reference',
    '',
    '> [!IMPORTANT]',
    '> This document is auto-generated from `fixtures/usepod/x402-errors.json`. Do not edit manually.',
    '',
    '| Status | Provenance | Message |',
    '| :--- | :--- | :--- |',
    ...data.map(err => `| ${err.status} | \`${err.provenance}\` | ${err.message} |`),
  ];

  writeFileSync(OUTPUT_PATH, lines.join('\n'));
}

generateDocs();

// Add this to your package.json scripts to ensure verification:
// "check:docs": "ts-node scripts/generate-x402-docs.ts && git diff --exit-code docs/X402-ERRORS.md"

// Ensure the CI test runs this check:
// test:
//   - pnpm typecheck
//   - pnpm check:docs