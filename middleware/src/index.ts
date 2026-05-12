import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { errorHandler } from './lib/async-handler.js';
import { agentsRouter } from './routes/agents.js';
import { graphRouter } from './routes/graph.js';
import { scoresRouter } from './routes/scores.js';
import { ingestRouter } from './routes/ingest.js';
import { observabilityRouter } from './routes/observability.js';
import { capabilitiesRouter } from './routes/capabilities.js';
import { sessionsRouter } from './routes/sessions.js';
import { initScheduler } from './lib/ingest-scheduler.js';
import { initCrawlTargets } from './lib/crawl-targets.js';

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

function healthHandler(_req: express.Request, res: express.Response): void {
  res.json({
    status: 'ok',
    service: 'orgiq-middleware',
    mocks: config.mock,
    region: config.region,
  });
}
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

app.use('/api/agents', agentsRouter);
app.use('/api/graph', graphRouter);
app.use('/api/scores', scoresRouter);
app.use('/api/ingest', ingestRouter);
app.use('/api/observability', observabilityRouter);
app.use('/api/capabilities', capabilitiesRouter);
app.use('/api/sessions', sessionsRouter);

app.use(errorHandler);

initScheduler();
initCrawlTargets();

app.listen(config.port, '0.0.0.0', () => {
  const mockedDomains = Object.entries(config.mock).filter(([, v]) => v).map(([k]) => k);
  const mockSuffix = mockedDomains.length > 0 ? `mock=${mockedDomains.join(',')}` : 'mocks=off';
  console.log(`orgiq-middleware listening on :${config.port} (${mockSuffix})`);
});
