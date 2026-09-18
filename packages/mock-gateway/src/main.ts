import { createMockGateway } from './gateway.ts';
import { bountyResponder } from './responder.ts';

const port = Number(process.env.MOCK_PORT ?? process.env.PORT ?? 8402);
const host = process.env.MOCK_HOST ?? '127.0.0.1';
const { server } = createMockGateway({
  overpayPolicy: process.env.MOCK_OVERPAY_POLICY === 'forfeit' ? 'forfeit' : 'credit',
  confirmationDelayMs: Number(process.env.MOCK_CONFIRMATION_DELAY_MS ?? 0),
  responder: bountyResponder,
});
server.listen(port, host, () => console.log(`mock UsePod x402 gateway on http://${host}:${port}`));
