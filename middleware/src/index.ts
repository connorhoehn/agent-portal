import express from 'express';
import cors from 'cors';

const app = express();
const PORT = parseInt(process.env['PORT'] ?? '3001', 10);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'orgiq-middleware' });
});

app.post('/api/agents/invoke', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const events = [
    { type: 'RUN_STARTED', threadId: 'stub', runId: 'stub-run' },
    { type: 'TEXT_MESSAGE_START', messageId: 'msg-1', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg-1', delta: 'Middleware stub — agents not yet connected.' },
    { type: 'TEXT_MESSAGE_END', messageId: 'msg-1' },
    { type: 'RUN_FINISHED' },
  ];

  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
});

app.get('/api/graph/entities', (_req, res) => {
  res.json({ nodes: [], edges: [] });
});

app.get('/api/scores/leaderboard', (_req, res) => {
  res.json({ entries: [] });
});

app.post('/api/ingest/trigger', (_req, res) => {
  res.json({ status: 'queued', message: 'Ingestion not yet configured' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`orgiq-middleware listening on :${PORT}`);
});
