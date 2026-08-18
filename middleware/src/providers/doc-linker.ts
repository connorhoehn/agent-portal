// Document → graph linker.
//
// The stale-docs sweep finds documents nothing references. Until now that
// finding had no route to resolution: a devbox worker could write a plan about
// why extraction missed it, but nothing could actually link the document. This
// closes that loop — pull the document's real text, ask a model which KNOWN
// entities it references, and emit proposals a human approves before anything
// touches the graph.
//
// Three properties matter more than extraction quality:
//
//   1. Closed vocabulary. The model is given the candidate entities and may
//      only choose from them. Ids it invents are dropped, not written. An
//      earlier hand-written proposal referenced `s-mlops` when the real id was
//      `sk-mlops`; that failed loudly at apply time, which is the good case —
//      here we refuse it before it ever becomes a proposal.
//   2. Evidence, not assertions. Every proposal carries the surface form the
//      model claims to have found, and that quote is verified to actually
//      appear in the document. A reviewer can check the claim without leaving
//      the page, and a fabricated quote is dropped.
//   3. Nothing auto-applies. Output is `pending` proposals. The human approval
//      gate is the whole point of the graph write-back path.

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { proposeGraphChange, type GraphProposal } from './graph-proposals.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

const MODEL_ID = process.env['DOC_LINKER_MODEL_ID'] ?? 'amazon.nova-pro-v1:0';
/** Documents are short; more than this is a corpus problem, not a doc problem. */
const MAX_DOC_CHARS = 12_000;
/** Enough vocabulary to be useful without turning the prompt into the database. */
const MAX_CANDIDATES = 400;
/** A model that "finds" twenty entities in one news article is pattern-matching. */
const MAX_LINKS = 12;

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }

let _s3: S3Client | null = null;
let _bedrock: BedrockRuntimeClient | null = null;
const s3 = (): S3Client => (_s3 ??= new S3Client({}));
const bedrock = (): BedrockRuntimeClient => (_bedrock ??= new BedrockRuntimeClient({}));

export interface Candidate {
  entityType: 'person' | 'skill' | 'project' | 'decision';
  entityId: string;
  name: string;
}

export interface ProposedLink {
  entityType: string;
  entityId: string;
  name: string;
  /** The text the model says shows this entity is referenced. */
  quote: string;
  confidence: number;
}

export interface LinkAnalysis {
  documentId: string;
  title: string;
  /** Characters of document text actually analysed (0 = could not read it). */
  textLength: number;
  candidatesConsidered: number;
  links: ProposedLink[];
  proposals: GraphProposal[];
  /** Set when the analysis could not run; links/proposals will be empty. */
  problem?: string;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

interface DocRow { id: string; title: string; source: string | null; sourceUri: string | null }

async function loadDocument(documentId: string): Promise<DocRow | null> {
  const rows = await exec(
    `SELECT id, title, source, source_uri FROM documents WHERE id = :id`,
    [s('id', documentId)],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: toStr(r['id']),
    title: toStr(r['title']),
    source: r['source'] ? toStr(r['source']) : null,
    sourceUri: r['source_uri'] ? toStr(r['source_uri']) : null,
  };
}

/** Fetch the document body from the S3 URI recorded at ingest. */
async function fetchText(sourceUri: string | null): Promise<string> {
  if (!sourceUri?.startsWith('s3://')) return '';
  const withoutScheme = sourceUri.slice('s3://'.length);
  const slash = withoutScheme.indexOf('/');
  if (slash < 0) return '';
  const Bucket = withoutScheme.slice(0, slash);
  const Key = withoutScheme.slice(slash + 1);
  const obj = await s3().send(new GetObjectCommand({ Bucket, Key }));
  const body = await obj.Body?.transformToString('utf-8');
  return (body ?? '').slice(0, MAX_DOC_CHARS);
}

/**
 * The closed vocabulary the model must choose from.
 *
 * Decisions are included as `topic` because that is what a document would
 * actually name; people/skills/projects use their display name.
 */
export async function loadCandidates(): Promise<Candidate[]> {
  const rows = await exec(
    `SELECT 'person' AS t, id, name FROM people
     UNION ALL SELECT 'skill', id, name FROM skills
     UNION ALL SELECT 'project', id, name FROM projects
     UNION ALL SELECT 'decision', id, topic FROM decisions
     LIMIT ${MAX_CANDIDATES}`,
  );
  return rows.map((r) => ({
    entityType: toStr(r['t']) as Candidate['entityType'],
    entityId: toStr(r['id']),
    name: toStr(r['name']),
  })).filter((c) => c.entityId && c.name);
}

// ── Extraction ───────────────────────────────────────────────────────────────

function buildPrompt(doc: DocRow, text: string, candidates: Candidate[]): string {
  const vocabulary = candidates
    .map((c) => `${c.entityId}\t${c.entityType}\t${c.name}`)
    .join('\n');
  return [
    'You are linking a document to entities in an organizational knowledge graph.',
    '',
    'Below is a CLOSED LIST of known entities (id, type, name), then the document.',
    'Return ONLY entities from the list that the document genuinely refers to.',
    '',
    'Rules:',
    '- Use entity ids EXACTLY as written in the list. Never invent an id.',
    '- Only include an entity if the document actually refers to it. A document',
    '  about databases does not "reference" every engineer who knows databases.',
    '- For each match, quote the exact span from the document that shows it.',
    '  The quote must appear verbatim in the document.',
    '- If nothing in the list is genuinely referenced, return an empty array.',
    `- Return at most ${MAX_LINKS} entities.`,
    '',
    'Respond with JSON only, in this shape:',
    '{"links":[{"entityId":"...","entityType":"...","quote":"...","confidence":0.0}]}',
    '',
    '--- KNOWN ENTITIES ---',
    vocabulary,
    '',
    `--- DOCUMENT: ${doc.title} ---`,
    text,
  ].join('\n');
}

/** Nova returns its text inside output.message.content[].text. */
function extractModelText(body: unknown): string {
  const b = body as { output?: { message?: { content?: Array<{ text?: string }> } } };
  return (b.output?.message?.content ?? []).map((c) => c.text ?? '').join('');
}

/** Models wrap JSON in prose or fences often enough to be worth handling. */
function parseFirstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }
}

