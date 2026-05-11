// Guardrails provider — reads (and patches) the OrgIQ Bedrock Guardrail via
// @aws-sdk/client-bedrock. The DRAFT version is what GetGuardrail returns when
// called without a version; published versions (e.g. "1") are immutable, so any
// future UpdateGuardrail call targets the draft.
//
// Exports `realGuardrails` (AWS-backed) and `mockGuardrails` (in-memory copy of
// the shared mock object, mutating in place to mirror the old route behavior).

import {
  BedrockClient,
  GetGuardrailCommand,
  UpdateGuardrailCommand,
  type GetGuardrailCommandOutput,
  type UpdateGuardrailCommandInput,
} from '@aws-sdk/client-bedrock';

import { config } from '../config.js';
import { mockGuardrail } from '../mock/capabilities.js';
import type {
  ContentPolicy,
  DeniedTopic,
  GuardrailSnapshot,
  GuardrailsProvider,
  PiiFilter,
} from './types.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const bedrock = new BedrockClient({ region: config.region });

const EMPTY_CONTENT_POLICY: ContentPolicy = {
  hateEnabled: false,
  violenceEnabled: false,
  sexualEnabled: false,
  insultsEnabled: false,
  misconductEnabled: false,
  promptAttackEnabled: false,
};

const CONTENT_TYPE_TO_FIELD: Record<string, keyof ContentPolicy> = {
  HATE: 'hateEnabled',
  VIOLENCE: 'violenceEnabled',
  SEXUAL: 'sexualEnabled',
  INSULTS: 'insultsEnabled',
  MISCONDUCT: 'misconductEnabled',
  PROMPT_ATTACK: 'promptAttackEnabled',
};

function mapPiiAction(action: string | undefined): PiiFilter['action'] {
  if (action === 'ANONYMIZE' || action === 'BLOCK' || action === 'NONE') return action;
  return 'NONE';
}

function mapGetGuardrail(res: GetGuardrailCommandOutput): GuardrailSnapshot {
  // PII filters — SDK field is `sensitiveInformationPolicy.piiEntities[]`.
  // AWS doesn't carry an explicit "enabled" bit per entity in the read path
  // (inputEnabled/outputEnabled exist but default true); presence == enabled.
  const piiFilters: PiiFilter[] = (res.sensitiveInformationPolicy?.piiEntities ?? []).map((e) => ({
    type: String(e.type ?? ''),
    action: mapPiiAction(e.action as string | undefined),
    enabled: e.inputEnabled !== false && e.outputEnabled !== false,
  }));

  // Denied topics — SDK field is `topicPolicy.topics[]`.
  const deniedTopics: DeniedTopic[] = (res.topicPolicy?.topics ?? []).map((t) => ({
    name: t.name ?? '',
    definition: t.definition ?? '',
    enabled: t.inputEnabled !== false && t.outputEnabled !== false,
  }));

  // Content policy — SDK field is `contentPolicy.filters[]`. Enabled if either
  // strength is set and not 'NONE'.
  const contentPolicy: ContentPolicy = { ...EMPTY_CONTENT_POLICY };
  for (const f of res.contentPolicy?.filters ?? []) {
    const field = CONTENT_TYPE_TO_FIELD[String(f.type ?? '')];
    if (!field) continue;
    const inStrength = String(f.inputStrength ?? 'NONE');
    const outStrength = String(f.outputStrength ?? 'NONE');
    contentPolicy[field] = inStrength !== 'NONE' || outStrength !== 'NONE';
  }

  // Contextual grounding thresholds.
  let groundingThreshold = 0;
  let relevanceThreshold = 0;
  for (const f of res.contextualGroundingPolicy?.filters ?? []) {
    if (f.type === 'GROUNDING') groundingThreshold = f.threshold ?? 0;
    else if (f.type === 'RELEVANCE') relevanceThreshold = f.threshold ?? 0;
  }

  return {
    id: res.guardrailId ?? config.guardrail.id,
    name: res.name ?? 'orgiq-guardrail',
    status: String(res.status ?? 'UNKNOWN'),
    version: res.version ?? config.guardrail.version,
    updatedAt: (res.updatedAt instanceof Date ? res.updatedAt : new Date()).toISOString(),
    piiFilters,
    contentPolicy,
    deniedTopics,
    groundingThreshold,
    relevanceThreshold,
  };
}

// ── real implementation ───────────────────────────────────────────────────────

async function fetchRaw(): Promise<GetGuardrailCommandOutput> {
  return bedrock.send(
    // No guardrailVersion → returns the DRAFT.
    new GetGuardrailCommand({ guardrailIdentifier: config.guardrail.id }),
  );
}

