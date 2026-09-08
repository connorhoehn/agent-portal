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

import { clock } from './core/clock.js';

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

export const MOCK_PROMPT_LIBRARY: MockPrompt[] = [
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

export function findMockPrompt(promptId: string): MockPrompt | undefined {
  return MOCK_PROMPT_LIBRARY.find((p) => p.id === promptId);
}
