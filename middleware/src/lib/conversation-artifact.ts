// `/diagram` and `/doc` on a conversation (docs/agentic-flows-migration.md,
// slice 12): one private, durable run per request that reads what the requester
// may read of ONE conversation, asks the drafter for a diagram or a page draft,
// checks every quoted source span against that transcript, and hands back a
// message only when the requester explicitly posts it. It is the sibling of
// lib/conversation-summarize.ts and reuses its transcript, its run store
// (lib/flow-runs) and the rule that WHO may read is decided by the caller.
//
// Agent: `orgiq-assessment-drafter`, document modes that already exist in
// agents/assessment-drafter/document_commands.py:
//   /diagram -> `draw-diagram`           (an uncompressed mxGraphModel, drawio)
//   /doc     -> `draft-confluence-page`  (a markdown page draft)
// Both carry `source_spans`. The drafter's tenant guard serves only
// `assessment` and was NOT widened: other tenants still call it, and its refusal
// lands as the deterministic result with `unavailable` naming why. The model's
// output is validated HERE too: spans must be verbatim single-message quotes of
// lines the requester could read, and a diagram must be plain local mxGraph XML
// (the same checks as the drafter's validator) or the deterministic result
// stands in (`fallback: true`).
//
// Reference: realtime-examples frontend/src/chat/commands/diagramCommand.ts:21
// (`/diagram <title> — <prompt>` creates a diagram board and has the agent draw
// into it) and docCommand.ts:10 (`/doc <instruction>` edits the open document).
// Differences, on purpose: here both are PRIVATE run cards over the readable
// transcript, and nothing is stored or posted without an explicit act.

import { config } from '../config.js';
import { agentcore } from '../providers/index.js';
import {
  flowRunStore, kickFlowRun, registerFlowExecutor,
  type FlowExecutionContext, type FlowRunRow, type FlowRunStep,
} from './flow-runs/index.js';
import {
  MAX_ACTIVE_RUNS_PER_USER, RUN_TTL_MS, MAX_SPANS, MAX_CONTENT, transcriptText,
  type SummarizeSpan, type TranscriptLine,
} from './conversation-summarize.js';

export { MAX_ACTIVE_RUNS_PER_USER, RUN_TTL_MS };

export type ArtifactCommand = 'diagram' | 'doc';
export type ArtifactTenant = 'social' | 'orgiq' | 'assessment' | 'pipelines';
export const ARTIFACT_AGENT_ID = 'orgiq-assessment-drafter';
export const ARTIFACT_MODE: Readonly<Record<ArtifactCommand, string>> = { diagram: 'draw-diagram', doc: 'draft-confluence-page' };
export const MAX_TOPIC = 200;
export const MAX_DIAGRAM_XML = 20_000;
export const MAX_DIAGRAM_NODES = 40;

export interface DiagramNode { id: string; label: string }
export interface DiagramEdge { from: string; to: string }

export interface ArtifactResult {
  command: ArtifactCommand;
  title: string;
  summary: string;
  /** drawio XML for a diagram, markdown for a page draft. Reviewed by the requester, stored nowhere else. */
  content: string;
  format: 'drawio' | 'markdown';
  sourceSpans: SummarizeSpan[];
  /** Diagram only: read back from the validated XML, so the card and the post never parse it again. */
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  messageCount: number;
  fallback: boolean;
  unavailable?: string;
}

// ─── Arguments ──────────────────────────────────────────────────────────────

/** `/diagram [topic]` / `/doc [title]`: free text, bounded, control characters removed. */
export function parseArtifactArgs(text: string, command: ArtifactCommand): { ok: true; topic: string; title: string } | { ok: false; error: string } {
  if (text.length > MAX_TOPIC) return { ok: false, error: `Keep the ${command === 'diagram' ? 'topic' : 'title'} under ${MAX_TOPIC} characters` };
  // eslint-disable-next-line no-control-regex
  const topic = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { ok: true, topic, title: topic || (command === 'diagram' ? 'Conversation diagram' : 'Conversation page') };
}

// ─── Diagram XML (mirrors validate_document_output's drawio checks) ─────────

