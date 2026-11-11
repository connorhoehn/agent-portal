-- The prompt contract — what a library entry declares about its inputs.
--
-- Extends observability.prompt_version_meta rather than adding a table: that
-- row is already keyed (prompt_id, version) and already carries the portal's
-- view of a Bedrock library version (description, author, lifecycle). The
-- contract is more of the same fact, so it lives with it.
--
-- Why this exists: Bedrock Prompt Management stores the template text and
-- nothing about its variables. Prompt Studio was therefore guessing a
-- variable's shape from its NAME, and the agent runtime never substituted
-- values at all. Typing the variables here is what lets a parameterised prompt
-- actually ship, and — because each variable declares a SOURCE — it is also
-- where the trust boundary is recorded. See middleware/src/lib/prompt-contract.ts.

ALTER TABLE observability.prompt_version_meta
  -- Who invokes this asset: an agent's identity ('system'), a person
  -- ('prompt') or a pipeline with no human in it ('evaluator'). Runbooks are
  -- the only catalogue of procedures, so there is no skill or insight kind.
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'prompt'
    CHECK (kind IN ('system','prompt','evaluator')),

  -- Blast radius, which is what decides the release gates. 'sandbox' answers
  -- to nobody; 'internal' is callable by the fleet; 'endpoint' is reachable
  -- from outside and may be fed untrusted text.
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'sandbox'
    CHECK (tier IN ('sandbox','internal','endpoint')),

  -- { variables: [{name, type, required, source, default?, description?,
  --   options?}], guardrailId? } — see PromptContract. `source` is the
  -- security-bearing field: 'literal'/'caller' render inline, while
  -- 'retrieved'/'untrusted' are fenced into labelled blocks so they cannot
  -- share a channel with the instructions.
  ADD COLUMN IF NOT EXISTS contract jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The person accountable for it. An internal or endpoint asset cannot
  -- deploy without one.
  ADD COLUMN IF NOT EXISTS owner_email text,

  -- Last recorded pass rate of this version's own eval set, 0..1. NULL means
  -- never evaluated, which is a deploy refusal above the sandbox tier — it is
  -- deliberately distinct from 0 (evaluated, and failing).
  ADD COLUMN IF NOT EXISTS eval_pass_rate double precision;

-- Discovery: the library is browsed by kind and tier far more than by id.
CREATE INDEX IF NOT EXISTS prompt_version_meta_kind_tier_idx
  ON observability.prompt_version_meta (kind, tier);

COMMENT ON COLUMN observability.prompt_version_meta.contract IS
  'Typed variable contract. Each variable declares a source that decides '
  'whether its value renders inline with the instructions or is fenced.';
