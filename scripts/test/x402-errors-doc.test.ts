import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOC_PATH, loadFixture, renderDoc, validateFixture } from '../generate-x402-errors-doc.ts';

const fixture = loadFixture();
const committedDoc = readFileSync(DOC_PATH, 'utf8');

describe('docs/X402-ERRORS.md', () => {
  it('is up to date with fixtures/usepod/x402-errors.json', () => {
    // If this fails, run `pnpm docs:x402-errors` and commit the result.
    expect(committedDoc).toBe(renderDoc(fixture));
  });

  it('marks the doc as generated, not hand-written', () => {
    expect(committedDoc).toContain('GENERATED FILE — do not edit by hand');
    expect(committedDoc).toContain('fixtures/usepod/x402-errors.json');
  });

  it('lists every fixture error with its status, provenance and message', () => {
    for (const [key, error] of Object.entries(fixture.errors)) {
      expect(committedDoc).toContain(`\`${key}\``);
      expect(committedDoc).toContain(`| ${error.status} |`);
      expect(committedDoc).toContain(error.message);
    }
  });

  it('preserves each provenance marking exactly as recorded', () => {
    for (const error of Object.values(fixture.errors)) {
      expect(committedDoc).toContain(`| ${error.provenance} |`);
    }
    // The fixture records one provenance with a qualifier; it must survive verbatim.
    expect(committedDoc).toContain('observed (phase-0 probe)');
  });

  it('distinguishes observed facts from assumed fallbacks', () => {
    const provenances = Object.values(fixture.errors).map((e) => e.provenance);
    expect(provenances.some((p) => p.startsWith('observed'))).toBe(true);
    expect(provenances.some((p) => p.startsWith('assumed'))).toBe(true);
  });
});

describe('validateFixture', () => {
  it('rejects an error entry with no provenance', () => {
    expect(() =>
      validateFixture({
        captured_at: 'now',
        endpoint: 'POST https://example.com',
        note: 'n',
        errors: { broken: { status: 400, type: 'bad_request', message: 'm' } },
      }),
    ).toThrow(/provenance/);
  });

  it('rejects a provenance outside the observed/assumed vocabulary', () => {
    expect(() =>
      validateFixture({
        captured_at: 'now',
        endpoint: 'POST https://example.com',
        note: 'n',
        errors: { broken: { status: 400, type: 'bad_request', message: 'm', provenance: 'guessed' } },
      }),
    ).toThrow(/provenance/);
  });

  it('rejects a non-HTTP status', () => {
    expect(() =>
      validateFixture({
        captured_at: 'now',
        endpoint: 'POST https://example.com',
        note: 'n',
        errors: { broken: { status: '400', type: 'bad_request', message: 'm', provenance: 'observed' } },
      }),
    ).toThrow(/status/);
  });
});