const ALLOWED_TAGS = new Set(['mxGraphModel', 'root', 'mxCell', 'mxGeometry', 'mxPoint', 'Array']);
const FORBIDDEN_VALUE = /https?:|javascript:|data:|file:|ftp:|\/\/|[<>]|html\s*=\s*1|image\s*=/i;
const unescapeXml = (v: string): string => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escapeXml = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Plain, uncompressed mxGraphModel with local labels and geometry only, or
 * null. Returns the vertices and edges the card draws.
 */
export function parseDiagram(xml: unknown): { nodes: DiagramNode[]; edges: DiagramEdge[] } | null {
  if (typeof xml !== 'string' || !xml.trim() || xml.length > MAX_DIAGRAM_XML) return null;
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<\?/i.test(xml)) return null;
  // Only the five predefined entities: a numeric or custom reference could hide the characters checked below.
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(xml)) return null;
  const trimmed = xml.trim();
  if (!/^<mxGraphModel[\s>]/.test(trimmed) || !/<\/mxGraphModel>\s*$/.test(trimmed) || !/<root[\s>]/.test(trimmed)) return null;
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const tag = /<\/?([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z_:][\w:.-]*\s*=\s*"[^"]*")*)\s*\/?>/g;
  let rest = trimmed;
  for (const match of trimmed.matchAll(tag)) {
    const [whole, name, attrText] = match;
    if (!ALLOWED_TAGS.has(name!)) return null;
    rest = rest.replace(whole!, '');
    if (name === 'mxCell' && !whole!.startsWith('</')) {
      const attrs: Record<string, string> = {};
      for (const a of (attrText ?? '').matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) attrs[a[1]!] = unescapeXml(a[2]!);
      if (attrs['vertex'] === '1' && attrs['id']) nodes.push({ id: attrs['id'], label: (attrs['value'] ?? '').trim() });
      else if (attrs['edge'] === '1' && attrs['source'] && attrs['target']) edges.push({ from: attrs['source'], to: attrs['target'] });
    }
    for (const a of (attrText ?? '').matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
      if (/^on/i.test(a[1]!) || ['link', 'href', 'src', 'image'].includes(a[1]!.toLowerCase())) return null;
      if (FORBIDDEN_VALUE.test(unescapeXml(a[2]!))) return null;
    }
  }
  if (rest.trim()) return null; // text between tags, or markup the scan did not recognise
  const ids = new Set(nodes.map(n => n.id));
  if (nodes.length === 0 || nodes.length > MAX_DIAGRAM_NODES || nodes.some(n => !n.label)) return null;
  if (edges.some(e => !ids.has(e.from) || !ids.has(e.to))) return null;
  return { nodes, edges };
}

