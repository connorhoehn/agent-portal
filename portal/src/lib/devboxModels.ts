// The models the devbox container will accept for a Claude Code task.
//
// These are Bedrock inference-profile IDs, not first-party model names: the
// devbox runs Claude Code with CLAUDE_CODE_USE_BEDROCK=1, so `--model` is passed
// straight to Bedrock, which knows `us.anthropic.claude-*` inference profiles
// and not `claude-opus-5`. The IDs must match the runtime's DEVBOX_ALLOWED_MODELS
// exactly (see infra/lib/devbox-stack.ts) — the container silently falls back to
// its default (Haiku) for anything not on that allowlist, so a mismatch here is
// invisible: the user picks Opus and quietly gets Haiku. One shared list so the
// two places that start a task cannot drift apart again.

export interface DevboxModel {
  /** Bedrock inference-profile id, sent verbatim to the container. */
  id: string;
  label: string;
  hint: string;
}

export const DEVBOX_MODELS: DevboxModel[] = [
  { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Haiku', hint: 'default · cheapest · fine for most tasks' },
  { id: 'us.anthropic.claude-sonnet-5', label: 'Sonnet', hint: 'harder multi-step work' },
  { id: 'us.anthropic.claude-opus-4-8', label: 'Opus', hint: 'the expensive one — reach for it deliberately' },
];

/** The default task model — the cheapest, matching the runtime's ANTHROPIC_MODEL. */
export const DEFAULT_DEVBOX_MODEL = DEVBOX_MODELS[0]!.id;
