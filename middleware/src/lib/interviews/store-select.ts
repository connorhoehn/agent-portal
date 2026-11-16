// Which InterviewsStore the process uses: the in-memory store under the mock providers (dev:mock,
// the journeys, tests), the SQL store (schema/interviews_schema.sql) otherwise. Cached per process;
// tests inject with setInterviewsStore.
import { config } from '../../config.js';
import { MemoryInterviewsStore, type InterviewsStore } from './store.js';
import { SqlInterviewsStore } from './store-sql.js';

let current: InterviewsStore | null = null;

export function createInterviewsStore(): InterviewsStore {
  if (config.mock?.aurora) return new MemoryInterviewsStore();
  // Loaded on first use so a mock process never pulls in the AWS client.
  return new SqlInterviewsStore(async (sql, params) => (await import('../../providers/aurora.js')).exec(sql, params));
}

export function interviewsStore(): InterviewsStore { return (current ??= createInterviewsStore()); }
export function setInterviewsStore(next: InterviewsStore | null): void { current = next; }
