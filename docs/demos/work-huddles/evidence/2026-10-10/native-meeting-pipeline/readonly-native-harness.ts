// Reproduce cross-read acceptance against a uniquely owned local Dynamo fixture.
// Run with tsx, NATIVE_PLATFORM_CHECKOUT, LOCAL_DDB_ENDPOINT and DDB_TABLE_PREFIX.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
async function main() {
  const root = process.env.NATIVE_PLATFORM_CHECKOUT;
  const endpoint = new URL(process.env.LOCAL_DDB_ENDPOINT ?? 'invalid:');
  if (!root || !['127.0.0.1', 'localhost'].includes(endpoint.hostname)
    || !process.env.DDB_TABLE_PREFIX?.startsWith('meeting_acceptance_') || process.env.SKIP_AUTH !== 'false'
    || !process.env.REALTIME_JWT_SECRET) throw new Error('Owned native acceptance configuration required');
  const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
  const expressModule = await load('node_modules/express/index.js');
  const routes = await load('src/routes/recordings.ts');
  const errors = await load('src/middleware/error-handler.ts');
  const app = expressModule.default();
  app.use((req: any, res: any, next: any) => ['GET', 'HEAD'].includes(req.method) ? next() : res.status(405).json({ error: 'Read-only acceptance harness' }));
  app.use('/api', routes.recordingsRouter ?? routes.default?.recordingsRouter);
  app.use(errors.errorHandler ?? errors.default?.errorHandler);
  const server = app.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ kind: 'owned-native-recording-read', port: server.address().port, readOnly: true })));
  setTimeout(() => server.close(() => process.exit(0)), 180_000).unref();
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
