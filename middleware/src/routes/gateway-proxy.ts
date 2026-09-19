// Legacy generic gateway bridge. No application consumer uses these routes.
// A service signature authorizes the BFF, not the human selecting the channel;
// forwarding arbitrary channels therefore bypasses gateway membership policy.
// Keep an explicit retirement response for old clients. A replacement must use
// verified identity and server-owned membership before it can mint credentials.
import { Router, type RequestHandler } from 'express';

export const gatewayProxyRouter = Router();
const retired: RequestHandler = (_req, res) => {
  res.status(410).json({ error: 'generic gateway proxy retired; use an authorized channel integration' });
};
gatewayProxyRouter.post('/channels/:id/messages', retired);
gatewayProxyRouter.get('/presence/:channel', retired);
gatewayProxyRouter.get('/chat/:channel/history', retired);
gatewayProxyRouter.get('/activity/:channel/history', retired);
