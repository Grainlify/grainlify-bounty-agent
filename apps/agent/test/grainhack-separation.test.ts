// GrainHack stays admin-run: no self-assign, no funder controls. The funded-
// bounty code lives in this repository and GrainHack's in the backend's, so
// the separation is mostly structural; this pins the part that is not. If any
// funded-bounty source ever names GrainHack's tables or routes, this fails,
// rather than relying on someone noticing in review.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FUNDED_SOURCES = [
  'apps/agent/src/funded-service.ts',
  'apps/agent/src/escrow-service.ts',
  'apps/agent/src/escrow-ix.ts',
  'services/signer/src/payout/escrow-attestor.ts',
];

describe('funded bounties never reach GrainHack', () => {
  for (const file of FUNDED_SOURCES) {
    it(`${file} does not name GrainHack's tables or routes`, () => {
      const src = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
      expect(src).not.toMatch(/hackathon_|\/hackathons?\/|grainhack_/i);
    });
  }
});
