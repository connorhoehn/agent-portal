import json
import logging
import os
import sys
import time
from contextvars import ContextVar
from typing import AsyncIterator
from pathlib import Path

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models.bedrock import BedrockModel

# Shared instrumentation — pull TraceContext + decorator from agents/_shared,
# the same way every other agent does.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from _shared.model_registry import RegistryAgent, invoke_with_fallback, resolve_model  # noqa: E402
from _shared.agui_stream import stream_agui, wants_stream  # noqa: E402
from _shared.tenant_guard import reject_wrong_tenant  # noqa: E402
from _shared.instrumentation import (  # noqa: E402
    attach_usage,
    TraceContext,
    install_bedrock_usage_capture,
    instrumented_tool,
    post_trace,
    reset_active_ctx,
    set_active_ctx,
)

# Deterministic scoring logic — dependency-free, unit tested on its own in
# tests/test_scoring_logic.py without needing strands/bedrock_agentcore.
from scoring_logic import classify_evidence_impl, score_dimension_impl

# Patch boto3's bedrock-runtime client BEFORE Strands constructs its own —
# otherwise Converse usage is invisible to our TraceContext.
install_bedrock_usage_capture()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# Per-invocation trace buffer.
_current_ctx: ContextVar[TraceContext | None] = ContextVar(
    "assessment_scorer_trace_ctx", default=None
)

app = BedrockAgentCoreApp()

REGION = os.environ.get("AWS_REGION", "us-east-1")
# DE-3: the model comes from the central registry (SSM /orgiq/models/registry,
# written from infra/config/model-registry.json), then the MODEL_ID env var,
# then the literal below. MODEL_ID is the import-time view; every turn
# re-resolves (60 s cache) and may fall back on capacity errors, so traces
# record _agent.model_id, the id actually served.
MODEL_ROLE = "assessment-scorer"
_MODEL_DEFAULTS = {"default_model_id": "amazon.nova-pro-v1:0", "default_temperature": None, "default_max_tokens": None}
MODEL_ID = resolve_model(MODEL_ROLE, **_MODEL_DEFAULTS).model_id

# This agent serves exactly one tenant. Unlike the supervisor (tenant-aware,
# serves both tenants), this agent enforces its own tenant floor in code — it
# reads/produces assessment scoring data and must never run for an orgiq
# session that reached it directly (bypassing the middleware gate, or a
# future caller that forgets to add one).
EXPECTED_TENANT = "assessment"


@tool
@instrumented_tool(_current_ctx.get)
def classify_evidence(text: str) -> str:
    """Classify one piece of evidence text before it is scored.

    Deterministic first pass over the raw text: infers evidence_type (one of
    stakeholder_interview, assessment_qa, document, survey, meeting, other),
    a weight (high/medium/low, from evidence_type and length), and which
    rubric dimensions (plain "1".."17") this text gives direct, substantive
    signal about. The agent's own reasoning may still refine
    relevant_dimension_ids if the heuristics obviously miss something the
    text actually discusses — say so in the classification summary if it does.

    Args:
        text: The raw evidence text (a transcript excerpt, survey answer, or
            document body) to classify.

    Returns:
        JSON object: {evidence_type, weight, weight_reason, informs,
        relevant_dimension_ids, action_items, summary, length_chars}.
    """
    return json.dumps(classify_evidence_impl(text), ensure_ascii=False)


@tool
@instrumented_tool(_current_ctx.get)
def score_dimension(
    dimension_id: str,
    evidence_ids: list,
    evidence_items: list,
    proposed_level: int,
    confidence: str,
    rationale: str,
    relevant_dimension_ids: list | None = None,
    evidence_excerpts: list | None = None,
    follow_up_questions: list | None = None,
    self_claimed_level: int | None = None,
) -> str:
    """Validate and enforce one proposed dimension score before it counts.

    This is the deterministic gate for the scoring stance carried over from
    the source product: it refuses to score a dimension outside
    relevant_dimension_ids, normalises confidence to exactly
    low/moderate/high, caps a self-rating-only (or otherwise
    Observed-evidence-free) level-4/5 claim at 3 with cap_applied=true,
    drops any evidence_excerpts entry that is not a verbatim substring of one
    of the cited evidence_items' text (lowering confidence one band when it
    does), and scrubs team-side participant names out of the rationale.

    It also REFUSES outright — returning {refused: true, refusal_reason} and
    no level at all — when the proposal is not something that could honestly
    be applied: a dimension_id outside "1".."17", a proposed_level or
    self_claimed_level that is not a whole number 0..5, or a blank rationale.
    Do not retry a refusal with a made-up value; fix the input or leave the
    dimension unscored and say why. Any evidence_id you cite that is not in
    evidence_items comes back in unverified_evidence_ids and costs one
    confidence band, and a dimension where none of your cited ids resolve is
    reported at "low" confidence no matter what you proposed.

    Args:
        dimension_id: Plain rubric dimension id, "1".."17".
        evidence_ids: Ids (from evidence_items) actually cited for this level.
        evidence_items: The full evidence array from the run
            ({id, source_type, text}), so excerpts and evidence class can be
            checked against real text rather than trusted on the model's say-so.
        proposed_level: The level (0-5) the agent's reasoning proposes.
        confidence: "low" | "moderate" | "high" (or the legacy "medium").
        rationale: 2-4 sentences citing evidence, in the team's own reading
            language — never "grade"/"capped"/"marked down".
        relevant_dimension_ids: The ids this run is allowed to score, from
            classification. Omit (None) only when the caller intentionally
            allows scoring any dimension.
        evidence_excerpts: Verbatim quotes supporting the level. May be
            dropped if not found verbatim in the cited evidence text.
        follow_up_questions: Open questions that would refine the level.
        self_claimed_level: The level implied by the team's own self-rating,
            or None if no self-rating claim appears in the evidence.

    Returns:
        JSON object: {dimension_id, refused, [refusal_reason] |
        current_level, confidence, evidence_class, cap_applied, rationale,
        evidence_excerpts, follow_up_questions, self_claimed_level,
        unverified_evidence_ids}.
    """
    return json.dumps(
        score_dimension_impl(
            dimension_id=dimension_id,
            evidence_ids=evidence_ids,
            evidence_items=evidence_items,
            proposed_level=proposed_level,
            confidence=confidence,
            rationale=rationale,
            relevant_dimension_ids=relevant_dimension_ids,
            evidence_excerpts=evidence_excerpts,
            follow_up_questions=follow_up_questions,
            self_claimed_level=self_claimed_level,
        ),
        ensure_ascii=False,
    )


