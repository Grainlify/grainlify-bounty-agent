import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDoc, type X402ErrorsFixture } from '../../../scripts/generate-x402-errors-doc.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, '../../..');
const FIXTURE_PATH = resolve(REPO_ROOT, 'fixtures/usepod/x402-errors.json');
const DOC_PATH = resolve(REPO_ROOT, 'docs/X402-ERRORS.md');

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

describe('x402 error reference documentation', () => {
  const fixtureRaw = readFileSync(FIXTURE_PATH, 'utf8');
  const fixture = JSON.parse(fixtureRaw) as X402ErrorsFixture;

  it('matches the committed docs/X402-ERRORS.md with fixture output (no drift)', () => {
    const committedDoc = readFileSync(DOC_PATH, 'utf8');
    const expectedDoc = renderDoc(fixture);

    expect(normalize(committedDoc)).toBe(normalize(expectedDoc));
  });

  it('contains every error with its HTTP status, exact provenance, and message', () => {
    const committedDoc = readFileSync(DOC_PATH, 'utf8');
    const entries = Object.entries(fixture.errors);

    expect(entries.length).toBe(18);

    for (const [key, err] of entries) {
      expect(committedDoc).toContain(`\`${key}\``);
      expect(committedDoc).toContain(`\`${err.status}\``);
      expect(committedDoc).toContain(`\`${err.provenance}\``);
      expect(committedDoc).toContain(`\`${err.message}\``);
    }
  });

  it('cleanly separates observed vs assumed errors', () => {
    const committedDoc = readFileSync(DOC_PATH, 'utf8');

    const observedErrors = Object.entries(fixture.errors).filter(([_, e]) => e.provenance.includes('observed'));
    const assumedErrors = Object.entries(fixture.errors).filter(([_, e]) => e.provenance.includes('assumed'));

    expect(committedDoc).toContain(`## Observed Errors (${observedErrors.length})`);
    expect(committedDoc).toContain(`## Assumed Errors (${assumedErrors.length})`);
  });

  it('detects drift when fixture errors change', () => {
    const modifiedFixture: X402ErrorsFixture = {
      ...fixture,
      errors: {
        ...fixture.errors,
        new_probe_error: {
          status: 400,
          type: 'bad_request',
          message: 'bad request: new probe error',
          provenance: 'observed',
        },
      },
    };

    const committedDoc = readFileSync(DOC_PATH, 'utf8');
    const regenerated = renderDoc(modifiedFixture);

    expect(normalize(committedDoc)).not.toBe(normalize(regenerated));
  });

  it('documents the balance envelope and gotcha if present', () => {
    if (fixture.balance_envelope) {
      const committedDoc = readFileSync(DOC_PATH, 'utf8');
      expect(committedDoc).toContain('## Balance Envelope Reference');
      expect(committedDoc).toContain(fixture.balance_envelope.header);
      expect(committedDoc).toContain(fixture.balance_envelope.gotcha);
    }
  });
});