async function fetchSnapshot(): Promise<GuardrailSnapshot> {
  return mapGetGuardrail(await fetchRaw());
}

// Build a full UpdateGuardrail request from the current GetGuardrail response.
// AWS UpdateGuardrail is a PUT, so we must round-trip every policy section even
// if we're only changing one field. The `mutate` callback applies the patch.
function buildUpdateRequest(
  raw: GetGuardrailCommandOutput,
  mutate?: (req: UpdateGuardrailCommandInput) => void,
): UpdateGuardrailCommandInput {
  const req: UpdateGuardrailCommandInput = {
    guardrailIdentifier: config.guardrail.id,
    name: raw.name ?? 'orgiq-guardrail',
    description: raw.description,
    blockedInputMessaging: raw.blockedInputMessaging ?? 'This input is blocked by guardrail policy.',
    blockedOutputsMessaging: raw.blockedOutputsMessaging ?? 'This response is blocked by guardrail policy.',
    topicPolicyConfig: raw.topicPolicy?.topics?.length
      ? {
          topicsConfig: raw.topicPolicy.topics.map((t) => ({
            name: t.name!,
            definition: t.definition!,
            type: 'DENY',
            examples: t.examples,
            inputEnabled: t.inputEnabled,
            outputEnabled: t.outputEnabled,
            inputAction: t.inputAction,
            outputAction: t.outputAction,
          })),
        }
      : undefined,
    contentPolicyConfig: raw.contentPolicy?.filters?.length
      ? {
          filtersConfig: raw.contentPolicy.filters.map((f) => ({
            type: f.type!,
            inputStrength: f.inputStrength!,
            outputStrength: f.outputStrength!,
            inputEnabled: f.inputEnabled,
            outputEnabled: f.outputEnabled,
            inputAction: f.inputAction,
            outputAction: f.outputAction,
          })),
        }
      : undefined,
    sensitiveInformationPolicyConfig: (raw.sensitiveInformationPolicy?.piiEntities?.length ||
      raw.sensitiveInformationPolicy?.regexes?.length)
      ? {
          piiEntitiesConfig: raw.sensitiveInformationPolicy?.piiEntities?.map((p) => ({
            type: p.type!,
            action: p.action!,
            inputEnabled: p.inputEnabled,
            outputEnabled: p.outputEnabled,
            inputAction: p.inputAction,
            outputAction: p.outputAction,
          })),
          regexesConfig: raw.sensitiveInformationPolicy?.regexes?.map((r) => ({
            name: r.name!,
            description: r.description,
            pattern: r.pattern!,
            action: r.action!,
            inputEnabled: r.inputEnabled,
            outputEnabled: r.outputEnabled,
            inputAction: r.inputAction,
            outputAction: r.outputAction,
          })),
        }
      : undefined,
    wordPolicyConfig: (raw.wordPolicy?.words?.length || raw.wordPolicy?.managedWordLists?.length)
      ? {
          wordsConfig: raw.wordPolicy?.words?.map((w) => ({
            text: w.text!,
            inputEnabled: w.inputEnabled,
            outputEnabled: w.outputEnabled,
            inputAction: w.inputAction,
            outputAction: w.outputAction,
          })),
          managedWordListsConfig: raw.wordPolicy?.managedWordLists?.map((m) => ({
            type: m.type!,
            inputEnabled: m.inputEnabled,
            outputEnabled: m.outputEnabled,
            inputAction: m.inputAction,
            outputAction: m.outputAction,
          })),
        }
      : undefined,
    contextualGroundingPolicyConfig: raw.contextualGroundingPolicy?.filters?.length
      ? {
          filtersConfig: raw.contextualGroundingPolicy.filters.map((f) => ({
            type: f.type!,
            threshold: f.threshold!,
            action: f.action,
            enabled: f.enabled,
          })),
        }
      : undefined,
  };
  mutate?.(req);
  return req;
}

