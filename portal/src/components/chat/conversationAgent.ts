// `/agent <goal>` on any conversation — the client half of the agent loop
// (middleware lib/agent-loop, routes/agent-loop.ts). Two mounts of one
// implementation, like /summarize and /diagram: Social conversations at
// /api/chat/commands/agent and tenant conversations + huddles at
// /api/conversations/agent. Pure and fetch-injectable so node:test covers it
// without a DOM. Reference: realtime-examples' `agentLoopPlanner`, `AgentRunCard`
// and `useChatCommands` (the plan card with Approve / Discard).
//
// The card is private to the requester. Approve is the only act that starts
// anything: the server then runs the plan's steps in order through the flows
// that already exist, and each finished step shows that flow's own card.

import type { AgentRunStatus, ChatCommand } from '@connorhoehnslalom/ui-components/social';

export type AgentStepKind = 'summarize' | 'deck' | 'diagram' | 'doc' | 'draft' | 'note' | 'document:create' | 'meeting:create' | 'approval';
export interface AgentPlanStep { kind: AgentStepKind; title: string; instruction: string; acceptance: string; body?: string }
export interface AgentPlan { goal: string; summary: string; steps: AgentPlanStep[]; fallback: boolean; unavailable?: string }
export type AgentStage = 'planning' | 'awaiting-approval' | 'waiting-approval' | 'running' | 'done' | 'stopped' | 'discarded' | 'failed';
export type AgentPhase = 'received' | 'running' | 'completed' | 'failed';
export type AgentStepRefKind = 'summary' | 'deck' | 'diagram' | 'doc';
/** What a `document:create` or `meeting:create` step made: a document, a room or a huddle lobby. */
export interface AgentStepLink { kind: 'document' | 'room' | 'huddle'; label: string; href?: string; lobbyName?: string }
export interface AgentStepStatus {
  id: string; label: string; status: 'pending' | 'running' | 'completed' | 'failed';
  ref?: { kind: AgentStepRefKind; runId: string }; detail?: string; link?: AgentStepLink;
}
/** What a loop paused at an `approval` step asks, and when the pause lapses (the server expires it). */
export interface AgentApproval { stepId: string; question: string; since: string; expiresAt: string }
/** What the person looking may do about a paused loop: the requester and a tenant's second approver decide; everyone else reads. */
export type AgentApprovalRole = 'requester' | 'approver' | 'reader';
/** One paused loop in a conversation, as `GET /agent/waiting` lists it (no goal text or transcript, only the question and step titles). */
export interface AgentWaitingRun {
  runId: string; channel: string; role: AgentApprovalRole; mine: boolean; requestedBy: string; summary: string;
  steps: Array<Pick<AgentStepStatus, 'id' | 'label' | 'status'>>; approval: AgentApproval | null;
}
export interface AgentRunStatusBody {
  runId: string; channel: string; stage: AgentStage; phase: AgentPhase;
  steps: AgentStepStatus[]; plan: AgentPlan | null; error: string | null;
  /** `authorization-unavailable` when the loop failed closed because the requester's access changed. */
  errorCode?: string | null;
  /** Present while stage is `waiting-approval`. */
  approval?: AgentApproval | null;
}
export interface AgentStarted { runId: string; pipelineId: string; card: Record<string, unknown> }

type Fetch = typeof fetch;

export const SOCIAL_AGENT_BASE = '/api/chat/commands/agent';
export const CONVERSATION_AGENT_BASE = '/api/conversations/agent';
export const AGENT_PIPELINE_ID = 'conversation-agent';

async function json<T>(response: Response, fallback: string): Promise<T> {
  let body: unknown = null;
  try { body = await response.json(); } catch { /* an empty error body falls back to the status text */ }
  if (!response.ok) {
    const message = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error : fallback;
    throw new Error(message);
  }
  return body as T;
}

export interface AgentApi {
  start(channel: string, argumentText: string, doFetch?: Fetch): Promise<AgentStarted>;
  status(runId: string, doFetch?: Fetch): Promise<AgentRunStatusBody>;
  approve(runId: string, doFetch?: Fetch): Promise<{ runId: string; stage: AgentStage }>;
  discard(runId: string, doFetch?: Fetch): Promise<{ runId: string; stage: AgentStage }>;
  /** The loops paused at an approval step in this conversation (the caller's role on each). */
  waiting(channel: string, doFetch?: Fetch): Promise<AgentWaitingRun[]>;
  /** Approve resumes the loop from the next step as the caller; Reject ends it (`reason` shows on the card). */
  decideApproval(runId: string, verb: 'approve' | 'reject', reason?: string, doFetch?: Fetch): Promise<{ runId: string; stage: AgentStage }>;
}

