// The tenant's fixed-fact answer to a question its page commands did not
// recognise (docs/user-search-goal.md S4): GET /api/<tenant>/search/answer.
// A null answer, a refusal or a network failure all mean "no answer here" —
// the caller keeps showing the command rejection, never an error as an answer.

/** The tenants whose workspaces answer questions (the server's lib/tenant-answers). */
const ANSWERING = new Set(['assessment', 'access']);

export const tenantAnswers = (tenant: string | undefined | null): boolean => !!tenant && ANSWERING.has(tenant);

/** One fixed fact and the records it was read from (`type`/`id` as the tenant's projection names them). */
export interface TenantAnswerFact {
  text: string;
  intent: string;
  records: ReadonlyArray<{ type: string; id: string }>;
}

export async function askTenantAnswer(tenant: string | undefined | null, question: string): Promise<TenantAnswerFact | null> {
  if (!tenantAnswers(tenant)) return null;
  const q = question.trim();
  if (!q || q.length > 500) return null;
  try {
    const res = await fetch(`/api/${tenant}/search/answer?q=${encodeURIComponent(q)}`, { credentials: 'include' });
    if (!res.ok) return null;
    const body = await res.json() as { answer?: { text?: unknown; intent?: unknown; records?: unknown } | null };
    const text = body.answer?.text;
    if (typeof text !== 'string' || !text.trim()) return null;
    const records = Array.isArray(body.answer?.records)
      ? (body.answer!.records as Array<{ type?: unknown; id?: unknown }>).filter((r) => typeof r.type === 'string' && typeof r.id === 'string').map((r) => ({ type: r.type as string, id: r.id as string }))
      : [];
    return { text, intent: typeof body.answer?.intent === 'string' ? body.answer.intent : '', records };
  } catch { return null; }
}
