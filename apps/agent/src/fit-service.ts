// Running the fit assessment: cache the evidence, buy the judgement, store it.
//
// The money path matters as much as the prompt. Every call goes through the
// same x402 client as pricing and review, tagged purpose='fit', so it is
// reserved against the same $5 lifetime ceiling and lands in the same
// receipts table. There is no second budget and no way to spend outside it:
// if the ceiling is reached, the call is refused and the applicant is
// recorded 'plausible' - a full ticket - rather than dropped.

import type pg from 'pg';
import type { X402Client } from '../../../packages/x402/src/client.ts';
import { X402_PATHS } from '../../../packages/x402/src/protocol.ts';
import { FIT_SYSTEM_PROMPT, fitUserContent, parseFit, type FitAssessment } from '../../../packages/gate/src/fit.ts';
import { boolOf } from '../../../packages/gate/src/draw-config.ts';
import type { AgentConfig } from './config.ts';
import type { ContributorEvidence, GitHubApi } from './github.ts';

/** §4.3: "refresh if older than 7 days". */
export const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long the fit call may take before it is abandoned and the applicant is
 * given 'plausible'.
 *
 * A constant rather than a setting: this is a limit on how long somebody waits
 * for their own Apply to come back, and there is no operator who should be
 * able to raise it without changing this line.
 */
export const FIT_DEADLINE_MS = 25_000;

export interface FitDeps {
  db: pg.Pool;
  gh: GitHubApi;
  x402: X402Client;
  cfg: AgentConfig;
  now: () => Date;
}

export interface FitOutcome {
  assessment: FitAssessment;
  /** null when no call was made: assessment off, ceiling reached, or refused. */
  callId: string | null;
  /** Micro-USD this application cost. 0 when nothing was bought. */
  costMicro: number;
  /** Why no call happened, when none did. */
  skipped: string | null;
  malformed: boolean;
}

/** §4.4's documented default, used whenever no judgement was bought. */
const PLAUSIBLE: FitAssessment = {
  fit: 'plausible',
  difficulty_match: 'matched',
  evidence: '',
  relevant_languages_present: false,
  read_the_issue: false,
  concerns: [],
};

export class FitService {
  constructor(private readonly d: FitDeps) {}

  /**
   * The contributor's evidence, from cache when it is fresh.
   *
   * One crawl per person rather than per application, which is both
   * rate-limit safe and reproducible: two applications a day apart are judged
   * on the same evidence, so the difference between their assessments is not
   * partly GitHub's clock.
   */
  async evidenceFor(repo: string, githubUserId: number, login: string, issueLanguage: string): Promise<ContributorEvidence> {
    const cached = await this.d.db.query<{ evidence: ContributorEvidence; built_at: Date }>(
      `SELECT evidence, built_at FROM contributor_snapshots WHERE github_user_id = $1`,
      [githubUserId],
    );
    const row = cached.rows[0];
    if (row && this.d.now().getTime() - new Date(row.built_at).getTime() < SNAPSHOT_TTL_MS) return row.evidence;

    let evidence: ContributorEvidence;
    try {
      evidence = await this.d.gh.contributorEvidence(repo, login, issueLanguage);
    } catch {
      evidence = { account_age_days: 0, public_repo_count: 0, languages: [], recent_repos: [], sample_diffs: [], note: 'GitHub could not be read' };
    }
    await this.d.db.query(
      `INSERT INTO contributor_snapshots (github_user_id, login, evidence, built_at, build_note)
       VALUES ($1,$2,$3::jsonb,$4,$5)
       ON CONFLICT (github_user_id) DO UPDATE SET login = EXCLUDED.login, evidence = EXCLUDED.evidence, built_at = EXCLUDED.built_at, build_note = EXCLUDED.build_note`,
      [githubUserId, login, JSON.stringify(evidence), this.d.now().toISOString(), evidence.note ?? null],
    );
    return evidence;
  }