/** The calls against one mount (`base`). */
export function agentApi(base: string): AgentApi {
  const post = (runId: string, verb: 'approve' | 'discard', doFetch: Fetch, fallback: string) =>
    doFetch(`${base}/runs/${encodeURIComponent(runId)}/${verb}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      // One id per run: a retried Approve answers the same 202 and never starts a second loop.
      body: JSON.stringify(verb === 'approve' ? { requestId: `rq-${runId}` } : {}) }).then(r => json<{ runId: string; stage: AgentStage }>(r, fallback));
  return {
    async start(channel, argumentText, doFetch = fetch) {
      return json(await doFetch(`${base}/run`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, text: argumentText }) }), 'The plan could not be started.');
    },
    async status(runId, doFetch = fetch) {
      return json(await doFetch(`${base}/runs/${encodeURIComponent(runId)}`, { credentials: 'include' }), 'The plan could not be read.');
    },
    async waiting(channel, doFetch = fetch) {
      const out = await json<{ runs: AgentWaitingRun[] }>(await doFetch(`${base}/waiting?channel=${encodeURIComponent(channel)}`, { credentials: 'include' }), 'Waiting approvals could not be read.');
      return out.runs;
    },
    async decideApproval(runId, verb, reason, doFetch = fetch) {
      return json(await doFetch(`${base}/runs/${encodeURIComponent(runId)}/approval/${verb}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        // One id per run and verb: a retried decision answers the same 202 and never resumes twice.
        body: JSON.stringify({ requestId: `ap-${runId}-${verb}`, ...(reason ? { reason } : {}) }) }), verb === 'approve' ? 'The approval could not be saved.' : 'The rejection could not be saved.');
    },
    approve: (runId, doFetch = fetch) => post(runId, 'approve', doFetch, 'The plan could not be approved.'),
    discard: (runId, doFetch = fetch) => post(runId, 'discard', doFetch, 'The plan could not be discarded.'),
  };
}

export const socialAgentApi: AgentApi = agentApi(SOCIAL_AGENT_BASE);
export const conversationAgentApi: AgentApi = agentApi(CONVERSATION_AGENT_BASE);

/** A running loop can be stopped; it ends at the next step boundary. */
export const canStop = (s: Pick<AgentRunStatusBody, 'stage'>): boolean => s.stage === 'running';

/** The card follows a run until nothing more will change without the requester: a decided or ended run, or a loop paused at an approval. */
export const isSettled = (s: Pick<AgentRunStatusBody, 'stage'>): boolean =>
  s.stage === 'awaiting-approval' || s.stage === 'waiting-approval' || s.stage === 'done' || s.stage === 'stopped' || s.stage === 'discarded' || s.stage === 'failed';

/** Approve / Discard are offered only while the plan waits for a decision. */
export const canDecide = (s: Pick<AgentRunStatusBody, 'stage' | 'plan'>): boolean => s.stage === 'awaiting-approval' && !!s.plan && s.plan.steps.length > 0;

/** Approve / Reject on a paused loop: only its requester or an eligible second approver; a reader sees the question. */
export const canDecideApproval = (role: AgentApprovalRole): boolean => role !== 'reader';

/** The loop is paused for this person's decision (their own run, owner view). */
export const isWaitingApproval = (s: Pick<AgentRunStatusBody, 'stage' | 'approval'>): boolean => s.stage === 'waiting-approval' && !!s.approval;

/** When the pause lapses, in words ("expires in 3 h"); an already-lapsed pause reads as expiring now. */
export function approvalExpiryNote(approval: Pick<AgentApproval, 'expiresAt'>, now: number = Date.now()): string {
  const left = Date.parse(approval.expiresAt) - now;
  if (!Number.isFinite(left)) return '';
  if (left <= 60_000) return 'Expires in under a minute with no decision.';
  const minutes = Math.round(left / 60_000);
  return minutes < 90 ? `Expires in ${minutes} min with no decision.` : `Expires in ${Math.round(minutes / 60)} h with no decision.`;
}

