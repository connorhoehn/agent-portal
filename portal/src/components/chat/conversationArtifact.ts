// `/diagram` and `/doc` on any conversation — the client half of the artifact
// core (middleware lib/conversation-artifact.ts, routes/conversation-artifact.ts).
// Two mounts of one implementation, like /summarize: Social conversations at
// /api/chat/commands/{diagram,doc} and tenant conversations + huddles at
// /api/conversations/{diagram,doc}. Pure and fetch-injectable so node:test
// covers it without a DOM.
//
// Reference: realtime-examples frontend/src/chat/commands/diagramCommand.ts:21
// (`/diagram <title> — <prompt>`) and docCommand.ts:10 (`/doc <instruction>`).
// Here both are private run cards over the readable transcript; nothing reaches
// the conversation until the requester presses Post (diagram) or Save (doc).

import type { AgentRunStatus, ChatCommand } from '@connorhoehn/ui-components/social';

export type ArtifactCommandName = 'diagram' | 'doc';
export interface ArtifactSpan { text: string; messageId: string; author: string }
export interface DiagramNode { id: string; label: string }
export interface DiagramEdge { from: string; to: string }
export interface ArtifactResult {
  command: ArtifactCommandName; title: string; summary: string;
  /** drawio XML (diagram) or markdown (doc). */
  content: string; format: 'drawio' | 'markdown';
  sourceSpans: ArtifactSpan[]; nodes: DiagramNode[]; edges: DiagramEdge[];
  messageCount: number; fallback: boolean; unavailable?: string;
}
export type ArtifactPhase = 'received' | 'running' | 'completed' | 'failed';
/** Where Save can put a page for this conversation's tenant; null: nowhere (no existing document-creation path). */
export type SaveTarget = 'document' | 'attachment' | null;
export interface ArtifactRunStatus {
  runId: string; channel: string; phase: ArtifactPhase;
  steps: Array<{ id: string; label: string; status: 'pending' | 'running' | 'completed' | 'failed' }>;
  error: string | null; posted: boolean; result: ArtifactResult | null; saveTarget?: SaveTarget; savedAs?: string;
}
export interface PostedArtifact { channel: string; text: string; metadata: Record<string, unknown>; saveTarget?: SaveTarget; title?: string }
export interface ArtifactStarted { runId: string; pipelineId: string; card: Record<string, unknown> }

type Fetch = typeof fetch;

export const SOCIAL_ARTIFACT_BASE = '/api/chat/commands';
export const CONVERSATION_ARTIFACT_BASE = '/api/conversations';
export const ARTIFACT_PIPELINE_IDS: Readonly<Record<ArtifactCommandName, string>> = { diagram: 'conversation-diagram', doc: 'conversation-doc' };

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

export interface ArtifactApi {
  command: ArtifactCommandName;
  start(channel: string, argumentText: string, doFetch?: Fetch): Promise<ArtifactStarted>;
  status(runId: string, doFetch?: Fetch): Promise<ArtifactRunStatus>;
  /** /diagram: asks the server for the message to send. Sending it is the caller's explicit act. */
  requestPost(runId: string, doFetch?: Fetch): Promise<PostedArtifact>;
  /** /doc: claims Save once and asks for the reference message. `documentId` is the page the tenant's own route made. */
  requestSave(runId: string, documentId?: string, doFetch?: Fetch): Promise<PostedArtifact>;
}

/** The calls of one command against one mount (`base`). */
export function artifactApi(base: string, command: ArtifactCommandName): ArtifactApi {
  const root = `${base}/${command}`;
  const label = command === 'diagram' ? 'diagram' : 'page';
  return {
    command,
    async start(channel, argumentText, doFetch = fetch) {
      return json(await doFetch(`${root}/run`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, text: argumentText }) }), `The ${label} could not be started.`);
    },
    async status(runId, doFetch = fetch) {
      return json(await doFetch(`${root}/runs/${encodeURIComponent(runId)}`, { credentials: 'include' }), `The ${label} could not be read.`);
    },
    async requestPost(runId, doFetch = fetch) {
      return json(await doFetch(`${root}/runs/${encodeURIComponent(runId)}/post`, { method: 'POST', credentials: 'include' }), 'The diagram could not be posted.');
    },
    async requestSave(runId, documentId, doFetch = fetch) {
      return json(await doFetch(`${root}/runs/${encodeURIComponent(runId)}/save`, { method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(documentId ? { documentId } : {}) }), 'The page could not be saved.');
    },
  };
}

