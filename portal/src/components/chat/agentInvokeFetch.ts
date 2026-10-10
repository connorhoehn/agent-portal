import { describeTurnError } from './turnError';

/** Preserve the real HTTP failure before the streaming hook reduces it to a status alone. */
export async function agentInvokeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
    throw new Error(describeTurnError(0));
  }
  if (response.ok) return response;
  let body: string | undefined;
  try { body = await response.clone().text(); } catch { /* The status still explains the failure. */ }
  throw new Error(describeTurnError(response.status, body));
}
