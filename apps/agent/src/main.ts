import { startLinkNoncePruning } from '../../../packages/db/src/prune.ts';
import { startErasureFinisher } from './erasure-service.ts';
import { startEventSender } from './event-sender.ts';
import { startDrawScheduler } from './scheduler.ts';
import { createAgentServer } from './server.ts';
import { wire } from './wiring.ts';
import { startGrainhackPoll } from './grainhack/wiring.ts';
import { retentionEnabled, startRetentionJob } from './grainhack/retention.ts';

const { db, service, webhookSecret, cfg, publicApi, publicOrigins, payoutsApiToken, draw, linkCountersignKey, events, escrow, funded, grainhack } = await wire();
startLinkNoncePruning(db);
startErasureFinisher(db);
startDrawScheduler(draw, undefined, undefined, funded);
startEventSender(events);
if (grainhack) startGrainhackPoll(grainhack);
// Off unless RETENTION_JOB_ENABLED is exactly "true": it deletes, so it is
// switched on only after `pnpm cli retention --dry-run` has been read against
// this database (grainhack/retention.ts).
if (retentionEnabled()) {
  console.log('retention job: on (RETENTION_JOB_ENABLED=true)');
  startRetentionJob(db);
} else {
  console.log('retention job: off (RETENTION_JOB_ENABLED is not "true"); nothing past its retention period is erased');
}
const port = Number(process.env.AGENT_PORT ?? process.env.PORT ?? 3000);
createAgentServer({ db, service, webhookSecret, publicApi, publicOrigins, payoutsApiToken, draw, linkCountersignKey, escrow, funded, grainhack: grainhack?.service, onError: (e) => console.error('webhook processing failed:', e) }).listen(port, process.env.AGENT_HOST ?? '127.0.0.1', () => {
  console.log(`agent on :${port}; payouts on ${cfg.network}; grainhack ${grainhack ? grainhack.cfg.network : 'off'}; inference ${cfg.inferenceMode}`);
});
