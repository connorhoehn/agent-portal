// The requester-private realtime channel of one durable flow run:
// `<tenant>:flowrun:<runId>`. Server publish only, client subscribe only, and
// admitted to exactly one person: the run's requester, read from the durable
// `flow_runs` row on EVERY authorize (live-principal.ts `authorizeFlowRunChannel`).
//
// The tenant is not chosen by the client. A run id's prefix names the flow
// that minted it (FlowRunStore.create `idPrefix`), and each flow belongs to
// one tenant, so the channel is a pure function of the id: a client cannot
// re-file `sum-…` under `assessment:` to reach a looser authority, and the
// wire mapping needs no lookup (an unknown run and someone else's run are
// refused by the same authorize, with the same frame).
//
// | id prefix | tenant     | REST read it mirrors                                           |
// |-----------|------------|----------------------------------------------------------------|
// | sum-      | social     | GET /api/chat/commands/summarize/runs/:id — ViewSocial + membership of the run's conversation + requester |
// | sdk-      | social     | GET /api/chat/commands/deck/runs/:id — the same: ViewSocial + membership of the run's conversation + requester |
// | adr-      | assessment | GET /api/assessment/drafts/:runId — requireTenant('assessment') + ViewAssessment + requester |
// | osm-      | orgiq      | GET /api/conversations/summarize/runs/:id — the run's conversation history read (family or huddle) + requester |
// | asm-      | assessment | GET /api/conversations/summarize/runs/:id — the run's conversation history read + requester |
// | psm-      | pipelines  | GET /api/conversations/summarize/runs/:id — the run's conversation history read + requester |
// | pdr-      | pipelines  | GET /api/pipelines/decks/:id/runs/:runId — requireTenant('pipelines') + ViewPipelines + requester (run report deck agent revise) |
//
// The conversation `/summarize` kinds (CONVERSATION_SUMMARIZE_KINDS) are
// decided by the authority that conversation's chat history has today
// (live-principal.ts `authorizeConversationChat`), never by their tenant's
// broader grant: `asm-` is not `adr-`.
//
// | sdg-/sdc- | social | /diagram and /doc runs: the same ViewSocial + conversation membership + requester as sum- |
// | odg-/odc-/adg-/adc-/pdg-/pdc- | orgiq/assessment/pipelines | the conversation's chat read + requester, like osm-/asm-/psm- |
// | sag- | social | /agent plan runs: the same ViewSocial + conversation membership + requester as sum- |
// | oag-/aag-/pag- | orgiq/assessment/pipelines | /agent plan runs: the conversation's chat read + requester |
//
// Assessment deck runs live in `assessment_runs` (not here) and stay on polling.

export type FlowRunChannelTenant = 'social' | 'assessment' | 'orgiq' | 'pipelines';

export const FLOW_RUN_ID_TENANT: Readonly<Record<string, FlowRunChannelTenant>> = Object.freeze({
  sum: 'social',
  sdk: 'social',
  adr: 'assessment',
  osm: 'orgiq',
  asm: 'assessment',
  psm: 'pipelines',
  // Run report deck agent revise (providers/pipeline-decks.ts): not a conversation flow.
  pdr: 'pipelines',
  // /diagram and /doc (lib/conversation-artifact.ts): <tenant letter>dg = diagram, <tenant letter>dc = doc.
  sdg: 'social', sdc: 'social',
  odg: 'orgiq', odc: 'orgiq',
  adg: 'assessment', adc: 'assessment',
  pdg: 'pipelines', pdc: 'pipelines',
  // /agent (lib/agent-loop): <tenant letter>ag.
  sag: 'social', oag: 'orgiq', aag: 'assessment', pag: 'pipelines',
});

