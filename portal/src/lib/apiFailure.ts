// Only the BFF's explicit provenance code can retire the page's session.
// A proxied service's 401 and a capability 403 do not say the cookie is stale.
export interface ApiFailure {
  kind: 'session-invalid' | 'forbidden' | 'http' | 'network';
  status: number | null;
  code: string | null;
  message: string;
}
export const SESSION_INVALID_EVENT = 'orgiq:session-invalid';

export function apiFailure(status: number, statusText: string, body: unknown): ApiFailure {
  const row = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const code = typeof row.code === 'string' ? row.code : null;
  const reason = [row.error, row.reason, row.message].find(value => typeof value === 'string' && value.trim()) as string | undefined;
  const line = `${status} ${statusText}`.trim();
  return { kind: status === 401 && code === 'SESSION_INVALID' ? 'session-invalid' : status === 403 ? 'forbidden' : 'http',
    status, code, message: reason ? `${line} — ${reason.trim()}` : line };
}

export function reportApiFailure(failure: ApiFailure): void {
  if (failure.kind === 'session-invalid' && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<ApiFailure>(SESSION_INVALID_EVENT, { detail: failure }));
  }
}

export async function responseFailure(response: Response): Promise<ApiFailure> {
  const body: unknown = await response.clone().json().catch(() => null);
  return apiFailure(response.status, response.statusText, body);
}
