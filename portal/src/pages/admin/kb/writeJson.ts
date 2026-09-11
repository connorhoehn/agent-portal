// One shape for every mutation on the KB registry screens.
//
// Sync, provision and delete each hand-rolled the same try/catch/parse block —
// three copies that had already drifted (two of them left `loading` stuck on
// after a failure). This is the single version they now share.
//
// NOTE: pages/sprints/writeJson.ts is the same helper for that page's folder.
// When a third page needs it, lift one copy to src/lib/ rather than adding a
// fourth.

export interface WriteResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
  /**
   * The server said the request was refused because the thing it asks for is
   * ALREADY HAPPENING — `{ conflict: true }`, which today only a sync in flight
   * sends. Carried separately from `error` because it is not one: painting it
   * red says the pipeline broke when what actually happened is that the
   * pipeline is busy. Read off the body rather than off `status === 409`, since
   * 409 is also the answer to a duplicate slug and to an unconfigured
   * knowledge base, neither of which is good news.
   */
  conflict: boolean;
}

/** Sends JSON with the session cookie and surfaces the backend's `{ error }`
 *  message verbatim. A bare 403 with no body reads as a permission problem
 *  rather than a raw status code. */
export async function writeJson<T>(
  url: string,
  method: string,
  body?: unknown,
): Promise<WriteResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: string; conflict?: boolean;
    } & Record<string, unknown>;
    if (!res.ok) {
      const fallback = res.status === 403
        ? 'You do not have permission for this action.'
        : `HTTP ${res.status}`;
      return {
        ok: false, status: res.status, data: null,
        error: json.error ?? fallback, conflict: json.conflict === true,
      };
    }
    return { ok: true, status: res.status, data: json as T, error: null, conflict: false };
  } catch {
    return { ok: false, status: 0, data: null, error: 'Network error', conflict: false };
  }
}