const KIND_LABEL: Record<AgentStepKind, string> = {
  approval: 'Approval', summarize: 'Summarize', deck: 'Deck', diagram: 'Diagram', doc: 'Page', draft: 'Draft', note: 'Note',
  'document:create': 'Create document', 'meeting:create': 'Create meeting',
};

/** How a finished creation step's link is drawn: an in-app route, a file to open, or a lobby name only. */
export interface StepLinkView { noun: string; label: string; open: 'route' | 'file' | 'none'; href?: string; note?: string }
export function stepLinkView(link: AgentStepLink): StepLinkView {
  const noun = link.kind === 'document' ? 'Document' : link.kind === 'room' ? 'Room' : 'Huddle';
  const file = !!link.href && link.href.startsWith('/api/');
  const route = !!link.href && link.href.startsWith('/') && !link.href.startsWith('//') && !file;
  return {
    noun, label: link.label, open: file ? 'file' : route ? 'route' : 'none',
    ...(route || file ? { href: link.href! } : {}),
    ...(link.kind === 'huddle' && link.lobbyName ? { note: `Lobby ${link.lobbyName}. Start it from the Huddle button in the footer.` } : {}),
  };
}

/** The plan as the requester reviews it: each step, what runs, and when it counts as done. */
export function planMarkdown(plan: AgentPlan): string {
  const steps = plan.steps.map((s, i) => `${i + 1}. **${KIND_LABEL[s.kind]}**: ${s.title}\n   - Done when: ${s.acceptance}`).join('\n');
  return `${plan.summary}\n\n${steps}`;
}

/** What `AgentRunCard` reads. */
export function agentRunStatusOf(s: AgentRunStatusBody): AgentRunStatus {
  const running = s.steps.find(step => step.status === 'running');
  const failed = s.steps.find(step => step.status === 'failed');
  const waiting = s.stage === 'awaiting-approval';
  const paused = s.stage === 'waiting-approval';
  return {
    phase: waiting || paused ? 'running' : s.phase,
    details: { steps: s.steps.map(({ id, label, status }) => ({ id, label, status })), ...(s.error ? { error: s.error } : {}) },
    ...(running ? { stepLabel: running.label } : {}),
    ...(waiting ? { detail: 'Review the plan. Nothing runs until you approve it.' } : {}),
    ...(paused ? { detail: s.approval ? `Waiting for a decision: ${s.approval.question}` : 'Waiting for a decision.' } : {}),
    ...(s.stage === 'discarded' ? { detail: s.steps.some(x => x.status !== 'pending') ? 'Stopped by you. The loop ends after the current step.' : 'Plan discarded. Nothing ran.' } : {}),
    ...(s.phase === 'failed' ? { detail: failed?.detail ? `${failed.label}: ${failed.detail}` : s.error ?? 'The plan failed.' } : {}),
    ...(waiting && s.plan?.fallback ? { detail: s.plan.unavailable
      ? `Nova is not available for this conversation (${s.plan.unavailable}), so this is a one-step plan built from your goal.`
      : 'The planner\'s answer could not be verified, so this is a one-step plan built from your goal.' } : {}),
  };
}

/** `/agent <goal>` against `api` — the private plan card, not a message. */
export function agentCommand(api: AgentApi): ChatCommand {
  return {
    trigger: '/agent',
    label: 'Plan and run steps toward a goal',
    hint: 'What should be done: wrap up this thread',
    description: 'Nova plans up to six steps (summarize, deck, diagram, page, draft, note, create a document, create a meeting, ask for your approval) with acceptance criteria. Only you see the plan, and nothing runs until you approve it.',
    scope: 'always',
    async run(ctx) {
      const started = await api.start(ctx.channel, ctx.argumentText);
      return { kind: 'run', runId: started.runId, pipelineId: started.pipelineId, card: started.card,
        echo: ctx.text.trim() || '/agent', visibility: 'private' };
    },
  };
}

/** True for the pipeline id of an /agent run outcome. */
export const isAgentPipeline = (pipelineId: string | undefined): boolean => pipelineId === AGENT_PIPELINE_ID;