/** The non-Social conversation `/summarize` flows: id prefix → durable kind. */
export const CONVERSATION_SUMMARIZE_KINDS: Readonly<Record<string, { tenant: Exclude<FlowRunChannelTenant, 'social'>; kind: string }>> = Object.freeze({
  osm: { tenant: 'orgiq', kind: 'orgiq.summarize' },
  asm: { tenant: 'assessment', kind: 'assessment.summarize' },
  psm: { tenant: 'pipelines', kind: 'pipelines.summarize' },
});
/** The non-Social conversation `/diagram` and `/doc` flows: id prefix → durable kind. */
export const CONVERSATION_ARTIFACT_KINDS: Readonly<Record<string, { tenant: Exclude<FlowRunChannelTenant, 'social'>; kind: string; command: 'diagram' | 'doc' }>> = Object.freeze({
  odg: { tenant: 'orgiq', kind: 'orgiq.diagram', command: 'diagram' },
  odc: { tenant: 'orgiq', kind: 'orgiq.doc', command: 'doc' },
  adg: { tenant: 'assessment', kind: 'assessment.diagram', command: 'diagram' },
  adc: { tenant: 'assessment', kind: 'assessment.doc', command: 'doc' },
  pdg: { tenant: 'pipelines', kind: 'pipelines.diagram', command: 'diagram' },
  pdc: { tenant: 'pipelines', kind: 'pipelines.doc', command: 'doc' },
});
/** The non-Social conversation `/agent` flows: id prefix → durable kind. */
export const CONVERSATION_AGENT_KINDS: Readonly<Record<string, { tenant: Exclude<FlowRunChannelTenant, 'social'>; kind: string }>> = Object.freeze({
  oag: { tenant: 'orgiq', kind: 'orgiq.agent' },
  aag: { tenant: 'assessment', kind: 'assessment.agent' },
  pag: { tenant: 'pipelines', kind: 'pipelines.agent' },
});
export const isConversationSummarizeKind = (kind: string): boolean =>
  Object.values(CONVERSATION_SUMMARIZE_KINDS).some(k => k.kind === kind)
  || Object.values(CONVERSATION_ARTIFACT_KINDS).some(k => k.kind === kind)
  || Object.values(CONVERSATION_AGENT_KINDS).some(k => k.kind === kind);

/** The durable kind of a run report deck's agent revise (id prefix `pdr`). */
export const PIPELINE_DECK_REVISE_KIND = 'pipelines.deck-revise';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RUN_ID = new RegExp(`^([a-z]{2,8})-${UUID}$`);
const CHANNEL = new RegExp(`^(social|assessment|orgiq|pipelines):flowrun:(([a-z]{2,8})-${UUID})$`);

/** The tenant whose flow minted `runId`, or null when it is no live flow run id. */
export function flowRunTenant(runId: unknown): FlowRunChannelTenant | null {
  if (typeof runId !== 'string') return null;
  const m = runId.match(RUN_ID);
  return m ? FLOW_RUN_ID_TENANT[m[1]!] ?? null : null;
}

/** `sum-<uuid>` → `social:flowrun:sum-<uuid>`; null for anything that is not a live flow run id. */
export function flowRunChannel(runId: unknown): string | null {
  const tenant = flowRunTenant(runId);
  return tenant ? `${tenant}:flowrun:${runId as string}` : null;
}

/** The parts of a well-formed flow-run channel whose tenant matches its id's flow; null otherwise. */
export function parseFlowRunChannel(name: unknown): { tenant: FlowRunChannelTenant; runId: string } | null {
  if (typeof name !== 'string') return null;
  const m = name.match(CHANNEL);
  if (!m) return null;
  const tenant = m[1] as FlowRunChannelTenant;
  return FLOW_RUN_ID_TENANT[m[3]!] === tenant ? { tenant, runId: m[2]! } : null;
}

/** Any name under the `<p>:flowrun:` namespace, well-formed or not (the guards refuse the malformed ones). */
export const inFlowRunNamespace = (name: string): boolean => /^[^:]+:flowrun(?::|$)/.test(name);
