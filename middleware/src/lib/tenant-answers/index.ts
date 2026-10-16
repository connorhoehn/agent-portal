// Tenant answers (docs/user-search-goal.md S4, decision 3): the aggregate and
// edge questions of assessment and access answered as one fixed fact, from the
// reader's own search projection — no model, no SQL, storage-agnostic (the
// SearchIndex is memory in dev:mock and the DynamoDB wire elsewhere). A
// question no intent recognises answers null, and the surface says nothing
// rather than something wrong.
//
// Surfaces: GET /api/<tenant>/search/answer?q= (routes/tenant-search.ts) and
// the command box of a tenant's list page, which asks it when the page's own
// bounded command does not recognise the phrase.

import type { PrincipalRef } from '../authz.js';
import { ensureIndexed } from '../search-index/registry.js';
import { tenantContext } from '../search-index/tenant-query.js';
import { tenantSpec, type IndexedTenant } from '../search-index/tenants.js';
import type { SearchDoc } from '../search-index/types.js';
import type { AnswerContext, AnswerIntent, TenantAnswer } from './types.js';

export type { TenantAnswer, AnswerRecord } from './types.js';

async function intentsOf(tenant: Exclude<IndexedTenant, 'orgiq'>): Promise<readonly AnswerIntent[]> {
  switch (tenant) {
    case 'assessment': return (await import('./assessment.js')).ASSESSMENT_INTENTS;
    case 'access': return (await import('./access.js')).ACCESS_INTENTS;
    default: return [];
  }
}

export const normalizeQuestion = (question: string): string => question.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').replace(/[?!.\s]+$/, '').trim();

export async function answerTenant(tenant: Exclude<IndexedTenant, 'orgiq'>, principal: PrincipalRef, question: string): Promise<TenantAnswer | null> {
  const q = normalizeQuestion(question);
  if (!q || q.length > 500) return null;
  const intents = await intentsOf(tenant);
  if (!intents.length) return null;
  const spec = await tenantSpec(tenant);
  const [{ index, partition }, reader] = await Promise.all([ensureIndexed(tenant), tenantContext(tenant, principal, spec)]);
  const cache = new Map<string, Promise<SearchDoc[]>>();
  const c: AnswerContext = {
    question, q, reader,
    docs: (types, facets) => {
      const key = JSON.stringify([types, facets ?? null]);
      let hit = cache.get(key);
      if (!hit) {
        hit = index.query({ tenant: partition, terms: [], types, ...(facets ? { facets } : {}), allowedAcls: reader.allowedAcls })
          .then(page => page.docs.filter(d => !spec.visible || spec.visible(d, reader)));
        cache.set(key, hit);
      }
      return hit;
    },
  };
  for (const intent of intents) {
    const answer = await intent.answer(c);
    if (answer) return answer;
  }
  return null;
}
