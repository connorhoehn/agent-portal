// Mock Bedrock Prompt Library for the Prompt Studio surface
// (routes/canary-library.ts, mounted at /api/observability/canary/library).
//
// In dev:mock there is no Bedrock to call, so every GET on that router 503s
// with `{"error":"Bedrock unavailable","detail":"The security token included
// in the request is invalid."}` — which PromptsPage.tsx used to render
// alongside its own "No prompts yet" empty state at the same time
// (DEFECTS.md #8). This fixture gives dev:mock a real-looking library
// instead: one system prompt per deployed agent (matching the
// `orgiq-<agent>-system-prompt` naming CLAUDE.md documents as the live
// convention), each with a DRAFT version carrying real template text — so
// Prompt Studio's list, rail, and view panel all render something instead of
// leaking Bedrock's error shape.
//
// Gated the same way every other offline fixture in this codebase is —
// `config.mock.aurora` (see providers/prompt-library.ts's MOCK_ASSETS for the
// precedent of reusing that flag for a Bedrock-backed catalog too; dev:mock
// sets MOCK_AURORA=true alongside MOCK_AGENTCORE/MOCK_GUARDRAILS/
// MOCK_CLOUDWATCH, so this is consistent with "the mock is the contract".

// ⚠️ The library is a REGISTERED fixture, not a module-scope array. It was an
// array until the write half of this router was closed: `POST /library`,
// `PUT /library/:id/draft` and `POST /library/:id/publish` called
// CreatePrompt/UpdatePrompt/CreatePromptVersion against real Bedrock even in
// dev:mock — the three `config.mock` branches on this router were all on GETs,
// so Prompt Studio read as mocked while its writes were live. A write has to
// land somewhere `POST /api/__mock/reset` can take it back from, and that
// means a fixture.

import { clock, defineFixture } from './core/index.js';
import { liveRows } from './live.js';

const ago = (h: number) => clock.hoursAgo(h);

export interface MockPromptVariant {
  name: string;
  modelId: string;
  templateType: 'TEXT';
  templateText: string;
  inputVariables: string[];
  inferenceConfig: { temperature: number; maxTokens: number };
}

export interface MockPromptVersion {
  version: string; // 'DRAFT' or a numeric string
  arn: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  variant: MockPromptVariant;
}

export interface MockPrompt {
  id: string;
  name: string;
  description: string;
  versions: MockPromptVersion[]; // DRAFT first
}

function draft(
  agentId: string,
  displayName: string,
  description: string,
  templateText: string,
  hoursAgo: number,
): MockPrompt {
  const id = `mock-${agentId}-system-prompt`;
  const arn = `arn:aws:bedrock:us-east-1:000000000000:prompt/${id}`;
  const inputVariables = [...new Set(
    [...templateText.matchAll(/{{([^}]+)}}/g)].map((m) => (m[1] ?? '').trim()),
  )].filter(Boolean);
  return {
    id,
    name: `orgiq-${agentId}-system-prompt`,
    description,
    versions: [
      {
        version: 'DRAFT',
        arn: `${arn}:DRAFT`,
        description,
        createdAt: ago(hoursAgo + 48),
        updatedAt: ago(hoursAgo),
        variant: {
          name: 'default',
          modelId: 'amazon.nova-pro-v1:0',
          templateType: 'TEXT',
          templateText,
          inputVariables,
          inferenceConfig: { temperature: 0.4, maxTokens: 2048 },
        },
      },
    ],
  };
}

function seedLibrary(): MockPrompt[] {
  return [
  draft(
    'supervisor', 'Supervisor · system prompt',
    'Routes an org question to the right sub-agent and composes the answer.',
    'You are the OrgIQ supervisor. Read {{user_query}}, decide which specialist ' +
      'agent (search, scoring, advisor, ingestion, graph-builder) should answer it, ' +
      'invoke that agent, and compose a single grounded answer with citations.',
    2,
  ),
  draft(
    'search', 'Search · system prompt',
    'Finds people, skills and decisions in the org graph and cites them.',
    'You are the OrgIQ search agent. Given {{user_query}}, search the knowledge ' +
      'base and the Aurora org graph for people, skills, and decisions that answer ' +
      'it. Always cite the document or graph node each claim came from.',
    6,
  ),
  draft(
    'scoring', 'Scoring · system prompt',
    'Computes and explains expertise, PageRank, and composite scores.',
    'You are the OrgIQ scoring agent. Compute or explain {{metric}} for the person ' +
      'or team named in {{subject}}, using the graph tools available to you, and ' +
      'state which signals drove the number.',
    10,
  ),
  draft(
    'advisor', 'Advisor · system prompt',
    'Analyzes graph patterns and recommends pairings or gap remediations.',
    'You are the OrgIQ advisor agent. Analyze the org graph around {{initiative}} ' +
      'for bus-factor risk, knowledge gaps, or pairing opportunities, and recommend ' +
      'one concrete next step.',
    14,
  ),
  draft(
    'ingestion', 'Ingestion · system prompt',
    'Extracts entities and decisions from a newly ingested document.',
    'You are the OrgIQ ingestion agent. Given the document at {{source_uri}}, ' +
      'extract entities, decisions, and org-chart changes, then hand them to the ' +
      'graph-builder agent to merge.',
    20,
  ),
  draft(
    'graph-builder', 'Graph Builder · system prompt',
    'Merges extracted entities into the Aurora org graph idempotently.',
    'You are the OrgIQ graph-builder agent. Merge the entities and edges in ' +
      '{{batch}} into the org graph using ON CONFLICT DO UPDATE, validating the ' +
      'schema before every write.',
    26,
  ),
  ];
}