/** A label the checks above accept: no markup, URL or double slash. */
const plainLabel = (s: string, max: number): string =>
  s.replace(/[<>"]/g, ' ').replace(/\/\//g, '/').replace(/(https?|javascript|data|file|ftp):/gi, '$1 ').replace(/\s+/g, ' ').trim().slice(0, max);

// ─── Deterministic results ──────────────────────────────────────────────────

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const pick = (lines: readonly TranscriptLine[], max: number): TranscriptLine[] => {
  if (lines.length <= max) return [...lines];
  return [...new Set(Array.from({ length: max }, (_, i) => Math.round((i * (lines.length - 1)) / (max - 1))))].map(i => lines[i]!);
};

/** Model-free diagram: the topic, then up to six messages in order, each a node; labels clip the message verbatim. */
export function diagramDigest(lines: readonly TranscriptLine[], title: string): { summary: string; content: string; format: 'drawio'; source_spans: string[] } {
  const picks = pick(lines, 6);
  const cells = [`<mxCell id="0"/>`, `<mxCell id="1" parent="0"/>`,
    `<mxCell id="topic" value="${escapeXml(plainLabel(title, 80) || 'Conversation')}" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="40" y="20" width="200" height="50" as="geometry"/></mxCell>`];
  picks.forEach((l, i) => {
    cells.push(`<mxCell id="m${i}" value="${escapeXml(plainLabel(`${l.author}: ${clip(l.text, 70)}`, 110))}" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="40" y="${110 + i * 90}" width="320" height="60" as="geometry"/></mxCell>`);
    cells.push(`<mxCell id="e${i}" edge="1" parent="1" source="${i === 0 ? 'topic' : `m${i - 1}`}" target="m${i}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
  });
  return {
    summary: `A flow of ${picks.length} message${picks.length === 1 ? '' : 's'} from the thread, in order.`,
    content: `<mxGraphModel><root>${cells.join('')}</root></mxGraphModel>`,
    format: 'drawio',
    source_spans: picks.map(l => clip(l.text, 70)),
  };
}

/** Model-free page draft: what the thread says, quoted, kept apart from anything proposed. */
export function pageDigest(lines: readonly TranscriptLine[], title: string): { summary: string; content: string; format: 'markdown'; source_spans: string[] } {
  const picks = pick(lines, 8);
  const quotes = picks.map(l => ({ author: l.author, text: clip(l.text, 200) }));
  const people = new Set(lines.map(l => l.author));
  const summary = `${lines.length} message${lines.length === 1 ? '' : 's'} from ${people.size} ${people.size === 1 ? 'person' : 'people'}.`;
  return {
    summary,
    content: [`# ${title}`, '', '## From the conversation', summary, '', ...quotes.map(q => `- ${q.author}: "${q.text}"`), '',
      '## To decide', 'Nothing is proposed here; add decisions and next steps once the page is saved.'].join('\n'),
    format: 'markdown',
    source_spans: quotes.map(q => q.text),
  };
}

// ─── Acceptance ─────────────────────────────────────────────────────────────

/**
 * The agent's envelope for `command`, only if its format matches, every quote
 * is verbatim in ONE message line, and (diagram) the XML is plain mxGraph.
 */
export function acceptArtifactEnvelope(command: ArtifactCommand, raw: unknown, lines: readonly TranscriptLine[], title: string): ArtifactResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const { summary, content, source_spans: spans } = v;
  const format = command === 'diagram' ? 'drawio' : 'markdown';
  if (typeof summary !== 'string' || !summary.trim() || summary.length > 800) return null;
  if (typeof content !== 'string' || !content.trim() || content.length > (command === 'diagram' ? MAX_DIAGRAM_XML : MAX_CONTENT)) return null;
  if (v['format'] !== format) return null;
  if (!Array.isArray(spans) || spans.length < 1 || spans.length > MAX_SPANS) return null;
  const sourceSpans: SummarizeSpan[] = [];
  for (const span of spans) {
    if (typeof span !== 'string' || !span || span.includes('\n')) return null;
    const line = lines.find(l => l.text.includes(span));
    if (!line) return null;
    sourceSpans.push({ text: span, messageId: line.messageId, author: line.author });
  }
  const graph = command === 'diagram' ? parseDiagram(content) : { nodes: [], edges: [] };
  if (!graph) return null;
  return { command, title, summary: summary.trim(), content: content.trim(), format, sourceSpans, nodes: graph.nodes, edges: graph.edges,
    messageCount: lines.length, fallback: false };
}

// ─── Durable run (lib/flow-runs) ────────────────────────────────────────────

const stepsFor = (command: ArtifactCommand): FlowRunStep[] => [
  { id: 'read-history', label: 'Read the conversation', status: 'completed' },
  { id: 'draft', label: command === 'diagram' ? 'Draw the diagram (Nova)' : 'Draft the page (Nova)', status: 'pending' },
  { id: 'check', label: 'Check every quote against the thread', status: 'pending' },
];
const withStatus = (steps: readonly FlowRunStep[], id: string, status: FlowRunStep['status']): FlowRunStep[] =>
  steps.map(s => (s.id === id ? { ...s, status } : s));
const PHASE: Record<FlowRunRow['status'], 'received' | 'running' | 'completed' | 'failed'> = { queued: 'received', running: 'running', 'waiting-approval': 'running', completed: 'completed', failed: 'failed' };

/** The wire status both artifact routers answer. */
export function artifactStatus(run: FlowRunRow): Record<string, unknown> {
  const posted = run.meta['postedAt'];
  const savedAs = run.meta['savedAs'];
  return {
    runId: run.id, channel: run.scope, phase: PHASE[run.status], steps: run.progress, error: run.error,
    posted: typeof posted === 'string', result: (run.result as ArtifactResult | null) ?? null, updatedAt: run.updatedAt,
    ...(typeof savedAs === 'string' ? { savedAs } : {}),
  };
}

export interface ArtifactFlowSpec {
  tenant: ArtifactTenant;
  command: ArtifactCommand;
  kind: string;
  /** The run id prefix; lib/flow-runs/channel.ts maps it to the tenant's private push channel. */
  idPrefix: string;
  /** Send the drafter an `auth` block for the tenant and report a refusal as `unavailable` (not Social's original summarize shape). */
  agentAuth: boolean;
}

export interface ArtifactFlow {
  spec: ArtifactFlowSpec;
  getRunFor(userId: string, id: string): Promise<FlowRunRow | null>;
  findRun(id: string): Promise<FlowRunRow | null>;
  activeRunCount(userId: string): Promise<number>;
  startRun(input: { userId: string; channel: string; title: string; topic: string; lines: readonly TranscriptLine[] }): Promise<FlowRunRow>;
  /** Atomic once-only claim of the post; false when it was already posted. */
  markPosted(run: FlowRunRow): Promise<boolean>;
  /** Atomic once-only claim of Save (a page draft); false when it was already saved. */
  markSaved(run: FlowRunRow, as: string): Promise<boolean>;
  executor(ctx: FlowExecutionContext): Promise<{ result: ArtifactResult; progress: FlowRunStep[] }>;
}

async function draft(spec: ArtifactFlowSpec, run: FlowRunRow, lines: readonly TranscriptLine[], title: string, topic: string): Promise<{ envelope: unknown; unavailable?: string }> {
  const digest = spec.command === 'diagram' ? diagramDigest : pageDigest;
  if (config.mock.agentcore) return { envelope: digest(lines, title) };
  const mode = ARTIFACT_MODE[spec.command];
  try {
    const out = await agentcore.invokeAgent(ARTIFACT_AGENT_ID, {
      message: `Execute ${spec.tenant} command ${mode}`,
      structuredInput: { tenant: spec.tenant, command: mode, mode, run_id: run.id,
        document: { text: transcriptText(lines) }, instruction: topic ? `Topic: ${topic}` : `Title: ${title}`,
        ...(spec.agentAuth ? { auth: { tenant: spec.tenant, sub: run.requestedBy } } : {}) },
      timeoutMs: 120_000,
    });
    if (out.raw && typeof out.raw === 'object' && 'error' in out.raw) {
      return { envelope: null, unavailable: String((out.raw as { detail?: unknown; error: unknown }).detail ?? (out.raw as { error: unknown }).error) };
    }
    return { envelope: JSON.parse(out.text) };
  } catch (error) {
    return { envelope: null, unavailable: error instanceof Error ? error.message : 'the drafter failed' };
  }
}

/** One tenant's `/diagram` or `/doc` flow on the shared durable store. Registers its executor. */
export function defineArtifactFlow(spec: ArtifactFlowSpec): ArtifactFlow {
  const executor = async (ctx: FlowExecutionContext): Promise<{ result: ArtifactResult; progress: FlowRunStep[] }> => {
    const { run } = ctx;
    const lines = (Array.isArray(run.input?.['lines']) ? run.input!['lines'] : []) as TranscriptLine[];
    const title = typeof run.input?.['title'] === 'string' ? run.input['title'] as string : '';
    const topic = typeof run.input?.['topic'] === 'string' ? run.input['topic'] as string : '';
    const format = spec.command === 'diagram' ? 'drawio' : 'markdown';
    let steps = withStatus(run.progress.length ? run.progress : stepsFor(spec.command), 'draft', 'running');
    await ctx.report(steps);
    if (lines.length === 0) {
      steps = withStatus(withStatus(steps, 'draft', 'completed'), 'check', 'completed');
      return { result: { command: spec.command, title, summary: 'Nothing to work from.', content: 'There are no messages you can read in this conversation.',
        format, sourceSpans: [], nodes: [], edges: [], messageCount: 0, fallback: false }, progress: steps };
    }
    const drafted = await draft(spec, run, lines, title, topic);
    steps = withStatus(withStatus(steps, 'draft', 'completed'), 'check', 'running');
    await ctx.report(steps);
    let result = acceptArtifactEnvelope(spec.command, drafted.envelope, lines, title);
    if (!result) {
      const digest = acceptArtifactEnvelope(spec.command, (spec.command === 'diagram' ? diagramDigest : pageDigest)(lines, title), lines, title);
      if (!digest) throw new Error('The result could not be verified against the conversation.');
      result = { ...digest, fallback: true, ...(spec.agentAuth && drafted.unavailable ? { unavailable: drafted.unavailable } : {}) };
    }
    return { result, progress: withStatus(steps, 'check', 'completed') };
  };
  registerFlowExecutor(spec.kind, executor);
  return {
    spec,
    executor,
    getRunFor: (userId, id) => flowRunStore.getFor(spec.tenant, userId, id),
    async findRun(id) {
      const run = await flowRunStore.get(id);
      return run && run.tenant === spec.tenant && run.kind === spec.kind ? run : null;
    },
    activeRunCount: userId => flowRunStore.countActive(spec.tenant, spec.kind, userId),
    async startRun(input) {
      await flowRunStore.prune(spec.kind, RUN_TTL_MS);
      const run = await flowRunStore.create({
        tenant: spec.tenant, kind: spec.kind, requestedBy: input.userId, scope: input.channel, idPrefix: spec.idPrefix,
        maxAttempts: 2, progress: stepsFor(spec.command),
        input: { lines: input.lines, title: input.title, topic: input.topic },
      });
      kickFlowRun(run.id, spec.kind);
      return run;
    },
    markPosted: run => flowRunStore.setMetaOnce(run.id, run.requestedBy, 'postedAt', new Date().toISOString()),
    markSaved: (run, as) => flowRunStore.setMetaOnce(run.id, run.requestedBy, 'savedAs', as),
  };
}

// ─── The message "Post" sends ───────────────────────────────────────────────

/** The chat service's message limit (the gateway answers "between 1 and 1000 characters"). */
export const MAX_MESSAGE_CHARS = 1000;
const fit = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`);

/**
 * The diagram as words, numbered so an arrow is short: each box, then each
 * arrow. A reader without the file still gets the structure.
 */
export function diagramOutline(r: Pick<ArtifactResult, 'nodes' | 'edges'>): string {
  const index = new Map(r.nodes.map((n, i) => [n.id, i + 1]));
  const arrows = r.edges.map(e => `${index.get(e.from) ?? '?'} → ${index.get(e.to) ?? '?'}`).join(', ');
  return [...r.nodes.map((n, i) => `${i + 1}. ${fit(n.label, 90)}`), ...(arrows ? ['', `Flow: ${arrows}`] : [])].join('\n');
}

/**
 * The message "Post to conversation" sends, built from the stored result and
 * never from the request, and short enough for one chat message: the outline
 * first, then as many source quotes as fit. A diagram carries `artifactOf` (its
 * boxes and arrows); Social also attaches the drawio file. A page draft is
 * posted only by Save (its reference), never as a bare draft.
 */
export function artifactPostMessage(run: FlowRunRow): { text: string; metadata: Record<string, unknown> } | null {
  const r = run.result as ArtifactResult | null;
  if (!r || r.messageCount === 0 || r.command !== 'diagram') return null;
  let text = fit(`Diagram: ${r.title}\n\n${diagramOutline(r)}`, MAX_MESSAGE_CHARS);
  const quotes: string[] = [];
  for (const s of r.sourceSpans) {
    const line = `> "${fit(s.text, 80)}" — ${s.author}`;
    if (`${text}\n\nSources\n${[...quotes, line].join('\n')}`.length > MAX_MESSAGE_CHARS) break;
    quotes.push(line);
  }
  if (quotes.length) text = `${text}\n\nSources\n${quotes.join('\n')}`;
  return {
    text,
    metadata: { artifactOf: { command: 'diagram', runId: run.id, title: r.title, nodes: r.nodes, edges: r.edges,
      sourceMessageIds: r.sourceSpans.map(s => s.messageId), fallback: r.fallback } },
  };
}

/** What Save shows in the conversation: the page's title and, when the tenant's document store minted one, its id. Never the body. */
export function pageReferenceMessage(run: FlowRunRow, savedId: string | null): { text: string; metadata: Record<string, unknown> } | null {
  const r = run.result as ArtifactResult | null;
  if (!r || r.messageCount === 0 || r.command !== 'doc') return null;
  const head = `Page: ${fit(r.title, 200)}\n\n`;
  return {
    text: `${head}${fit(r.summary, MAX_MESSAGE_CHARS - head.length)}`,
    metadata: { ...(savedId ? { documents: [{ id: savedId, label: r.title }] } : {}),
      artifactOf: { command: 'doc', runId: run.id, title: r.title, ...(savedId ? { documentId: savedId } : {}), sourceMessageIds: r.sourceSpans.map(s => s.messageId), fallback: r.fallback } },
  };
}