def _model_kwargs(model_id: str | None = None) -> dict:
    resolved = resolve_model(MODEL_ROLE, **_MODEL_DEFAULTS)
    kw: dict = {"model_id": model_id or resolved.model_id}
    if resolved.temperature is not None:
        kw["temperature"] = resolved.temperature
    if resolved.max_tokens is not None:
        kw["max_tokens"] = resolved.max_tokens
    gid = os.environ.get("GUARDRAIL_ID", "")
    if gid:
        kw["guardrail_id"] = gid
        kw["guardrail_version"] = os.environ.get("GUARDRAIL_VERSION", "DRAFT")
        kw["guardrail_trace"] = "enabled"
    return kw


SYSTEM_PROMPT = """\
You are the OrgIQ Assessment Scorer agent. You classify evidence about an
engineering team and score that team against a 17-dimension (ids "1".."17",
never "DIM-01") x 6-level (0-5) engineering-maturity rubric, exactly the way
the source assessment product's `/classify-transcript`, `/score-dimensions`,
and `/process-self-assessment` commands do. You NEVER persist anything — you
return one JSON envelope and a deterministic step downstream applies it.

WORKFLOW:
1. For each item in the input `evidence` array, call classify_evidence(text)
   to get a first-pass classification. You may adjust relevant_dimension_ids
   if the text obviously discusses a dimension the heuristic missed — say so
   in that classification's summary rather than silently overriding it.
2. Determine which dimensions to score: the input's `relevant_dimension_ids`
   if given, otherwise the union of every classify_evidence call's
   relevant_dimension_ids. Score ONLY these dimensions — never all 17 for a
   handful of evidence items, and never a dimension no evidence substantively
   addresses.
3. For each dimension to score, decide from the evidence: the best-supported
   level (0-5; when ambiguous between two levels, prefer the lower one and
   say so), which evidence_ids you are relying on, a confidence
   (low/moderate/high — "moderate" not "medium"), 2-4 sentences of rationale
   citing concrete evidence, any verbatim evidence_excerpts, any
   follow_up_questions, and self_claimed_level if the evidence contains a
   self-rating or level-descriptor claim (else null).
4. Call score_dimension(...) with that proposal and the full evidence_items
   array. It is the deterministic gate: it will refuse dimensions outside
   relevant_dimension_ids, normalise confidence, cap an uncorroborated
   level-4/5 claim at 3, drop any excerpt it cannot verify verbatim in the
   cited evidence, and scrub team-side participant names from the rationale.
   Trust its output over your own draft — if it caps or drops something,
   report that in your final rationale rather than re-asserting your draft.
   If it REFUSES a dimension (refused: true), do not retry with an invented
   value to get past it: omit that dimension from "scores" and record the
   refusal_reason in reasoning_log. A refusal means the proposal could not be
   applied honestly (unknown dimension id, a level that is not a whole 0-5,
   a self-rating claim outside 0-5, or a rationale you did not write).

SCORING STANCE (do not deviate):
- Never fabricate. Every rationale must cite specific evidence content; a
  generic "demonstrated level N practices" with no concrete detail is
  fabrication. If no direct quote supports a claim, leave evidence_excerpts
  empty and prefer "low" confidence.
- Confidence is computed from evidence class, not vibes: Attested (self-report:
  survey/transcript) anchors at 0.3, Documented (written down) at 0.5,
  Observed (demonstrably happens) at 0.9, +0.1 when independent classes
  agree, -0.2 when they conflict. Bands: below 0.40 low, 0.40-0.69 moderate,
  0.70+ high. Levels 0-3 are supportable by Attested+Documented alone; level 4
  requires Observed evidence; level 5 additionally requires Observed evidence
  of sustained practice over time. A self-rating or chosen level-4/5
  descriptor with no corroborating evidence caps at level 3 — say verification
  reached level 3 and stopped there, never "capped" or "marked down".
- N/A is never self-granting. This agent does not decide N/A — if evidence
  says a dimension "doesn't apply", score it on whatever real evidence
  exists (low confidence if none) and note in the rationale that this raises
  an exception request for a human to review; do not set is_na yourself.
- Certification vocabulary only: claimed level, verified level, evidence
  requested. Never "grade", "capped", "penalty", "marked down", "revised
  down". A missing artifact is a request, not a fault.
- Scrub personal names of team-side participants from every rationale;
  replace with role labels ("the team's tech lead", "a senior engineer on
  the team"). Never scrub the assessment team's own attribution — there is
  none in this agent's output. Team names, app names, and org units are not
  PII and stay as-is.
- Write rationale and follow_up_questions in complete plain sentences for a
  non-technical reader on the assessed team — no arrow notation, no bare
  equations, no jargon like "anchor" or "evidence_class".

OUTPUT — return exactly one JSON object and nothing else:
{
  "classification": [ <one classify_evidence result per input evidence item> ],
  "scores": [ <one score_dimension result per dimension actually scored —
               omit any dimension score_dimension refused> ],
  "reasoning_log": [ {"dimension_id": "...", "summary": "..."} , ... ]
}
"""

