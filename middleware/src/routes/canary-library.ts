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
  CreatePromptVersionCommand,
  type PromptInferenceConfiguration,
} from '@aws-sdk/client-bedrock-agent';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { requireAction } from '../lib/authz.js';
import { config } from '../config.js';

export const canaryLibraryRouter = Router();

let _bedrockAgent: BedrockAgentClient | null = null;
function bedrockAgent(): BedrockAgentClient {
  if (!_bedrockAgent) _bedrockAgent = new BedrockAgentClient({ region: config.region });
  return _bedrockAgent;
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

    try {
      // Fetch current DRAFT to preserve variant name and other fields.
      const current = await bedrockAgent().send(
        new GetPromptCommand({ promptIdentifier: promptId }),
      );

      const variants = current.variants ?? [];
      const existing = variants[0];
      const variantName = existing?.name ?? 'default';
      const modelId = modelIdOverride ?? existing?.modelId ?? '';

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
