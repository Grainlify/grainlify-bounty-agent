import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateX402ErrorsDoc, type UsePodErrorsFixture } from '../../../scripts/generate-x402-errors.ts';

const ROOT_DIR = resolve(__dirname, '../../..');

describe('x402 errors doc generator', () => {
  const fixturePath = resolve(ROOT_DIR, 'fixtures/usepod/x402-errors.json');
  const docPath = resolve(ROOT_DIR, 'docs/X402-ERRORS.md');

  it('committed doc is up to date with fixtures/usepod/x402-errors.json', () => {
    const rawFixture = readFileSync(fixturePath, 'utf8');
    const fixture = JSON.parse(rawFixture) as UsePodErrorsFixture;
    const expected = generateX402ErrorsDoc(fixture);
    const actual = readFileSync(docPath, 'utf8');

    expect(actual, 'docs/X402-ERRORS.md is out of date with fixtures/usepod/x402-errors.json. Run `npx tsx scripts/generate-x402-errors.ts` to regenerate.').toBe(expected);
  });

  it('includes every error key, status, provenance, and message from the fixture', () => {
    const rawFixture = readFileSync(fixturePath, 'utf8');
    const fixture = JSON.parse(rawFixture) as UsePodErrorsFixture;
    const doc = readFileSync(docPath, 'utf8');

    for (const [key, err] of Object.entries(fixture.errors)) {
      expect(doc).toContain(`\`${key}\``);
      expect(doc).toContain(`\`${err.status}\``);
      expect(doc).toContain(`\`${err.provenance}\``);
      expect(doc).toContain(err.message);
    }
  });

  it('preserves exact provenance distinction between observed and assumed', () => {
    const rawFixture = readFileSync(fixturePath, 'utf8');
    const fixture = JSON.parse(rawFixture) as UsePodErrorsFixture;

    const observedCount = Object.values(fixture.errors).filter(e => e.provenance.includes('observed')).length;
    const assumedCount = Object.values(fixture.errors).filter(e => e.provenance.includes('assumed')).length;

    expect(observedCount).toBeGreaterThan(0);
    expect(assumedCount).toBeGreaterThan(0);
  });
});
