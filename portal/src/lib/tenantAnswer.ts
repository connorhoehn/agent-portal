// The tenant's fixed-fact answer to a question its page commands did not
// recognise (docs/user-search-goal.md S4): GET /api/<tenant>/search/answer.
// A null answer, a refusal or a network failure all mean "no answer here" —
// the caller keeps showing the command rejection, never an error as an answer.

/** The tenants whose workspaces answer questions (the server's lib/tenant-answers). */
const ANSWERING = new Set(['assessment', 'access']);

export const tenantAnswers = (tenant: string | undefined | null): boolean => !!tenant && ANSWERING.has(tenant);

export async function askTenantAnswer(tenant: string | undefined | null, question: string): Promise<string | null> {
  if (!tenantAnswers(tenant)) return null;
  const q = question.trim();
  if (!q || q.length > 500) return null;
  try {
    const res = await fetch(`/api/${tenant}/search/answer?q=${encodeURIComponent(q)}`, { credentials: 'include' });
    if (!res.ok) return null;
    const body = await res.json() as { answer?: { text?: unknown } | null };
    const text = body.answer?.text;
    return typeof text === 'string' && text.trim() ? text : null;
  } catch { return null; }
}