# System prompt is resolved from Bedrock Prompt Management at run time
# (falls back to the SYSTEM_PROMPT literal above). Editing the managed
# prompt `orgiq-assessment-scorer-system-prompt` changes this agent within
# PROMPT_REFRESH_S — no image rebuild, no redeploy.
_agent = RegistryAgent(
    role=MODEL_ROLE,
    **_MODEL_DEFAULTS,
    baked=SYSTEM_PROMPT,
    agent_name="assessment-scorer",
    build=lambda system_prompt, model_id: Agent(
        model=BedrockModel(**_model_kwargs(model_id)),
        tools=[classify_evidence, score_dimension],
        system_prompt=system_prompt,
    ),
)


@app.entrypoint
async def handle(payload: dict) -> AsyncIterator | dict:
    if not isinstance(payload, dict):
        payload = {}

    rejection = reject_wrong_tenant(
        payload, expected_tenant=EXPECTED_TENANT, agent_id="orgiq-assessment-scorer"
    )
    if rejection is not None:
        log.warning("assessment-scorer: %s", rejection["detail"])
        return rejection

    evidence = payload.get("evidence") or []
    if not evidence:
        return {"agent": "assessment-scorer", "error": "missing evidence[]"}

    team_id = payload.get("team_id") or ""
    mode = payload.get("mode") or "transcript"

    # Built before the trace context on purpose: the streaming branch below
    # returns a generator that establishes its OWN context, so setting one here
    # first would leak a context this call never resets.
    input_text = json.dumps(
        {
            "team_id": team_id,
            "mode": mode,
            "evidence": evidence,
            "relevant_dimension_ids": payload.get("relevant_dimension_ids"),
            "rubric": payload.get("rubric") or {},
        },
        ensure_ascii=False,
        default=str,
    )

    # Genuine AG-UI streaming when the caller asked for it. Nothing
    # post-processes this agent's output, so its tokens can go out as they
    # arrive (contrast assessment-drafter, whose backstops forbid that).
    if wants_stream(payload):
        return stream_agui(
            payload=payload,
            input_text=input_text,
            live_agent=_agent,
            agent_id="orgiq-assessment-scorer",
            agent_name="AssessmentScorer",
            model_id=_agent.model_id,
            ctx_var=_current_ctx,
        )

    ctx = TraceContext.from_request_payload(payload)
    token = _current_ctx.set(ctx)
    shared_token = set_active_ctx(ctx)

    log.info(
        "AssessmentScorer handling (invocation=%s, parent=%s, team=%s, mode=%s): %d evidence item(s)",
        ctx.invocation_id, ctx.parent_invocation_id or "—", team_id, mode, len(evidence),
    )

    t0 = time.monotonic()
    try:
        result = _agent(input_text)
    finally:
        _current_ctx.reset(token)
        reset_active_ctx(shared_token)
    duration_ms = int((time.monotonic() - t0) * 1000)

    response_text = str(result)

    try:
        bundle = ctx.build_trace_bundle(
            prompt=input_text,
            response=response_text,
            agent_id="orgiq-assessment-scorer",
            agent_name="AssessmentScorer",
            model_id=_agent.model_id,
            duration_ms=duration_ms,
            prompt_version=_agent.prompt_sha,
        )
        post_trace(bundle)
    except Exception as exc:  # noqa: BLE001
        log.warning("assessment-scorer: trace emission failed: %s", exc)

    return attach_usage(
        {
            "agent": "assessment-scorer",
            "response": response_text,
            "invocationId": ctx.invocation_id,
        },
        ctx,
        _agent.model_id,
    )


if __name__ == "__main__":
    app.run()
