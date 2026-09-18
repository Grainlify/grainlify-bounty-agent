import { createAgentServer } from './server.ts';
import { wire } from './wiring.ts';

const { db, service, webhookSecret, cfg } = await wire();
const port = Number(process.env.AGENT_PORT ?? 3000);
createAgentServer({ db, service, webhookSecret, onError: (e) => console.error('webhook processing failed:', e) }).listen(port, process.env.AGENT_HOST ?? '127.0.0.1', () => {
  console.log(`agent on :${port}; payouts on ${cfg.network}; inference ${cfg.inferenceMode}`);
});
