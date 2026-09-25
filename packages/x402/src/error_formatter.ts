export interface X402ErrorFixture {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function formatX402ErrorReference(fixture: X402ErrorFixture): string {
  const detailStr = fixture.details ? ` Details: ${JSON.stringify(fixture.details)}` : '';
  return `[x402 Error ${fixture.code}]: ${fixture.message}.${detailStr}`;
}
