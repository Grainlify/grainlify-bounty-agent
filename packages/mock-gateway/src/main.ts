import { createMockGateway } from './gateway.ts';
import { bountyResponder } from './responder.ts';

const port = Number(process.env.MOCK_PORT ?? 8402);
const { server } = createMockGateway({
  overpayPolicy: process.env.MOCK_OVERPAY_POLICY === 'forfeit' ? 'forfeit' : 'credit',
  confirmationDelayMs: Number(process.env.MOCK_CONFIRMATION_DELAY_MS ?? 0),
  responder: bountyResponder,
});
server.listen(port, '127.0.0.1', () => console.log(`mock UsePod x402 gateway on http://127.0.0.1:${port}`));