/**
 * Keep only links that name a real candidate AND quote text that is really in
 * the document. Both checks exist because the failure mode of a extraction
 * model is confident invention, and a proposal is a write to the graph.
 */
export function validateLinks(
  raw: unknown,
  candidates: Candidate[],
  text: string,
): ProposedLink[] {
  const byId = new Map(candidates.map((c) => [c.entityId, c]));
  const list = Array.isArray(raw) ? raw : [];
  const haystack = text.toLowerCase();
  const seen = new Set<string>();
  const out: ProposedLink[] = [];

  for (const item of list) {
    const l = item as Record<string, unknown>;
    const entityId = toStr(l['entityId']).trim();
    const candidate = byId.get(entityId);
    if (!candidate) continue;                                  // invented or stale id
    if (seen.has(entityId)) continue;                          // duplicate claim
    const quote = toStr(l['quote']).trim();
    if (!quote || !haystack.includes(quote.toLowerCase())) continue;  // unverifiable claim

    const rawConfidence = Number(l['confidence']);
    const confidence = Number.isFinite(rawConfidence)
      ? Math.min(Math.max(rawConfidence, 0), 1)
      : 0.5;

    seen.add(entityId);
    out.push({
      entityType: candidate.entityType,
      entityId: candidate.entityId,
      name: candidate.name,
      quote: quote.slice(0, 300),
      confidence,
    });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Analyse a document and propose the mentions it should have.
 *
 * Never throws for expected failures (missing document, unreadable S3 object,
 * model unavailable) — those are reported as `problem` so the caller can show
 * the operator why nothing was proposed instead of a 500.
 */
export async function analyzeDocumentLinks(
  documentId: string,
  opts: { findingId?: string; dryRun?: boolean } = {},
): Promise<LinkAnalysis> {
  const base: LinkAnalysis = {
    documentId, title: '', textLength: 0, candidatesConsidered: 0, links: [], proposals: [],
  };
  if (config.mock.aurora) return { ...base, problem: 'Aurora is mocked' };

  const doc = await loadDocument(documentId);
  if (!doc) return { ...base, problem: `document ${documentId} not found` };
  base.title = doc.title;

  let text = '';
  try {
    text = await fetchText(doc.sourceUri);
  } catch (err) {
    return { ...base, problem: `could not read ${doc.sourceUri}: ${(err as Error).message}` };
  }
  if (!text.trim()) {
    return { ...base, problem: doc.sourceUri ? 'document body was empty' : 'document has no source_uri to read' };
  }
  base.textLength = text.length;

  const candidates = await loadCandidates();
  base.candidatesConsidered = candidates.length;
  if (candidates.length === 0) return { ...base, problem: 'no entities in the graph to link against' };

  let modelText: string;
  try {
    const res = await bedrock().send(new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        messages: [{ role: 'user', content: [{ text: buildPrompt(doc, text, candidates) }] }],
        inferenceConfig: { maxTokens: 1500, temperature: 0 },
      }),
    }));
    modelText = extractModelText(JSON.parse(new TextDecoder().decode(res.body)));
  } catch (err) {
    return { ...base, problem: `extraction model failed: ${(err as Error).message}` };
  }

  const parsed = parseFirstJsonObject(modelText);
  if (!parsed) return { ...base, problem: 'extraction model did not return JSON' };

  const links = validateLinks(parsed['links'], candidates, text);
  base.links = links;
  if (links.length === 0 || opts.dryRun) return base;

  // One proposal per link, each reviewable on its own — a reviewer should be
  // able to accept the two obvious ones and reject the speculative third.
  const proposals: GraphProposal[] = [];
  for (const link of links) {
    const p = await proposeGraphChange({
      source: 'analyzer:doc-linker',
      kind: 'link_document_mention',
      targetType: 'document',
      targetId: doc.id,
      payload: { documentId: doc.id, entityType: link.entityType, entityId: link.entityId },
      rationale: `"${doc.title}" refers to ${link.entityType} ${link.name}`,
      evidence: { quote: link.quote, model: MODEL_ID, sourceUri: doc.sourceUri },
      confidence: link.confidence,
      ...(opts.findingId ? { findingId: opts.findingId } : {}),
    });
    if (p) proposals.push(p);
  }
  base.proposals = proposals;
  return base;
}
