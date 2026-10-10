// `/agent <goal>` planning (docs/agentic-flows-migration.md slice 10). Reference:
// realtime-examples platform-api src/loop `agentLoopPlanner` (plan 1-6 steps with
// acceptance criteria) and frontend `AgentRunCard` / `useChatCommands`.
//
// Differences, on purpose: the planner is Nova (the drafter's `plan-agent-loop`
// mode, agents/assessment-drafter/agent_plan.py); every step is one flow that
// ALREADY exists here (summarize, deck, diagram, doc, draft) or a `note`, plus the
// two creation steps `document:create` and `meeting:create` where the tenant has a
// create path; there is no cloud box step. The model proposes and this
// module decides what is kept: unknown or disallowed kinds, an empty acceptance
// or more than six steps replace the whole plan with the deterministic one.

import { config } from '../../config.js';
import { agentcore } from '../../providers/index.js';
import { mockPlanFor } from '../../mock/agent-plans.js';
import { transcriptText, type TranscriptLine } from '../conversation-summarize.js';
import { tenantChannelFamily } from '../tenant-channels.js';

export const PLAN_AGENT_ID = 'orgiq-assessment-drafter';
export const PLAN_MODE = 'plan-agent-loop';
export const STEP_KINDS = ['summarize', 'deck', 'diagram', 'doc', 'draft', 'note', 'document:create', 'meeting:create', 'approval'] as const;
export type StepKind = typeof STEP_KINDS[number];
export type AgentTenant = 'social' | 'orgiq' | 'assessment' | 'pipelines';
export const MAX_GOAL = 300;
export const MAX_STEPS = 6;
const MAX_TITLE = 120;
const MAX_INSTRUCTION = 200;
const MAX_ACCEPTANCE = 240;
export const MAX_BODY = 4000;

/**
 * `approval` runs nothing: the loop pauses there and asks the requester `instruction` (else the title) before the
 * next step. Reference: realtime-examples' pipeline `approval` node (a question, a decision, a timeout that rejects).
 * It is offered in every tenant; `acceptPlan` keeps it only when a step follows it.
 */
/** `body` is the page text of a `document:create` step (markdown, at most MAX_BODY characters); other kinds carry none. */
export interface PlanStep { kind: StepKind; title: string; instruction: string; acceptance: string; body?: string }
export interface AgentPlan { goal: string; summary: string; steps: PlanStep[]; fallback: boolean; unavailable?: string }

/**
 * The flows a conversation of this tenant already has: Social offers
 * /summarize /deck /diagram /doc; tenant discussions and huddles have no /deck.
 * `draft` is a page draft kept private (the /doc flow), and `note` runs nothing.
 * Creation steps are offered only where a create path exists: `document:create` in
 * Social (a stored file in the thread) and assessment (the Documents tab's New);
 * `meeting:create` in Social (a room) and in a conversation whose family is a call
 * lobby (an initiative discussion, an assessment document). orgiq and pipelines
 * have no document store, and a huddle already is a call.
 */
export const allowedKinds = (tenant: AgentTenant, channel?: string): StepKind[] => {
  const base: StepKind[] = tenant === 'social' ? ['summarize', 'deck', 'diagram', 'doc', 'draft', 'note', 'approval'] : ['summarize', 'diagram', 'doc', 'draft', 'note', 'approval'];
  if (tenant === 'social' || tenant === 'assessment') base.push('document:create');
  if (tenant === 'social' || (channel && tenantChannelFamily(channel)?.lobby === true)) base.push('meeting:create');
  return base;
};

export function parseAgentArgs(text: string): { ok: true; goal: string } | { ok: false; error: string } {
  // eslint-disable-next-line no-control-regex
  const goal = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!goal) return { ok: false, error: 'Say what you want done: /agent <goal>' };
  if (goal.length > MAX_GOAL) return { ok: false, error: `Keep the goal under ${MAX_GOAL} characters` };
  return { ok: true, goal };
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max).trim() : '');
/** Markdown keeps its line breaks; control characters other than newline and tab are dropped. */
// eslint-disable-next-line no-control-regex
const cleanBody = (v: unknown): string => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, MAX_BODY).trim() : '');

