// Which AssistantStore the process uses: the in-memory store under the mock providers (dev:mock,
// tests), the SQL store (schema/meeting_assistant_schema.sql) otherwise. Cached per process;
// tests inject with setAssistantStore.
import { config } from '../../config.js';
import { MemoryAssistantStore, type AssistantStore } from './store.js';
import { SqlAssistantStore } from './store-sql.js';

let current: AssistantStore | null = null;

export function createAssistantStore(): AssistantStore {
  if (config.mock?.aurora) return new MemoryAssistantStore();
  // Loaded on first use so a mock process never pulls in the AWS client.
  return new SqlAssistantStore(async (sql, params) => (await import('../../providers/aurora.js')).exec(sql, params));
}

export function assistantStore(): AssistantStore { return (current ??= createAssistantStore()); }
export function setAssistantStore(next: AssistantStore | null): void { current = next; }
