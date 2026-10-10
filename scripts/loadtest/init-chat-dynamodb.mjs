#!/usr/bin/env node
// Reuse the installed public schema initializer, restricted to this isolated
// chat profile's five existing schemas. No deletion or copied schema logic.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const requireMiddleware = createRequire(resolve(root, 'middleware/package.json'));
const { DynamoDBClient } = requireMiddleware('@aws-sdk/client-dynamodb');
const setupPath = process.env.CHAT_SCHEMA_SETUP_PATH ?? resolve(root, 'infra/node_modules/realtime-examples/scripts/init-dynamodb.cjs');
const schemaPath = process.env.CHAT_SCHEMA_MANIFEST_PATH ?? resolve(root, 'infra/node_modules/realtime-examples/infra/dynamodb-schemas.json');
const { initialize } = requireMiddleware(setupPath);
const endpoint = process.env.CHAT_DDB_ENDPOINT ?? 'http://127.0.0.1:18061';
const url = new URL(endpoint);
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1', 'chat-dynamodb'].includes(url.hostname)
  || url.username || url.password) throw new Error('Chat bootstrap requires the explicit loopback or isolated Compose DynamoDB endpoint');
const prefix = process.env.CHAT_TABLE_PREFIX ?? 'orgiq-chat-';
if (!/^orgiq-chat-[a-zA-Z0-9_-]*$/.test(prefix)) throw new Error('Use the isolated orgiq-chat- table prefix');
const expected = new Set(['chat-messages', 'chat-conversations', 'chat-members', 'chat-reads', 'chat-pins']);
const manifest = JSON.parse(readFileSync(schemaPath, 'utf8'));
const tables = manifest.tables.filter(table => expected.has(table.tableName));
if (tables.length !== expected.size || new Set(tables.map(table => table.tableName)).size !== expected.size) {
  throw new Error('The public schema manifest must contain all five chat schemas exactly once');
}
const client = new DynamoDBClient({
  endpoint, region: 'us-east-1', maxAttempts: 2,
  credentials: { accessKeyId: 'localbootstrap', secretAccessKey: 'localbootstrap' },
  requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
});
try {
  const result = await initialize(client, { tables }, { prefix, timeoutMs: 60_000 });
  console.log(JSON.stringify({ endpoint, prefix, ...result }));
} finally { client.destroy(); }
