// Canary Prompt Library — CRUD surface over Bedrock Prompt Library.
//
// Mounted at /api/observability/canary/library. Lets operators browse all
// prompts in the account, inspect/edit DRAFT variants, and publish new frozen
// versions — without leaving the OrgIQ portal.
//
// All Bedrock calls are swallowed gracefully: if the SDK throws (IAM perms
// not wired up, offline dev, throttle) a 503 is returned so the portal can
// degrade without an uncaught 500.

import { Router } from 'express';
import {
  BedrockAgentClient,
  ListPromptsCommand,
  GetPromptCommand,
  UpdatePromptCommand,
  CreatePromptCommand,
  CreatePromptVersionCommand,
  type PromptInferenceConfiguration,
} from '@aws-sdk/client-bedrock-agent';
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { recordBffCall } from '../providers/spend-ledger.js';
import {
  BedrockAgentRuntimeClient,
  OptimizePromptCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { requireAction } from '../lib/authz.js';
import { prepareValues, EMPTY_CONTRACT, type PromptContract } from '../lib/prompt-contract.js';
import { exec as auroraExec } from '../providers/aurora.js';
import { config } from '../config.js';
import {
  MOCK_PROMPT_LIBRARY,
  findMockPrompt,
  mockCreatePrompt,
  mockPublishVersion,
  mockUpdateDraft,
} from '../mock/canary-library.js';
import { offlineInvokePrompt, offlineOptimize } from '../mock/prompt-studio.js';

export const canaryLibraryRouter = Router();

let _bedrockAgent: BedrockAgentClient | null = null;
function bedrockAgent(): BedrockAgentClient {
  if (!_bedrockAgent) _bedrockAgent = new BedrockAgentClient({ region: config.region });
  return _bedrockAgent;
}

let _bedrockRuntime: BedrockRuntimeClient | null = null;
function bedrockRuntime(): BedrockRuntimeClient {
  if (!_bedrockRuntime) _bedrockRuntime = new BedrockRuntimeClient({ region: config.region });
  return _bedrockRuntime;
}

let _bedrockAgentRuntime: BedrockAgentRuntimeClient | null = null;
function bedrockAgentRuntime(): BedrockAgentRuntimeClient {
  if (!_bedrockAgentRuntime) _bedrockAgentRuntime = new BedrockAgentRuntimeClient({ region: config.region });
  return _bedrockAgentRuntime;
}

// Express ParamsDictionary types values as `string | string[]`. These
// helpers narrow to `string` safely — route params are always single strings.
function paramStr(v: string | string[]): string {
  return Array.isArray(v) ? (v[0] ?? '') : v;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /library — List all prompts in the account (up to 5 pages / 200 max).
// ─────────────────────────────────────────────────────────────────────────────

canaryLibraryRouter.get('/library', asyncHandler(async (_req, res) => {
  // dev:mock has no Bedrock to call — serve a real-looking library instead of
  // the 503 every prompt-management call would otherwise 503 with. See
  // mock/canary-library.ts and DEFECTS.md #8.
  if (config.mock.aurora) {
    res.json({
      prompts: MOCK_PROMPT_LIBRARY.map((p) => {
        const d = p.versions[0]!;
        return {
          id: p.id, arn: d.arn, name: p.name, description: p.description,
          version: d.version, updatedAt: d.updatedAt,
        };
      }),
    });
    return;
  }
  try {
    const prompts: {
      id: string;
      arn: string;
      name: string;
      description: string;
      version: string;
      updatedAt: string;
    }[] = [];

    let nextToken: string | undefined;
    let pages = 0;
    const MAX_PAGES = 5;

    do {
      const out = await bedrockAgent().send(
        new ListPromptsCommand(nextToken ? { nextToken } : {}),
      );
      for (const p of out.promptSummaries ?? []) {
        prompts.push({
          id: p.id ?? '',
          arn: p.arn ?? '',
          name: p.name ?? '',
          description: p.description ?? '',
          version: p.version ?? '',
          updatedAt: p.updatedAt?.toISOString() ?? '',
        });
      }
      nextToken = out.nextToken;
      pages += 1;
    } while (nextToken && pages < MAX_PAGES);

    res.json({ prompts });
  } catch (err) {
    console.warn('[canary-library] ListPrompts failed:', (err as Error).message);
    res.status(503).json({ error: 'Bedrock unavailable', detail: (err as Error).message });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /library/:promptId/versions — All versions of a prompt, newest first.
// DRAFT appears first with isDraft=true.
// ─────────────────────────────────────────────────────────────────────────────

canaryLibraryRouter.get('/library/:promptId/versions', asyncHandler(async (req, res) => {
  const promptId = paramStr(req.params['promptId'] ?? '');
  if (config.mock.aurora) {
    const p = findMockPrompt(promptId);
    if (!p) {
      res.status(404).json({ error: 'prompt not found', promptId });
      return;
    }
    res.json({
      versions: p.versions.map((v) => ({
        version: v.version, arn: v.arn, description: v.description,
        createdAt: v.createdAt, updatedAt: v.updatedAt,
        ...(v.version === 'DRAFT' ? { isDraft: true } : {}),
      })),
    });
    return;
  }
  try {
    const out = await bedrockAgent().send(
      new ListPromptsCommand({ promptIdentifier: promptId }),
    );

    type VersionEntry = {
      version: string;
      arn: string;
      description: string;
      createdAt: string;
      updatedAt: string;
      isDraft?: boolean;
    };

    const raw: VersionEntry[] = (out.promptSummaries ?? []).map((p) => ({
      version: p.version ?? '',
      arn: p.arn ?? '',
      description: p.description ?? '',
      createdAt: p.createdAt?.toISOString() ?? '',
      updatedAt: p.updatedAt?.toISOString() ?? '',
    }));

    // Separate DRAFT from numbered versions
    const draftIdx = raw.findIndex(
      (v) => v.version === 'DRAFT' || v.version === '',
    );
    const draft: VersionEntry | undefined =
      draftIdx !== -1 ? raw.splice(draftIdx, 1)[0] : undefined;

    // Sort numbered versions newest-first (numeric descending)
    raw.sort((a, b) => {
      const na = parseInt(a.version, 10);
      const nb = parseInt(b.version, 10);
      if (!isNaN(na) && !isNaN(nb)) return nb - na;
      return b.version.localeCompare(a.version);
    });

    const versions: (VersionEntry & { isDraft?: boolean })[] = [];
    if (draft) {
      versions.push({ ...draft, version: 'DRAFT', isDraft: true });
    }
    versions.push(...raw);

    res.json({ versions });
  } catch (err) {
    console.warn('[canary-library] ListPrompts(versions) failed:', (err as Error).message);
    res.status(503).json({ error: 'Bedrock unavailable', detail: (err as Error).message });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /library/:promptId/version/:version — Full template for a specific version.
// version = 'DRAFT' or a numeric string like '3'.
// ─────────────────────────────────────────────────────────────────────────────

canaryLibraryRouter.get('/library/:promptId/version/:version', asyncHandler(async (req, res) => {
  const promptId = paramStr(req.params['promptId'] ?? '');
  const version = paramStr(req.params['version'] ?? '');
  const promptVersion = version === 'DRAFT' ? undefined : version;
  if (config.mock.aurora) {
    const p = findMockPrompt(promptId);
    const v = p?.versions.find((x) => x.version === version);
    if (!p || !v) {
      res.status(404).json({ error: 'prompt version not found', promptId, version });
      return;
    }
    res.json({
      id: p.id, arn: v.arn, name: p.name, version: v.version, updatedAt: v.updatedAt,
      variant: {
        name: v.variant.name, modelId: v.variant.modelId, templateType: v.variant.templateType,
        templateText: v.variant.templateText, inputVariables: v.variant.inputVariables,
        inferenceConfig: v.variant.inferenceConfig,
      },
    });
    return;
  }
  try {
    const out = await bedrockAgent().send(
      new GetPromptCommand({ promptIdentifier: promptId, promptVersion }),
    );

    const variants = out.variants ?? [];
    const v = variants[0];
    const textCfg = v?.templateConfiguration && 'text' in v.templateConfiguration
      ? v.templateConfiguration.text
      : undefined;

    const inferenceText =
      v?.inferenceConfiguration && 'text' in v.inferenceConfiguration
        ? v.inferenceConfiguration.text
        : null;

    res.json({
      id: out.id ?? '',
      arn: out.arn ?? '',
      name: out.name ?? '',
      version: out.version ?? version,
      updatedAt: out.updatedAt?.toISOString() ?? '',
      variant: {
        name: v?.name ?? '',
        modelId: v?.modelId ?? '',
        templateType: v?.templateType ?? '',
        templateText: textCfg?.text ?? '',
        inputVariables: textCfg?.inputVariables?.map((iv) => iv.name ?? '') ?? [],
        inferenceConfig: inferenceText ?? null,
      },
    });
  } catch (err) {
    console.warn('[canary-library] GetPrompt failed:', (err as Error).message);
    res.status(503).json({ error: 'Bedrock unavailable', detail: (err as Error).message });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /library — Create a brand-new prompt in Bedrock Prompt Library. Cedar-gated.
// Body: { name, template_text, model_id?, inference_config?, description? }
// Returns: { ok, id, arn, name, version: 'DRAFT' }
// ─────────────────────────────────────────────────────────────────────────────

interface CreateBody {
  name?: unknown;
  template_text?: unknown;
  model_id?: unknown;
  inference_config?: unknown;
  description?: unknown;
}

canaryLibraryRouter.post(
  '/library',
  requireAction('ManageCanary'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as CreateBody;

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const templateText = typeof body.template_text === 'string' ? body.template_text.trim() : '';
    if (!name) throw new ValidationError('name is required');
    if (!templateText) throw new ValidationError('template_text is required');

    const modelId =
      typeof body.model_id === 'string' && body.model_id.trim()
        ? body.model_id.trim()
        : 'amazon.nova-pro-v1:0';

    const description =
      typeof body.description === 'string' && body.description.trim()
        ? body.description.trim()
        : undefined;

    const inferenceConfigOverride =
      body.inference_config != null && typeof body.inference_config === 'object'
        ? (body.inference_config as Record<string, unknown>)
        : undefined;

    // Auto-extract {{variable}} names from the template to populate inputVariables.
    const varMatches = [...templateText.matchAll(/{{([^}]+)}}/g)];
    const inputVariables = [...new Set(varMatches.map((m) => m[1]?.trim() ?? ''))
      .values()]
      .filter(Boolean)
      .map((n) => ({ name: n }));

    const inferenceConfiguration: PromptInferenceConfiguration = {
      text: {
        temperature:
          typeof inferenceConfigOverride?.['temperature'] === 'number'
            ? inferenceConfigOverride['temperature']
            : 0.7,
        maxTokens:
          typeof inferenceConfigOverride?.['maxTokens'] === 'number'
            ? inferenceConfigOverride['maxTokens']
            : 2048,
      },
    };

    // Offline the prompt is created in the fixture Prompt Studio already
    // lists, so the list, the rail and the version panel all show it — and
    // `POST /api/__mock/reset` un-creates it. The branch is in the handler
    // because the handler is what owns the CreatePrompt client; there is no
    // provider under this router to put it in.
    if (config.mock.aurora) {
      const created = mockCreatePrompt({
        name,
        ...(description ? { description } : {}),
        templateText,
        modelId,
        temperature: inferenceConfiguration.text?.temperature ?? 0.7,
        maxTokens: inferenceConfiguration.text?.maxTokens ?? 2048,
      });
      res.json({
        ok: true,
        id: created.id,
        arn: created.versions[0]?.arn ?? '',
        name: created.name,
        version: 'DRAFT',
      });
      return;
    }

    try {
      const out = await bedrockAgent().send(
        new CreatePromptCommand({
          name,
          ...(description ? { description } : {}),
          defaultVariant: 'default',
          variants: [
            {
              name: 'default',
              modelId,
              templateType: 'TEXT',
              templateConfiguration: {
                text: { text: templateText, inputVariables },
              },
              inferenceConfiguration,
            },
          ],
        }),
      );

      res.json({ ok: true, id: out.id ?? '', arn: out.arn ?? '', name: out.name ?? name, version: 'DRAFT' });
    } catch (err) {
      console.warn('[canary-library] CreatePrompt failed:', (err as Error).message);
      res.status(503).json({ error: 'Bedrock unavailable', detail: (err as Error).message });
    }
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /library/:promptId/draft — Save edits to the DRAFT variant. Cedar-gated.
// ─────────────────────────────────────────────────────────────────────────────

interface DraftBody {
  name?: unknown;
  template_text?: unknown;
  model_id?: unknown;
  inference_config?: unknown;
}

canaryLibraryRouter.put(
  '/library/:promptId/draft',
  requireAction('ManageCanary'),
  asyncHandler(async (req, res) => {
    const promptId = paramStr(req.params['promptId'] ?? '');
    const body = (req.body ?? {}) as DraftBody;

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const templateText = typeof body.template_text === 'string' ? body.template_text : '';
    if (!name) throw new ValidationError('name is required');
    if (!templateText) throw new ValidationError('template_text is required');

    const modelIdOverride =
      typeof body.model_id === 'string' && body.model_id.trim()
        ? body.model_id.trim()
        : undefined;

    const inferenceConfigOverride =
      body.inference_config != null && typeof body.inference_config === 'object'
        ? (body.inference_config as Record<string, unknown>)
        : undefined;

    if (config.mock.aurora) {
      const updated = mockUpdateDraft(promptId, {
        name,
        templateText,
        ...(modelIdOverride ? { modelId: modelIdOverride } : {}),
        ...(typeof inferenceConfigOverride?.['temperature'] === 'number'
          ? { temperature: inferenceConfigOverride['temperature'] } : {}),
        ...(typeof inferenceConfigOverride?.['maxTokens'] === 'number'
          ? { maxTokens: inferenceConfigOverride['maxTokens'] } : {}),
      });
      // A save that moved nothing must not answer `ok: true` — that is the
      // exact failure this slice exists to remove.
      if (!updated) {
        res.status(404).json({ error: `No prompt with id "${promptId}"` });
        return;
      }
      res.json({ ok: true, version: 'DRAFT' });
      return;
    }

    try {
      // Fetch current DRAFT to preserve variant name and other fields.
      const current = await bedrockAgent().send(
        new GetPromptCommand({ promptIdentifier: promptId }),
      );

      const variants = current.variants ?? [];
      const existing = variants[0];
      const variantName = existing?.name ?? 'default';
      // Prompts created outside this surface (e.g. the notebook-provisioned
      // agent system prompts) may carry no modelId — UpdatePrompt rejects an
      // empty string, so fall back to the same default the create path uses.
      const modelId = modelIdOverride || existing?.modelId || 'amazon.nova-pro-v1:0';

      // Build inference config: merge override onto existing text config.
      let inferenceConfiguration: PromptInferenceConfiguration | undefined;
      const existingText =
        existing?.inferenceConfiguration && 'text' in existing.inferenceConfiguration
          ? existing.inferenceConfiguration.text
          : undefined;

      if (inferenceConfigOverride) {
        inferenceConfiguration = {
          text: {
            temperature:
              typeof inferenceConfigOverride['temperature'] === 'number'
                ? inferenceConfigOverride['temperature']
                : existingText?.temperature,
            maxTokens:
              typeof inferenceConfigOverride['maxTokens'] === 'number'
                ? inferenceConfigOverride['maxTokens']
                : existingText?.maxTokens,
            topP:
              typeof inferenceConfigOverride['topP'] === 'number'
                ? inferenceConfigOverride['topP']
                : existingText?.topP,
          },
        };
      } else if (existingText) {
        inferenceConfiguration = { text: existingText };
      }

      // Preserve existing input variables from the current template or keep empty.
      const existingTextCfg =
        existing?.templateConfiguration && 'text' in existing.templateConfiguration
          ? existing.templateConfiguration.text
          : undefined;
      const inputVariables = existingTextCfg?.inputVariables ?? [];

      await bedrockAgent().send(
        new UpdatePromptCommand({
          promptIdentifier: promptId,
          name,
          variants: [
            {
              name: variantName,
              modelId,
              templateType: 'TEXT',
              templateConfiguration: {
                text: {
                  text: templateText,
                  inputVariables,
                },
              },
              ...(inferenceConfiguration ? { inferenceConfiguration } : {}),
            },
          ],
        }),
      );

      res.json({ ok: true, version: 'DRAFT' });
    } catch (err) {
      console.warn('[canary-library] UpdatePrompt failed:', (err as Error).message);
      res.status(503).json({ error: 'Bedrock unavailable', detail: (err as Error).message });
    }
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /library/:promptId/publish — Publish DRAFT as a new numbered version.
// Cedar-gated.
// ─────────────────────────────────────────────────────────────────────────────

interface PublishBody {
  description?: unknown;
}

canaryLibraryRouter.post(
  '/library/:promptId/publish',
  requireAction('ManageCanary'),
  asyncHandler(async (req, res) => {
    const promptId = paramStr(req.params['promptId'] ?? '');
    const body = (req.body ?? {}) as PublishBody;
    const description =
      typeof body.description === 'string' ? body.description : undefined;

    if (config.mock.aurora) {
      const published = mockPublishVersion(promptId, description);
      if (!published) {
        res.status(404).json({ error: `No prompt with id "${promptId}"` });
        return;
      }
      res.json({ ok: true, version: published.version.version, arn: published.version.arn });
      return;
    }

    try {
      const out = await bedrockAgent().send(
        new CreatePromptVersionCommand({
          promptIdentifier: promptId,
          ...(description ? { description } : {}),
        }),
      );

      res.json({ ok: true, version: out.version ?? '', arn: out.arn ?? '' });
    } catch (err) {
      console.warn('[canary-library] CreatePromptVersion failed:', (err as Error).message);
      res.status(503).json({ error: 'Bedrock unavailable', detail: (err as Error).message });
    }
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /library/:promptId/invoke — Run prompt via ConverseStream.
// Body: { version?, variables?, guardrailId?, guardrailVersion? }
// Streams newline-delimited JSON: { text } | { guardrail } | { done: true }
// NOTE: ConverseStream with a prompt ARN rejects messages/system/inferenceConfig.
// ─────────────────────────────────────────────────────────────────────────────

interface InvokeBody {
  version?: unknown;
  variables?: unknown;
  guardrailId?: unknown;
  guardrailVersion?: unknown;
}

/**
 * The stored contract for a version, or the empty one.
 *
 * Reads degrade to EMPTY_CONTRACT rather than failing the invoke: a prompt
 * that predates contracts (or an Aurora blip) must still run, it simply runs
 * without typed validation — the same posture prompt_source.py takes toward a
 * missing library entry.
 */
async function loadContract(promptId: string, version?: string): Promise<PromptContract> {
  try {
    const rows = await auroraExec(
      `SELECT contract::text AS contract FROM observability.prompt_version_meta
        WHERE prompt_id = :promptId AND version = :version LIMIT 1`,
      [
        { name: 'promptId', value: { stringValue: promptId } },
        { name: 'version', value: { stringValue: version ?? 'DRAFT' } },
      ],
    );
    const raw = rows[0]?.['contract'];
    if (typeof raw !== 'string') return EMPTY_CONTRACT;
    const parsed = JSON.parse(raw) as Partial<PromptContract>;
    if (!Array.isArray(parsed.variables)) return EMPTY_CONTRACT;
    return { ...EMPTY_CONTRACT, ...parsed } as PromptContract;
  } catch {
    return EMPTY_CONTRACT;
  }
}

canaryLibraryRouter.post(
  '/library/:promptId/invoke',
  requireAction('ManageCanary'),
  asyncHandler(async (req, res) => {
    const promptId = paramStr(req.params['promptId'] ?? '');
    const body = (req.body ?? {}) as InvokeBody;
    const version = typeof body.version === 'string' ? body.version : undefined;
    const guardrailId = typeof body.guardrailId === 'string' ? body.guardrailId : undefined;
    const guardrailVersion = typeof body.guardrailVersion === 'string' ? body.guardrailVersion : '1';

    const rawVariables: Record<string, string> =
      body.variables != null && typeof body.variables === 'object' && !Array.isArray(body.variables)
        ? Object.fromEntries(
            Object.entries(body.variables as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'string')
              .map(([k, v]) => [k, v as string]),
          )
        : {};

    // Apply the contract BEFORE the values leave us.
    //
    // Bedrock expands `{{…}}` itself when a prompt ARN is the model, so the
    // template is not ours to wrap by the time it renders — the fence has to
    // be on the VALUE. A prompt with no stored contract renders exactly as it
    // used to, so this is additive: the typed ones get the trust boundary,
    // the untyped ones are unchanged.
    const contract = await loadContract(promptId, version);
    const prepared = prepareValues(contract, rawVariables);
    if (!prepared.ok) {
      res.status(400).json({
        error: 'the supplied values do not satisfy this prompt\'s contract',
        issues: prepared.issues,
      });
      return;
    }
    const variables = prepared.values;
    if (prepared.fenced.length > 0) {
      // Say it out loud: a reader of the logs should be able to see that the
      // boundary was applied, and to which variables.
      console.log(`[prompt] fenced ${prepared.fenced.join(', ')} for ${promptId}@${version ?? 'DRAFT'}`);
    }

    if (config.mock.aurora) {
      // No model runs. What is streamed is the prompt as it would have been
      // sent, rendered with these variables and labelled as such — see
      // mock/prompt-studio.ts for why that and not a synthesised answer.
      const rendered = offlineInvokePrompt(promptId, version, variables);
      if (rendered === null) {
        res.status(503).json({
          error: 'Bedrock unavailable',
          detail: `No prompt "${promptId}" at version "${version ?? 'DRAFT'}" in the offline library`,
        });
        return;
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      for (const chunk of rendered.match(/\S+\s*/g) ?? []) {
        res.write(JSON.stringify({ text: chunk }) + '\n');
      }
      res.write(JSON.stringify({ done: true }) + '\n');
      res.end();
      return;
    }

    // Fetch the prompt ARN (the ARN is the modelId for ConverseStream).
    let modelId: string;
    try {
      const detail = await bedrockAgent().send(
        new GetPromptCommand({
          promptIdentifier: promptId,
          ...(version && version !== 'DRAFT' ? { promptVersion: version } : {}),
        }),
      );
      modelId = detail.arn ?? promptId;
    } catch (err) {
      console.warn('[canary-library] GetPrompt (for invoke) failed:', (err as Error).message);
      res.status(503).json({ error: 'Bedrock unavailable', detail: (err as Error).message });
      return;
    }

    const promptVariables = Object.fromEntries(
      Object.entries(variables).map(([k, v]) => [k, { text: v }]),
    );

    try {
      const cmd = new ConverseStreamCommand({
        modelId,
        ...(Object.keys(promptVariables).length > 0 ? { promptVariables } : {}),
        ...(guardrailId
          ? { guardrailConfig: { guardrailIdentifier: guardrailId, guardrailVersion, trace: 'enabled' } }
          : {}),
      });

      const out = await bedrockRuntime().send(cmd);

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Cache-Control', 'no-cache');

      if (out.stream) {
        for await (const event of out.stream) {
          if (event.metadata?.usage) void recordBffCall({ feature: 'canary-library-test', model: modelId, usage: event.metadata.usage });
          if (event.contentBlockDelta?.delta?.text) {
            res.write(JSON.stringify({ text: event.contentBlockDelta.delta.text }) + '\n');
          }
          if (event.metadata?.trace?.guardrail) {
            res.write(JSON.stringify({ guardrail: event.metadata.trace.guardrail }) + '\n');
          }
        }
      }

      res.write(JSON.stringify({ done: true }) + '\n');
      res.end();
    } catch (err) {
      console.warn('[canary-library] ConverseStream failed:', (err as Error).message);
      if (!res.headersSent) {
        res.status(503).json({ error: 'Bedrock unavailable', detail: (err as Error).message });
      } else {
        res.write(JSON.stringify({ error: (err as Error).message }) + '\n');
        res.end();
      }
    }
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /library/:promptId/optimize — AI rewrite via OptimizePrompt.
// Body: { templateText: string; targetMetric?: string }
// Returns: { optimizedText: string }
// ─────────────────────────────────────────────────────────────────────────────

interface OptimizeBody {
  templateText?: unknown;
  targetMetric?: unknown;
}

canaryLibraryRouter.post(
  '/library/:promptId/optimize',
  requireAction('ManageCanary'),
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as OptimizeBody;
    const templateText = typeof body.templateText === 'string' ? body.templateText.trim() : '';
    if (!templateText) throw new ValidationError('templateText is required');

    // Deliberately a refusal, not a fixture. A rewrite is the whole product of
    // this endpoint; handing back the input and calling it optimized would be
    // the rubber stamp middleware/src/mock/core/contract.ts rules out.
    if (config.mock.aurora) {
      res.status(503).json(offlineOptimize());
      return;
    }

    try {
      const out = await bedrockAgentRuntime().send(
        new OptimizePromptCommand({
          input: { textPrompt: { text: templateText } },
          targetModelId: 'amazon.nova-pro-v1:0',
        }),
      );

      let optimizedText = '';
      if (out.optimizedPrompt) {
        for await (const event of out.optimizedPrompt) {
          if (event.optimizedPromptEvent?.optimizedPrompt?.textPrompt?.text) {
            optimizedText += event.optimizedPromptEvent.optimizedPrompt.textPrompt.text;
          }
        }
      }

      res.json({ ok: true, optimizedText, targetMetric: body.targetMetric ?? 'clarity' });
    } catch (err) {
      console.warn('[canary-library] OptimizePrompt failed:', (err as Error).message);
      res.status(503).json({ error: 'Bedrock unavailable', detail: (err as Error).message });
    }
  }),
);
