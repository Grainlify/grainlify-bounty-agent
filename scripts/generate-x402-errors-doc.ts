// Generates docs/X402-ERRORS.md from the recorded gateway fixture.
//
// The point of the page is the provenance split: `observed` is a fact the live
// gateway returned, `assumed` is a defensive guess the mock stands in for until
// a paid spike confirms it. The doc is generated, never hand-written, so it
// cannot drift from the data.
//
// Usage: pnpm doc:x402-errors
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface X402Error {
  status: number;
  type: string;
  message: string;
  provenance: string;
}

export interface BalanceEnvelope {
  provenance: string;
  header: string;
  json: Record<string, string>;
  check_order: string[];
  gotcha: string;
}

export interface X402ErrorsFixture {
  captured_at: string;
  endpoint: string;
  note: string;
  errors: Record<string, X402Error>;
  balance_envelope: BalanceEnvelope;
}

const FIXTURE = new URL('../fixtures/usepod/x402-errors.json', import.meta.url);
const OUTPUT = new URL('../docs/X402-ERRORS.md', import.meta.url);

const cell = (s: string) => s.replace(/\|/g, '\\|');

export function renderX402ErrorDoc(fixture: X402ErrorsFixture): string {
  const entries = Object.entries(fixture.errors);
  const assumed = entries.filter(([, e]) => e.provenance === 'assumed').length;
  const observed = entries.length - assumed;
  const env = fixture.balance_envelope;

  const lines: string[] = [];
  lines.push('# x402 error reference');
  lines.push('');
  lines.push('<!-- Generated from `fixtures/usepod/x402-errors.json` by `scripts/generate-x402-errors-doc.ts`. Do not edit by hand; run `pnpm doc:x402-errors`. -->');
  lines.push('');
  lines.push('Every error the UsePod x402 gateway is recorded as returning, with its HTTP');
  lines.push('status, its type, its message, and its provenance.');
  lines.push('');
  lines.push(`- Captured: \`${fixture.captured_at}\``);
  lines.push(`- Endpoint: \`${fixture.endpoint}\``);
  lines.push('');
  lines.push('**Provenance is the point of this page.** Read it before trusting a behaviour:');
  lines.push('');
  lines.push('- `observed` — returned live by the gateway; a measured fact.');
  lines.push('- `observed (phase-0 probe)` — seen live, from the phase-0 probe; still a measurement, not an inference.');
  lines.push('- `assumed` — not yet seen live; the mock stands in with this text until a paid spike replaces it. A defensive guess, not an established behaviour.');
  lines.push('');
  lines.push(`Recorded: ${entries.length} errors — ${observed} observed, ${assumed} assumed.`);
  lines.push('');
  lines.push('| Error | HTTP | Type | Provenance | Message |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const [id, e] of entries) {
    lines.push(`| \`${id}\` | ${e.status} | \`${e.type}\` | ${cell(e.provenance)} | ${cell(e.message)} |`);
  }
  lines.push('');
  lines.push('## Balance spend envelope');
  lines.push('');
  lines.push('The same probe got far enough to record the balance-spend request shape.');
  lines.push('');
  lines.push(`Provenance: ${env.provenance}`);
  lines.push('');
  lines.push(`Header: \`${env.header}\``);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  for (const [k, v] of Object.entries(env.json)) {
    lines.push(`| \`${k}\` | \`${cell(v)}\` |`);
  }
  lines.push('');
  lines.push('Check order:');
  lines.push('');
  env.check_order.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  lines.push('');
  lines.push(`**Gotcha:** ${env.gotcha}`);
  lines.push('');
  lines.push(`> ${fixture.note}`);
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as X402ErrorsFixture;
  writeFileSync(OUTPUT, renderX402ErrorDoc(fixture));
  console.log(`wrote docs/X402-ERRORS.md from fixtures/usepod/x402-errors.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