/** The agent's plan, or null when any part breaks a rule (the caller then uses the deterministic plan). */
export function acceptPlan(raw: unknown, goal: string, allowed: readonly StepKind[]): AgentPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const summary = clean(v['summary'], 400);
  if (!summary || !Array.isArray(v['steps']) || v['steps'].length < 1 || v['steps'].length > MAX_STEPS) return null;
  const steps: PlanStep[] = [];
  for (const s of v['steps']) {
    if (!s || typeof s !== 'object') return null;
    const r = s as Record<string, unknown>;
    const kind = r['kind'];
    if (typeof kind !== 'string' || !allowed.includes(kind as StepKind) || !STEP_KINDS.includes(kind as StepKind)) return null;
    const title = clean(r['title'], MAX_TITLE);
    const acceptance = clean(r['acceptance'], MAX_ACCEPTANCE);
    if (!title || !acceptance) return null;
    const body = kind === 'document:create' ? cleanBody(r['body']) : '';
    steps.push({ kind: kind as StepKind, title, instruction: clean(r['instruction'], MAX_INSTRUCTION), acceptance, ...(body ? { body } : {}) });
  }
  // An approval gates the step after it: with nothing after it the question has no consequence.
  if (steps[steps.length - 1]!.kind === 'approval') return null;
  return { goal, summary, steps, fallback: false };
}

/** Model-free plan: one step on the goal's own words. */
export function deterministicPlan(goal: string, allowed: readonly StepKind[]): AgentPlan {
  const kind: StepKind = allowed.includes('summarize') ? 'summarize' : allowed[0] ?? 'note';
  return { goal, summary: 'A one-step plan built directly from your goal.', fallback: true,
    steps: [{ kind, title: clean(goal, MAX_TITLE) || 'Work on the goal', instruction: clean(goal, MAX_INSTRUCTION),
      acceptance: 'The result addresses the goal and cites the conversation.' }] };
}

/** Asks for the plan. Never throws: an unreachable or refusing agent yields the deterministic plan with `unavailable`. */
export async function requestPlan(args: { tenant: AgentTenant; channel?: string; sub: string; runId: string; goal: string; lines: readonly TranscriptLine[]; agentAuth: boolean }): Promise<AgentPlan> {
  const allowed = allowedKinds(args.tenant, args.channel);
  let envelope: unknown = null;
  let unavailable: string | undefined;
  if (config.mock.agentcore) {
    const mock = mockPlanFor(args.goal);
    envelope = { ...mock, steps: mock.steps.filter(step => allowed.includes(step.kind)) };
  }
  else {
    try {
      const out = await agentcore.invokeAgent(PLAN_AGENT_ID, {
        message: `Execute ${args.tenant} command ${PLAN_MODE}`,
        structuredInput: { tenant: args.tenant, command: PLAN_MODE, mode: PLAN_MODE, run_id: args.runId, goal: args.goal, allowed_kinds: allowed,
          document: { text: transcriptText(args.lines) }, ...(args.agentAuth ? { auth: { tenant: args.tenant, sub: args.sub } } : {}) },
        timeoutMs: 120_000,
      });
      if (out.raw && typeof out.raw === 'object' && 'error' in out.raw) {
        unavailable = String((out.raw as { detail?: unknown; error: unknown }).detail ?? (out.raw as { error: unknown }).error);
      } else envelope = JSON.parse(out.text);
    } catch (error) { unavailable = error instanceof Error ? error.message : 'the planner failed'; }
  }
  const accepted = acceptPlan(envelope, args.goal, allowed);
  if (accepted) return accepted;
  return { ...deterministicPlan(args.goal, allowed), ...(unavailable ? { unavailable } : {}) };
}