  /**
   * Assesses one application and writes the result onto it.
   *
   * Every failure path lands on 'plausible' with a full ticket, because the
   * alternative is letting a model outage, a budget ceiling or a stray code
   * fence decide who is eligible. §4.4 documents 'plausible' as the correct
   * answer for most newcomers, so this is a real outcome and not a placeholder.
   */
  async assess(input: {
    applicationId: string;
    bountyId: string;
    githubUserId: number;
    githubLogin: string;
    repo: string;
    issue: { title: string; body: string; acceptanceCriteria: string; difficultyTier: string; primaryLanguage: string };
    applicationText: string;
    enabled: boolean;
  }): Promise<FitOutcome> {
    if (!input.enabled) {
      await this.write(input.applicationId, PLAUSIBLE, null, null);
      return { assessment: PLAUSIBLE, callId: null, costMicro: 0, skipped: 'fit_assessment_off', malformed: false };
    }

    const evidence = await this.evidenceFor(input.repo, input.githubUserId, input.githubLogin, input.issue.primaryLanguage);
    const model = this.d.cfg.routing.review.model;

    let record: Awaited<ReturnType<X402Client['call']>>['record'];
    let response: Awaited<ReturnType<X402Client['call']>>['response'];
    try {
      const r = await this.d.x402.call({
        purpose: 'fit',
        phase: this.d.cfg.inferencePhase,
        path: X402_PATHS.chat,
        body: {
          model,
          max_tokens: 400,
          messages: [
            { role: 'system', content: FIT_SYSTEM_PROMPT },
            { role: 'user', content: fitUserContent({ issue: input.issue, evidence, applicationText: input.applicationText }) },
          ],
        },
        links: { bountyId: input.bountyId, applicationId: input.applicationId },
        // A deadline, because this call is awaited inside somebody's "Apply".
        // Without one, a gateway that accepts the connection and then says
        // nothing holds the application open until undici gives up minutes
        // later - and the applicant sees a failure for a row that was already
        // written. An abort lands in the catch below and answers 'plausible',
        // which is the same answer every other failure gets.
        signal: AbortSignal.timeout(FIT_DEADLINE_MS),
      });
      record = r.record;
      response = r.response;
    } catch (e) {
      // Ceiling reached, gateway down, payment refused. None of these are the
      // applicant's doing, so none of them cost them their place.
      await this.write(input.applicationId, PLAUSIBLE, null, model);
      return { assessment: PLAUSIBLE, callId: null, costMicro: 0, skipped: String(e instanceof Error ? e.message : e).slice(0, 200), malformed: false };
    }

    const text = assistantTextOf(response);
    const { assessment, malformed } = parseFit(text);
    await this.write(input.applicationId, assessment, record.id, model);
    const costMicro = (record.paidMicro ?? 0) + (record.feeMicro ?? 0);
    return { assessment, callId: record.id, costMicro, skipped: null, malformed };
  }

  private async write(applicationId: string, a: FitAssessment, callId: string | null, model: string | null) {
    await this.d.db.query(
      `UPDATE bounty_applications
          SET fit = $2, difficulty_match = $3, fit_evidence = $4, fit_concerns = $5,
              fit_assessed_at = now(), fit_call_id = $6, fit_model = $7, updated_at = now()
        WHERE id = $1`,
      [applicationId, a.fit, a.difficulty_match, a.evidence, a.concerns, callId, model],
    );
  }
}

/** The assistant's text, whatever shape the gateway wrapped it in. */
export function assistantTextOf(response: unknown): string {
  const r = response as { choices?: { message?: { content?: unknown } }[] } | undefined;
  const c = r?.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : ((p as { text?: string })?.text ?? ''))).join('');
  return '';
}

/** Whether the programme is buying fit assessments at all. */
export function fitEnabled(cfg: Record<string, string>): boolean {
  return boolOf(cfg.ai_fit_assessment_enabled, false);
}
