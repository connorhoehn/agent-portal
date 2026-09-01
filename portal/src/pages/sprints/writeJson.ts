// One shape for every mutation on this page.

export interface WriteResult<T> { ok: boolean; status: number; data: T | null; error: string | null }

/** Sends JSON with the session cookie and surfaces the backend's `{ error }`
 *  message (400/403/404) verbatim. A bare 403 with no body reads as a
 *  permission problem rather than a raw status. */
export async function writeJson<T>(url: string, method: string, body?: unknown): Promise<WriteResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
    if (!res.ok) {
      const fallback = res.status === 403
        ? 'You do not have permission for this action.'
        : `HTTP ${res.status}`;
      return { ok: false, status: res.status, data: null, error: json.error ?? fallback };
    }
    return { ok: true, status: res.status, data: json as T, error: null };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err instanceof Error ? err.message : 'Request failed' };
  }
}
