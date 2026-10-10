import { useMemo } from 'react';
import { readSharedPeople } from '../components/shell/tenantDirectModel';
import { withMessagePortraits } from '../lib/messagePortraits';
import { useFetch } from './useFetch';

/** Shared across tenant discussions and Social; one deduplicated directory request. */
export function useMessagePortraits<T extends { userId?: string; metadata?: Record<string, unknown> }>(messages: T[]): T[] {
  const directory = useFetch<unknown>('/api/people/shared', 120_000, { share: true });
  return useMemo(() => withMessagePortraits(messages, readSharedPeople(directory.data)), [messages, directory.data]);
}
