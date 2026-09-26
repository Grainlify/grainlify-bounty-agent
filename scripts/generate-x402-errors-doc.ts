// Generates docs/X402-ERRORS.md from fixtures/usepod/x402-errors.json so the
// human-readable reference cannot drift from the recorded data.
//
// Usage: pnpm docs:x402-errors   (or: pnpm tsx scripts/generate-x402-errors-doc.ts)

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FIXTURE_PATH = new URL('../fixtures/usepod/x402-errors.json', import.meta.url);
export const DOC_PATH = new URL('../docs/X402-ERRORS.md', import.meta.url);

export interface X402Error {
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

export interface X402ErrorsFixture {
  captured_at: string;
  endpoint: string;
  note: string;
  errors: Record<string, X402Error>;
  balance_envelope?: BalanceEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`fixture is invalid: ${path} must be a non-empty string`);
  }
  return value;
}

// Defensive validation: the whole point of the generated page is the
// observed/assumed provenance marking, so refuse to render anything whose
// provenance is missing or outside that vocabulary.
export function validateFixture(data: unknown): X402ErrorsFixture {
  if (!isRecord(data)) {
    throw new Error('fixture is invalid: top level must be an object');
  }
  const captured_at = requireString(data.captured_at, 'captured_at');
  const endpoint = requireString(data.endpoint, 'endpoint');
  const note = requireString(data.note, 'note');

  if (!isRecord(data.errors) || Object.keys(data.errors).length === 0) {
    throw new Error('fixture is invalid: errors must be a non-empty object');
  }
  const errors: Record<string, X402Error> = {};
  for (const [key, raw] of Object.entries(data.errors)) {
    if (!isRecord(raw)) {
      throw new Error(`fixture is invalid: errors.${key} must be an object`);
    }
    if (typeof raw.status !== 'number' || !Number.isInteger(raw.status) || raw.status < 100 || raw.status > 599) {
      throw new Error(`fixture is invalid: errors.${key}.status must be an integer HTTP status`);
    }
    const type = requireString(raw.type, `errors.${key}.type`);
    const message = requireString(raw.message, `errors.${key}.message`);
    const provenance = requireString(raw.provenance, `errors.${key}.provenance`);
    if (!provenance.startsWith('observed') && !provenance.startsWith('assumed')) {
      throw new Error(
        `fixture is invalid: errors.${key}.provenance is "${provenance}"; expected it to start with "observed" or "assumed"`,
      );
    }
    errors[key] = { status: raw.status, type, message, provenance };
  }

  let balance_envelope: BalanceEnvelope | undefined;
  if (data.balance_envelope !== undefined) {
    const raw = data.balance_envelope;
    if (!isRecord(raw)) {
      throw new Error('fixture is invalid: balance_envelope must be an object');
    }
    const provenance = requireString(raw.provenance, 'balance_envelope.provenance');
    const header = requireString(raw.header, 'balance_envelope.header');
    const gotcha = requireString(raw.gotcha, 'balance_envelope.gotcha');
    if (!isRecord(raw.json)) {
      throw new Error('fixture is invalid: balance_envelope.json must be an object');
    }
    if (!Array.isArray(raw.check_order) || raw.check_order.some((step) => typeof step !== 'string')) {
      throw new Error('fixture is invalid: balance_envelope.check_order must be an array of strings');
    }
    balance_envelope = { provenance, header, json: raw.json, check_order: raw.check_order as string[], gotcha };
  }

  return { captured_at, endpoint, note, errors, balance_envelope };
}

export function loadFixture(path: URL = FIXTURE_PATH): X402ErrorsFixture {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new Error(`could not read or parse fixture at ${path.pathname}: ${(cause as Error).message}`);
  }
  return validateFixture(parsed);
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|');
}

export function renderDoc(fixture: X402ErrorsFixture): string {
  const entries = Object.entries(fixture.errors);
  const observed = entries.filter(([, e]) => e.provenance.startsWith('observed')).length;
  const assumed = entries.length - observed;

  const lines: string[] = [
    '# UsePod x402 error reference',
    '',
    '> GENERATED FILE — do not edit by hand. It is produced from',
    '> `fixtures/usepod/x402-errors.json` by `scripts/generate-x402-errors-doc.ts`.',
    '> Regenerate with `pnpm docs:x402-errors` after changing the fixture.',
    '',
    `Endpoint: \`${fixture.endpoint}\``,
    `Fixture captured: ${fixture.captured_at}`,
    '',
    '## Provenance',
    '',
    fixture.note,
    '',
    `${entries.length} errors recorded: ${observed} observed, ${assumed} assumed.`,
    '',
    '## Errors',
    '',
    '| Key | Status | Type | Provenance | Message |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const [key, error] of entries) {
    lines.push(
      `| \`${cell(key)}\` | ${error.status} | \`${cell(error.type)}\` | ${cell(error.provenance)} | ${cell(error.message)} |`,
    );
  }

  if (fixture.balance_envelope) {
    const envelope = fixture.balance_envelope;
    lines.push(
      '',
      '## Balance payment envelope',
      '',
      `Provenance: ${envelope.provenance}`,
      '',
      `Header: \`${envelope.header}\``,
      '',
      '```json',
      JSON.stringify(envelope.json, null, 2),
      '```',
      '',
      'Checks run in this order:',
      '',
      ...envelope.check_order.map((step, i) => `${i + 1}. ${step}`),
      '',
      `> Gotcha: ${envelope.gotcha}`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = loadFixture();
  writeFileSync(DOC_PATH, renderDoc(fixture));
  console.log(`wrote ${DOC_PATH.pathname} from ${FIXTURE_PATH.pathname}`);
}