/**
 * `default` — one system prompt per deployed agent, each with a DRAFT.
 * `empty`   — the account holds no prompts at all, which is what Prompt
 *             Studio's "create your first prompt" state is written for and
 *             what a fresh account actually looks like.
 */
export const promptLibrary = defineFixture<MockPrompt>({
  key: 'canary-prompt-library',
  scenarios: {
    default: seedLibrary,
    empty: () => [],
  },
});

/** Live view — see mock/live.ts. Callers keep reading it as an array. */
export const MOCK_PROMPT_LIBRARY: MockPrompt[] = liveRows(promptLibrary);

export function findMockPrompt(promptId: string): MockPrompt | undefined {
  return promptLibrary.rows().find((p) => p.id === promptId);
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** The ARN shape every row in this fixture uses. One place, so a created
 *  prompt is addressable by exactly the same rule as a seeded one. */
function promptArn(id: string): string {
  return `arn:aws:bedrock:us-east-1:000000000000:prompt/${id}`;
}

/** `{{var}}` names in a template — what CreatePrompt derives inputVariables
 *  from, reproduced here so a created prompt carries the same list. */
function templateVariables(templateText: string): string[] {
  return [...new Set(
    [...templateText.matchAll(/{{([^}]+)}}/g)].map((m) => (m[1] ?? '').trim()),
  )].filter(Boolean);
}

export interface MockCreatePromptInput {
  name: string;
  description?: string;
  templateText: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
}

/**
 * CreatePrompt: a new prompt whose only version is DRAFT.
 *
 * Bedrock mints an opaque 10-character id; a slug of the name is used here
 * instead so an offline id is legible in a URL and stable across a rerun of
 * the same request. The `mock-` prefix keeps it impossible to mistake for one
 * Bedrock issued.
 */
export function mockCreatePrompt(input: MockCreatePromptInput): MockPrompt {
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const id = `mock-${slug || 'prompt'}`;
  const now = clock.nowIso();
  const prompt: MockPrompt = {
    id,
    name: input.name,
    description: input.description ?? '',
    versions: [
      {
        version: 'DRAFT',
        arn: `${promptArn(id)}:DRAFT`,
        description: input.description ?? '',
        createdAt: now,
        updatedAt: now,
        variant: {
          name: 'default',
          modelId: input.modelId,
          templateType: 'TEXT',
          templateText: input.templateText,
          inputVariables: templateVariables(input.templateText),
          inferenceConfig: { temperature: input.temperature, maxTokens: input.maxTokens },
        },
      },
    ],
  };
  promptLibrary.rows().push(prompt);
  return prompt;
}

/**
 * UpdatePrompt on the DRAFT variant.
 *
 * Returns null when there is no such prompt, so the route can answer 404
 * rather than report a save that moved nothing — the failure mode this whole
 * slice exists to remove.
 */
export function mockUpdateDraft(
  promptId: string,
  patch: { name: string; templateText: string; modelId?: string; temperature?: number; maxTokens?: number },
): MockPrompt | null {
  const prompt = findMockPrompt(promptId);
  const draftVersion = prompt?.versions.find((v) => v.version === 'DRAFT');
  if (!prompt || !draftVersion) return null;
  prompt.name = patch.name;
  draftVersion.updatedAt = clock.nowIso();
  draftVersion.variant = {
    ...draftVersion.variant,
    templateText: patch.templateText,
    inputVariables: templateVariables(patch.templateText),
    ...(patch.modelId ? { modelId: patch.modelId } : {}),
    inferenceConfig: {
      temperature: patch.temperature ?? draftVersion.variant.inferenceConfig.temperature,
      maxTokens: patch.maxTokens ?? draftVersion.variant.inferenceConfig.maxTokens,
    },
  };
  return prompt;
}

/**
 * CreatePromptVersion: freeze the current DRAFT as the next numbered version.
 *
 * The number is derived from the versions already present rather than stored
 * as a counter (contract.ts rule 1), so it stays right across a reset.
 */
export function mockPublishVersion(
  promptId: string,
  description?: string,
): { prompt: MockPrompt; version: MockPromptVersion } | null {
  const prompt = findMockPrompt(promptId);
  const draftVersion = prompt?.versions.find((v) => v.version === 'DRAFT');
  if (!prompt || !draftVersion) return null;
  const highest = prompt.versions
    .map((v) => Number.parseInt(v.version, 10))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0);
  const version = String(highest + 1);
  const frozen: MockPromptVersion = {
    version,
    arn: `${promptArn(prompt.id)}:${version}`,
    description: description ?? draftVersion.description,
    createdAt: clock.nowIso(),
    updatedAt: clock.nowIso(),
    // A published version is a COPY of the draft: editing the draft afterwards
    // must not retroactively change what was published.
    variant: { ...draftVersion.variant },
  };
  // DRAFT stays first — every reader of this fixture takes versions[0] as the
  // draft, and the router's own list is DRAFT-first too.
  prompt.versions.splice(1, 0, frozen);
  return { prompt, version: frozen };
}