export const realGuardrails: GuardrailsProvider = {
  async getGuardrail() {
    return fetchSnapshot();
  },

  // Mutations issue a real UpdateGuardrail (full PUT). Each one fetches the
  // current spec, applies a single-field patch, and re-puts the whole thing.
  // AgentCore Bedrock guardrails mutate the DRAFT in place — published numbered
  // versions stay immutable, so callers using `version: "1"` won't see the
  // change until they re-publish. For the demo we just edit the draft and
  // refetch.

  async togglePiiFilter(type, patch) {
    const raw = await fetchRaw();
    const target = raw.sensitiveInformationPolicy?.piiEntities?.find((p) => p.type === type);
    if (!target) return null;

    const req = buildUpdateRequest(raw, (r) => {
      const entries = r.sensitiveInformationPolicyConfig?.piiEntitiesConfig;
      if (!entries) return;
      const idx = entries.findIndex((e) => e.type === type);
      if (idx < 0) return;
      if (patch.enabled !== undefined) {
        entries[idx]!.inputEnabled = patch.enabled;
        entries[idx]!.outputEnabled = patch.enabled;
      }
      if (patch.action !== undefined) {
        entries[idx]!.action = patch.action as any;
      }
    });

    await bedrock.send(new UpdateGuardrailCommand(req));
    const refreshed = await fetchSnapshot();
    return refreshed.piiFilters.find((p) => p.type === type) ?? null;
  },

  async updateDeniedTopic(name, patch) {
    const raw = await fetchRaw();
    const target = raw.topicPolicy?.topics?.find((t) => t.name === name);
    if (!target) return null;

    const req = buildUpdateRequest(raw, (r) => {
      const entries = r.topicPolicyConfig?.topicsConfig;
      if (!entries) return;
      const idx = entries.findIndex((t) => t.name === name);
      if (idx < 0) return;
      if (patch.enabled !== undefined) {
        entries[idx]!.inputEnabled = patch.enabled;
        entries[idx]!.outputEnabled = patch.enabled;
      }
      if (patch.definition !== undefined) {
        entries[idx]!.definition = patch.definition;
      }
    });

    await bedrock.send(new UpdateGuardrailCommand(req));
    const refreshed = await fetchSnapshot();
    return refreshed.deniedTopics.find((t) => t.name === name) ?? null;
  },

  async addDeniedTopic(topic) {
    const raw = await fetchRaw();
    const req = buildUpdateRequest(raw, (r) => {
      const newTopic = {
        name: topic.name,
        definition: topic.definition,
        type: 'DENY' as const,
        inputEnabled: true,
        outputEnabled: true,
      };
      if (!r.topicPolicyConfig) {
        r.topicPolicyConfig = { topicsConfig: [newTopic] };
      } else {
        r.topicPolicyConfig.topicsConfig = [...(r.topicPolicyConfig.topicsConfig ?? []), newTopic];
      }
    });
    await bedrock.send(new UpdateGuardrailCommand(req));
    const refreshed = await fetchSnapshot();
    return refreshed.deniedTopics.find((t) => t.name === topic.name)
      ?? { name: topic.name, definition: topic.definition, enabled: true };
  },

  async removeDeniedTopic(name) {
    const raw = await fetchRaw();
    const exists = raw.topicPolicy?.topics?.some((t) => t.name === name) ?? false;
    if (!exists) return false;

    const req = buildUpdateRequest(raw, (r) => {
      const remaining = (r.topicPolicyConfig?.topicsConfig ?? []).filter((t) => t.name !== name);
      // AWS rejects an empty `topicsConfig: []` — must omit the section instead.
      r.topicPolicyConfig = remaining.length > 0 ? { topicsConfig: remaining } : undefined;
    });
    await bedrock.send(new UpdateGuardrailCommand(req));
    return true;
  },
};

// ── mock implementation ───────────────────────────────────────────────────────
//
// Wraps the shared `mockGuardrail` object and mutates it in place so a session
// against the mock provider sees its edits stick (matches the legacy route's
// behavior).

// Narrow the loose `mockGuardrail` literal to the shape our routes expect.
const m = mockGuardrail as GuardrailSnapshot;

export const mockGuardrails: GuardrailsProvider = {
  async getGuardrail() {
    return m;
  },

  async togglePiiFilter(type, patch) {
    const f = m.piiFilters.find((p) => p.type === type);
    if (!f) return null;
    if (patch.enabled !== undefined) f.enabled = patch.enabled;
    if (patch.action !== undefined) f.action = mapPiiAction(patch.action);
    m.updatedAt = new Date().toISOString();
    return f;
  },

  async updateDeniedTopic(name, patch) {
    const t = m.deniedTopics.find((d) => d.name === name);
    if (!t) return null;
    if (patch.enabled !== undefined) t.enabled = patch.enabled;
    if (patch.definition !== undefined) t.definition = patch.definition;
    m.updatedAt = new Date().toISOString();
    return t;
  },

  async addDeniedTopic(topic) {
    const next: DeniedTopic = { name: topic.name, definition: topic.definition, enabled: true };
    m.deniedTopics.push(next);
    m.updatedAt = new Date().toISOString();
    return next;
  },

  async removeDeniedTopic(name) {
    const i = m.deniedTopics.findIndex((t) => t.name === name);
    if (i < 0) return false;
    m.deniedTopics.splice(i, 1);
    m.updatedAt = new Date().toISOString();
    return true;
  },
};
