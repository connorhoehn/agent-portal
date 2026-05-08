import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { errorHandler } from './lib/async-handler.js';
import { agentsRouter } from './routes/agents.js';
import { graphRouter } from './routes/graph.js';
import { scoresRouter } from './routes/scores.js';
import { ingestRouter } from './routes/ingest.js';
import { observabilityRouter } from './routes/observability.js';

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'orgiq-middleware', mockMode: config.mockMode });
});

app.use('/api/agents', agentsRouter);
app.use('/api/graph', graphRouter);
app.use('/api/scores', scoresRouter);
app.use('/api/ingest', ingestRouter);
app.use('/api/observability', observabilityRouter);

app.use(errorHandler);

app.listen(config.port, '0.0.0.0', () => {
  console.log(`orgiq-middleware listening on :${config.port} (mock=${config.mockMode})`);
});