export const socialArtifactApi = (command: ArtifactCommandName): ArtifactApi => artifactApi(SOCIAL_ARTIFACT_BASE, command);
export const conversationArtifactApi = (command: ArtifactCommandName): ArtifactApi => artifactApi(CONVERSATION_ARTIFACT_BASE, command);

export const isTerminal = (s: Pick<ArtifactRunStatus, 'phase'>): boolean => s.phase === 'completed' || s.phase === 'failed';

/** What `AgentRunCard` reads. */
export function agentRunStatusOf(s: ArtifactRunStatus): AgentRunStatus {
  const running = s.steps.find(step => step.status === 'running');
  const noop = s.phase === 'completed' && s.result?.messageCount === 0;
  const what = s.result?.command === 'doc' ? 'page draft' : 'diagram';
  return {
    phase: s.phase,
    details: { steps: s.steps.map(({ id, label, status }) => ({ id, label, status })), ...(s.error ? { error: s.error } : {}) },
    ...(running ? { stepLabel: running.label } : {}),
    ...(noop ? { noop: true, detail: 'There were no messages you can read in this conversation.' } : {}),
    ...(s.phase === 'failed' ? { detail: s.error ?? 'The request failed.' } : {}),
    ...(s.phase === 'completed' && s.result?.fallback ? { detail: s.result.unavailable
      ? `Nova is not available for this conversation (${s.result.unavailable}), so this ${what} is built directly from the thread.`
      : `The model's answer could not be verified, so this ${what} is built directly from the thread.` } : {}),
  };
}

/** The quotes behind the result, as the requester reviews them. */
export function sourcesMarkdown(result: Pick<ArtifactResult, 'sourceSpans'>): string {
  return result.sourceSpans.map(span => `> "${span.text}" — ${span.author}`).join('\n>\n');
}

const usable = (s: ArtifactRunStatus): boolean => s.phase === 'completed' && !s.posted && !s.savedAs && !!s.result && s.result.messageCount > 0;
/** Post is offered only for a finished, non-empty, not-yet-posted diagram. */
export const canPost = (s: ArtifactRunStatus): boolean => usable(s) && s.result!.command === 'diagram';
/** Save is offered only for a finished, non-empty, not-yet-saved page that has somewhere to go. */
export const canSave = (s: ArtifactRunStatus): boolean => usable(s) && s.result!.command === 'doc' && !!s.saveTarget;

/**
 * The `.drawio` / `.md` file a Social post or save attaches, named from the title. The upload
 * allow-list (middleware lib/gateway-attachments.ts) has no drawio or xml type, so the drawio
 * file travels as text/plain — it is plain XML text — rather than widening that list here.
 */
export function artifactFile(result: Pick<ArtifactResult, 'title' | 'content' | 'format'>): File {
  const stem = result.title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'conversation';
  return result.format === 'drawio'
    ? new File([result.content], `${stem}.drawio`, { type: 'text/plain' })
    : new File([result.content], `${stem}.md`, { type: 'text/markdown' });
}

const COPY: Record<ArtifactCommandName, { label: string; hint: string; description: string }> = {
  diagram: {
    label: 'Draw a diagram of this conversation',
    hint: 'Optionally a topic: release flow',
    description: 'Nova reads what you can see of this conversation and draws a diagram, citing the messages it rests on. Only you see it until you post it.',
  },
  doc: {
    label: 'Draft a page from this conversation',
    hint: 'Optionally a title: Runbook',
    description: 'Nova reads what you can see of this conversation and drafts a page, with verbatim quotes. Only you see it until you save it as a document.',
  },
};

/** `/diagram [topic]` or `/doc [title]` against `api` — the private card, not a message. */
export function artifactCommand(api: ArtifactApi): ChatCommand {
  const copy = COPY[api.command];
  return {
    trigger: `/${api.command}`,
    label: copy.label,
    hint: copy.hint,
    description: copy.description,
    scope: 'always',
    async run(ctx) {
      const started = await api.start(ctx.channel, ctx.argumentText);
      return { kind: 'run', runId: started.runId, pipelineId: started.pipelineId, card: started.card,
        echo: ctx.text.trim() || `/${api.command}`, visibility: 'private' };
    },
  };
}

/** The pipeline id of a run outcome names the card to draw: 'diagram' | 'doc', or null for any other command. */
export function artifactKindOf(pipelineId: string | undefined): ArtifactCommandName | null {
  return pipelineId === ARTIFACT_PIPELINE_IDS.diagram ? 'diagram' : pipelineId === ARTIFACT_PIPELINE_IDS.doc ? 'doc' : null;
}
