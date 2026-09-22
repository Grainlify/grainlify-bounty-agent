import { startLinkNoncePruning } from '../../../packages/db/src/prune.ts';
import { createAgentServer } from './server.ts';
import { wire } from './wiring.ts';

const { db, service, webhookSecret, cfg, publicApi, publicOrigins, payoutsApiToken } = await wire();
startLinkNoncePruning(db);
const port = Number(process.env.AGENT_PORT ?? process.env.PORT ?? 3000);
createAgentServer({ db, service, webhookSecret, publicApi, publicOrigins, payoutsApiToken, onError: (e) => console.error('webhook processing failed:', e) }).listen(port, process.env.AGENT_HOST ?? '127.0.0.1', () => {
  console.log(`agent on :${port}; payouts on ${cfg.network}; inference ${cfg.inferenceMode}`);
});
