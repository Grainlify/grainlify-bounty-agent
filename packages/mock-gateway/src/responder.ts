// Canned model answers for the mock gateway, keyed on the task marker in the
// system prompt. Deterministic, so tests and local runs are repeatable at $0.

export function bountyResponder(_model: string, messages: unknown[]): string {
  const system = String((messages[0] as { content?: unknown } | undefined)?.content ?? '');
  if (system.includes('TASK: PRICE_BOUNTY')) {
    return JSON.stringify({ worth_funding: true, effort_hours: 2, complexity: 'small', suggested_usd: 20, rationale: 'Mock pricing: a small, well-scoped change.' });
  }
  if (system.includes('TASK: REVIEW_PR')) {
    return JSON.stringify({ verdict: 'looks_complete', summary: 'Mock review: the change addresses the issue as described.', concerns: [] });
  }
  return 'ok';
}
