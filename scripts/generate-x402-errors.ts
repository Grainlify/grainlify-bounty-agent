import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');

export interface X402ErrorItem {
  status: number;
  type: string;
  message: string;
  provenance: string;
}

export interface BalanceEnvelope {
  provenance: string;
  header: string;
  json: Record<string, unknown>;
  check_order: string[];
  gotcha: string;
}

export interface UsePodErrorsFixture {
  captured_at: string;
  endpoint: string;
  note: string;
  errors: Record<string, X402ErrorItem>;
  balance_envelope?: BalanceEnvelope;
}

export function generateX402ErrorsDoc(fixture: UsePodErrorsFixture): string {
  const lines: string[] = [];

  lines.push('# UsePod x402 Gateway Error Reference');
  lines.push('');
  lines.push('<!-- Generated automatically by scripts/generate-x402-errors.ts from fixtures/usepod/x402-errors.json. Do not edit directly. -->');
  lines.push('');
  lines.push(`- **Endpoint**: \`${fixture.endpoint}\``);
  lines.push(`- **Captured At**: \`${fixture.captured_at}\``);
  lines.push(`- **Provenance Guide**: ${fixture.note}`);
  lines.push('');
  lines.push('## Provenance Definitions');
  lines.push('');
  lines.push('- **`observed`**: Direct measurement returned by the live gateway to an unpaid probe (cost $0). Established fact.');
  lines.push('- **`assumed`**: Defensive handling in mock/client logic; not yet confirmed live from the gateway.');
  lines.push('');
  lines.push('## Error Catalog');
  lines.push('');
  lines.push('| Error Key | HTTP Status | Type | Provenance | Error Message |');
  lines.push('| :--- | :--- | :--- | :--- | :--- |');

  for (const [key, err] of Object.entries(fixture.errors)) {
    const escapedMsg = err.message.replace(/\|/g, '\\|');
    lines.push(`| \`${key}\` | \`${err.status}\` | \`${err.type}\` | \`${err.provenance}\` | \`${escapedMsg}\` |`);
  }

  lines.push('');
  lines.push('## Error Details');
  lines.push('');

  for (const [key, err] of Object.entries(fixture.errors)) {
    lines.push(`### \`${key}\``);
    lines.push(`- **HTTP Status**: ${err.status}`);
    lines.push(`- **Error Type**: \`${err.type}\``);
    lines.push(`- **Provenance**: \`${err.provenance}\``);
    lines.push(`- **Message**: \`${err.message}\``);
    lines.push('');
  }

  if (fixture.balance_envelope) {
    const env = fixture.balance_envelope;
    lines.push('## Balance Envelope Specification');
    lines.push('');
    lines.push(`- **Provenance**: ${env.provenance}`);
    lines.push(`- **Header Format**: \`${env.header}\``);
    lines.push('');
    lines.push('### Required Payload');
    lines.push('```json');
    lines.push(JSON.stringify(env.json, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('### Verification Order');
    for (let i = 0; i < env.check_order.length; i++) {
      lines.push(`${i + 1}. ${env.check_order[i]}`);
    }
    lines.push('');
    lines.push('### Implementation Note');
    lines.push(`> **Gotcha**: ${env.gotcha}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function runGenerator(): void {
  const fixturePath = resolve(ROOT_DIR, 'fixtures/usepod/x402-errors.json');
  const docPath = resolve(ROOT_DIR, 'docs/X402-ERRORS.md');

  const raw = readFileSync(fixturePath, 'utf8');
  const fixture = JSON.parse(raw) as UsePodErrorsFixture;
  const content = generateX402ErrorsDoc(fixture);

  writeFileSync(docPath, content, 'utf8');
  console.log(`Generated ${docPath} successfully from ${fixturePath}`);
}

// Execute if run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGenerator();
}
