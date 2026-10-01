import { startLinkNoncePruning } from '../../../packages/db/src/prune.ts';
import { startEventSender } from './event-sender.ts';
import { startDrawScheduler } from './scheduler.ts';
import { createAgentServer } from './server.ts';
import { wire } from './wiring.ts';

const { db, service, webhookSecret, cfg, publicApi, publicOrigins, payoutsApiToken, draw, linkCountersignKey, events, escrow, funded } = await wire();
startLinkNoncePruning(db);
startDrawScheduler(draw, undefined, undefined, funded);
startEventSender(events);
const port = Number(process.env.AGENT_PORT ?? process.env.PORT ?? 3000);
createAgentServer({ db, service, webhookSecret, publicApi, publicOrigins, payoutsApiToken, draw, linkCountersignKey, escrow, funded, onError: (e) => console.error('webhook processing failed:', e) }).listen(port, process.env.AGENT_HOST ?? '127.0.0.1', () => {
  console.log(`agent on :${port}; payouts on ${cfg.network}; inference ${cfg.inferenceMode}`);
});
