// Pure derivations for Prompt Studio. No React in this file — every function
// here is a plain transform over a template string or a config object, which is
// most of what used to be buried inside the page's render bodies.

import type { GuardrailIntervention, InferenceConfig, VarType } from './types';

// ── Variables ─────────────────────────────────────────────────────────────────

const VAR_PATTERN = /{{[^}]+}}/g;

/** `{{person_name}}` placeholders, braces included, de-duplicated, in order. */
export function extractVariables(templateText: string): string[] {
  return [...new Set(templateText.match(VAR_PATTERN) ?? [])];
}

/** The same list with the braces stripped — the keys the invoke API expects. */
export function extractVariableNames(templateText: string): string[] {
  return extractVariables(templateText).map(v => v.slice(2, -2).trim());
}

/**
 * Guess how to collect a variable from its name.
 *
 * Heuristic on purpose: the Prompt Library stores no type information, so a
 * variable called `reviewer` gets a people picker and one called `summary` gets
 * a textarea. Wrong guesses still accept free text, so the cost of a miss is a
 * slightly wrong-shaped box, never a value you cannot enter.
 */
export function detectVarType(name: string): VarType {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  if (/person|name|employee|author|reviewer|user|who/.test(n)) return 'person';
  if (/skill|topic|expertise|technology|domain|area|subject/.test(n)) return 'skill';
  if (/response|content|message|output|body|description|summary|feedback|answer/.test(n)) return 'textarea';
  return 'text';
}

// ── Versions ──────────────────────────────────────────────────────────────────

/** `DRAFT` stays DRAFT; a numbered version reads `v3`. */
export function versionLabel(version: string): string {
  return version === 'DRAFT' ? 'DRAFT' : `v${version}`;
}

// ── Inference config ──────────────────────────────────────────────────────────

export const MAX_TOKEN_OPTIONS = [
  { value: '256',  label: '256 — short' },
  { value: '512',  label: '512 — brief' },
  { value: '1024', label: '1 K — standard' },
  { value: '2048', label: '2 K — moderate' },
  { value: '4096', label: '4 K — detailed' },
  { value: '8192', label: '8 K — long form' },
];

export const DEFAULT_MAX_TOKENS = '2048';
export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_MODEL_ID = 'amazon.nova-pro-v1:0';

/** Only send the keys the user actually set — an empty string means "inherit",
 *  not "zero". Returns undefined when nothing was set at all. */
export function buildInferenceConfig(temperature: string, maxTokens: string): InferenceConfig | undefined {
  const config: InferenceConfig = {};
  if (temperature !== '') config.temperature = parseFloat(temperature);
  if (maxTokens !== '') config.maxTokens = parseInt(maxTokens, 10);
  return Object.keys(config).length > 0 ? config : undefined;
}

/** Snap a stored maxTokens onto one of the presets; anything unrecognised
 *  falls back to the default rather than adding a phantom option. */
export function normalizeMaxTokens(stored: number | undefined): string {
  if (stored === undefined) return DEFAULT_MAX_TOKENS;
  const asString = String(stored);
  return MAX_TOKEN_OPTIONS.some(o => o.value === asString) ? asString : DEFAULT_MAX_TOKENS;
}

// ── Guardrails ────────────────────────────────────────────────────────────────

/** The shape a Bedrock guardrail trace arrives in, flattened to the items we
 *  can actually show. */
export function flattenGuardrailTrace(trace: unknown): GuardrailIntervention[] {
  const t = trace as {
    inputAssessment?: Record<string, {
      topicPolicy?: { topics?: GuardrailIntervention[] };
      sensitiveInformationPolicy?: { piiEntities?: GuardrailIntervention[] };
    }>;
  };
  const items: GuardrailIntervention[] = [];
  for (const assessment of Object.values(t.inputAssessment ?? {})) {
    for (const topic of assessment.topicPolicy?.topics ?? []) items.push(topic);
    for (const pii of assessment.sensitiveInformationPolicy?.piiEntities ?? []) items.push(pii);
  }
  return items;
}

/** Only BLOCKED/ANONYMIZED entries are worth interrupting the reader for. */
export function blockingInterventions(items: GuardrailIntervention[]): GuardrailIntervention[] {
  return items.filter(i => i.action === 'BLOCKED' || i.action === 'ANONYMIZED');
}

// ── Naming ────────────────────────────────────────────────────────────────────

/** Every prompt this portal creates is namespaced, so the prefix is not
 *  editable — deleting into it snaps back rather than letting someone create an
 *  un-findable prompt. */
export const NAME_PREFIX = 'orgiq-';

export function enforceNamePrefix(value: string): string {
  return value.startsWith(NAME_PREFIX) ? value : NAME_PREFIX;
}

export function isValidNewPrompt(name: string, templateText: string): boolean {
  return name.trim().length > NAME_PREFIX.length && templateText.trim().length > 0;
}
