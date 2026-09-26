import { startLinkNoncePruning } from '../../../packages/db/src/prune.ts';
import { startDrawScheduler } from './scheduler.ts';
import { createAgentServer } from './server.ts';
import { wire } from './wiring.ts';

const { db, service, webhookSecret, cfg, publicApi, publicOrigins, payoutsApiToken, draw, linkCountersignKey } = await wire();
startLinkNoncePruning(db);
startDrawScheduler(draw);
const port = Number(process.env.AGENT_PORT ?? process.env.PORT ?? 3000);
createAgentServer({ db, service, webhookSecret, publicApi, publicOrigins, payoutsApiToken, draw, linkCountersignKey, onError: (e) => console.error('webhook processing failed:', e) }).listen(port, process.env.AGENT_HOST ?? '127.0.0.1', () => {
  console.log(`agent on :${port}; payouts on ${cfg.network}; inference ${cfg.inferenceMode}`);
});
