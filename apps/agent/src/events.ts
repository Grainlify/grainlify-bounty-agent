// Telling a contributor what happened to them.
//
// This service knows the facts - who won a draw, whose assignment is about to
// lapse, who was paid - and owns none of the machinery for saying so. Email,
// in-app notifications and a person's preferences all live in Grainlify. So
// events are written here and delivered there.
//
// Why an outbox and not an HTTP call at the point of the event:
//
//   Duplicates. A draw can be re-run and the stale sweep runs every minute.
//   dedupe_key is UNIQUE, so the same event enqueued a hundred times exists
//   once. Doing this with retry logic instead would put the burden on every
//   emitter, and the one that got it wrong would be found by somebody
//   receiving the same email six times.
//
//   Failure. The backend can be down or mid-deploy. A draw must not fail
//   because a notification could not be sent, and the notification must not
//   be lost because the draw succeeded.

import type pg from 'pg';

export type EventKind =
  | 'bounty_application_received'
  | 'bounty_draw_won'
  | 'bounty_draw_lost'
  | 'bounty_assignment_expiring'
  | 'bounty_review_posted'
  | 'bounty_unassigned'
  | 'bounty_deadline_changed'
  | 'bounty_paid'
  // Funded bounties: assigned by the funder rather than drawn, and the
  // two-sided unassignment once a pull request is open.
  | 'bounty_funded_assigned'
  | 'bounty_unassign_proposed'
  | 'bounty_unassign_refused';

export interface BountyEvent {
  kind: EventKind;
  githubUserId: number;
  /** What makes this event this event; the uniqueness is the idempotency. */
  dedupeKey: string;
  payload: Record<string, unknown>;
}

/**
 * Enqueues an event, or does nothing if it is already there.
 *
 * Never throws. An emitter is always in the middle of something that matters
 * more - assigning a bounty, recording a payment - and a notification that
 * cannot be queued must not take that down with it.
 */
export async function enqueueEvent(db: pg.Pool, e: BountyEvent): Promise<boolean> {
  try {
    const r = await db.query(
      `INSERT INTO bounty_events (kind, github_user_id, payload, dedupe_key)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [e.kind, e.githubUserId, JSON.stringify(e.payload), e.dedupeKey],
    );
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    console.log(`event enqueue failed, continuing: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** The dedupe keys, in one place so two emitters cannot disagree about what
 *  counts as the same event. */
export const dedupe = {
  applicationReceived: (bountyId: string, githubUserId: number) => `application_received:${bountyId}:${githubUserId}`,
  drawWon: (bountyId: string, drawId: string) => `draw_won:${bountyId}:${drawId}`,
  drawLost: (bountyId: string, drawId: string, githubUserId: number) => `draw_lost:${bountyId}:${drawId}:${githubUserId}`,
  // Keyed to the assignment, not to the time, so a sweep running every minute
  // for three days sends one warning rather than four thousand.
  assignmentExpiring: (assignmentId: string) => `assignment_expiring:${assignmentId}`,
  reviewPosted: (bountyId: string, prNumber: number) => `review_posted:${bountyId}:${prNumber}`,
  paid: (payoutId: string) => `paid:${payoutId}`,
  // Keyed to the assignment: one unassignment is one message, however many
  // times a retry re-enqueues it.
  unassigned: (assignmentId: string) => `unassigned:${assignmentId}`,
  // A separate key: somebody already told their assignment ended can later be
  // told the round closed, and the unassigned key would swallow that.
  roundClosed: (assignmentId: string) => `round_closed:${assignmentId}`,
  // Keyed to the assignment AND the new deadline, so moving a deadline twice
  // tells the contributor twice, and moving it to the same value does not.
  deadlineChanged: (assignmentId: string, newAt: string) => `deadline_changed:${assignmentId}:${newAt}`,
  fundedAssigned: (assignmentId: string) => `funded_assigned:${assignmentId}`,
  // Keyed to the proposal: one proposal, one message to the other side.
  unassignProposed: (proposalId: string) => `unassign_proposed:${proposalId}`,
  unassignRefused: (proposalId: string) => `unassign_refused:${proposalId}`,
};
