import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderX402ErrorDoc, type X402ErrorsFixture } from '../../../scripts/generate-x402-errors-doc.ts';

const fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/usepod/x402-errors.json', import.meta.url), 'utf8'),
) as X402ErrorsFixture;

const committed = readFileSync(new URL('../../../docs/X402-ERRORS.md', import.meta.url), 'utf8');

describe('x402 error reference doc', () => {
  it('is up to date with the fixture', () => {
    expect(committed).toBe(renderX402ErrorDoc(fixture));
  });

  it('gives every error its status, provenance and message', () => {
    for (const [id, error] of Object.entries(fixture.errors)) {
      expect(committed).toContain(`| \`${id}\` | ${error.status} |`);
      expect(committed).toContain(error.provenance);
      expect(committed).toContain(error.message);
    }
  });

  it('marks a defensive guess differently from a measured fact', () => {
    expect(committed).toContain('| `quote_expired` | 400 | `bad_request` | assumed |');
    expect(committed).toContain('| `tx_not_found` | 400 | `bad_request` | observed |');
  });
});
