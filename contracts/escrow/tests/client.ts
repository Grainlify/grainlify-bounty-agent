// The escrow's wire format lives with the agent that speaks it, so there is one
// implementation rather than two that drift. The tests import it from there on
// purpose: what they exercise is the same code the product sends.
export * from '../../../apps/agent/src/escrow-ix.ts';
