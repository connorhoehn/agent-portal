import json
from document_commands import (
    DECK_MODES, DECK_PROMPT, DOCUMENT_MODES, DOCUMENT_PROMPT, validate_deck_output, validate_document_output,
)
from evidence_commands import EVIDENCE_MODES, EVIDENCE_PROMPT, validate_evidence_output
from agent_plan import AGENT_PLAN_MODES, AGENT_PLAN_PROMPT, validate_agent_plan
from deck_narrative import DECK_NARRATIVE_MODES, DECK_REVISE_MODES, DECK_NARRATIVE_PROMPT, DECK_NARRATIVE_TENANTS, validate_deck_narrative_output
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
from _shared.untrusted_text import Fence, with_data_rule  # noqa: E402
from _shared.agui_stream import (  # noqa: E402
    agui_events_for_text,
    run_error_event,
    wants_stream,
)
from _shared.tenant_guard import reject_wrong_mode_tenant  # noqa: E402
from _shared.invoke_auth import request_fields  # noqa: E402
from _shared.instrumentation import (  # noqa: E402
    attach_usage,
    TraceContext,
    install_bedrock_usage_capture,
    instrumented_tool,
    post_trace,
    reset_active_ctx,
    set_active_ctx,
)

# Deterministic guardrails — dependency-free, unit tested on their own in
# tests/test_drafting_logic.py without needing strands/bedrock_agentcore.
from drafting_logic import scrub_forbidden_promises, validate_context_facts

# Patch boto3's bedrock-runtime client BEFORE Strands constructs its own —
# otherwise Converse usage is invisible to our TraceContext.
install_bedrock_usage_capture()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# Per-invocation trace buffer.
_current_ctx: ContextVar[TraceContext | None] = ContextVar(
    "assessment_drafter_trace_ctx", default=None
)

app = BedrockAgentCoreApp()

REGION = os.environ.get("AWS_REGION", "us-east-1")
# DE-3: the model comes from the central registry (SSM /orgiq/models/registry,
# written from infra/config/model-registry.json), then the MODEL_ID env var,
# then the literal below. MODEL_ID is the import-time view; every turn
# re-resolves (60 s cache) and may fall back on capacity errors, so traces
# record _agent.model_id, the id actually served.
MODEL_ROLE = "assessment-drafter"
_MODEL_DEFAULTS = {"default_model_id": "amazon.nova-pro-v1:0", "default_temperature": None, "default_max_tokens": None}
MODEL_ID = resolve_model(MODEL_ROLE, **_MODEL_DEFAULTS).model_id

# This agent serves exactly one tenant, enforced in code (see
# agents/_shared/tenant_guard.py for why this is stricter than the news-*
# agents, which rely on the middleware route gate alone).
EXPECTED_TENANT = "assessment"

# Per-mode tenant guard: every mode is assessment-only unless listed here. The
# deck-narrative and deck-revise modes belong to exactly one other tenant each,
# so an assessment session cannot run them and orgiq/pipelines/social sessions
# cannot run any assessment mode.
MODE_TENANTS = dict(DECK_NARRATIVE_TENANTS)


@tool
@instrumented_tool(_current_ctx.get)
def check_story_draft(draft_markdown: str) -> str:
    """Scan a drafted Jira-style story for a level promise or an effort estimate.

    This is the deterministic backstop for the two hardest rules in this
    agent's job: never promise a level ("this moves the team to Level 3" is
    forbidden; "this is what we would need to confirm Level 3" is fine), and
    never estimate human effort (no story points, no hours, no "quick win").
    Call this on your draft before returning it. If it reports any
    violations, rewrite those sentences yourself and call it again — do not
    return a draft this tool flagged.

    Args:
        draft_markdown: The full story draft (metadata table + body) to check.

    Returns:
        JSON object: {ok, violations, scrubbed_markdown}. scrubbed_markdown
        has each violating phrase replaced with a "[NEEDS INPUT: ...]"
        marker — a safety net, not a substitute for rewriting the sentence.
    """
    scrubbed, violations = scrub_forbidden_promises(draft_markdown)
    return json.dumps(
        {"ok": not violations, "violations": violations, "scrubbed_markdown": scrubbed},
        ensure_ascii=False,
    )


@tool
@instrumented_tool(_current_ctx.get)
def validate_facts(facts: list, source_text: str) -> str:
    """Validate extracted governance facts against the source document.

    Drops any fact whose category/scope/fact_type is outside the fixed
    vocabulary, or whose source_span is not a verbatim substring of
    source_text — the same "no fabrication" rule the scorer applies to
    evidence excerpts, applied here to context extraction. Call this before
    finalizing a context-mode response; use only the facts it returns.

    Args:
        facts: Candidate facts, each {category, scope, fact_type, text, source_span}.
            category must be one of standards|process|organization|tooling.
            scope must be one of shared|team. fact_type must be one of
            observed|gap|recommendation.
        source_text: The full text of the source document the facts were
            extracted from.

    Returns:
        JSON array of the facts that verified (unchanged, aside from
        vocabulary normalisation) — never a super- or re-written set.
    """
    return json.dumps(validate_context_facts(facts, source_text), ensure_ascii=False)


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
You are the OrgIQ Assessment Drafter agent. You draft two kinds of documents
for the engineering-maturity assessment product, one recommendation or one
document at a time. You are read-only: you never call Jira, Confluence, or
any other API, you never fetch the web, and you never delegate to another
agent. You only produce text.

You run in exactly one of two modes, given in the input JSON as "mode".

═══ mode = "story" ═══

Input: one recommendation {kind, dimension_id, title, rationale} plus team
context (verified/claimed levels, level_up_criteria, enterprise context
excerpts, open follow-up questions — whatever the caller supplied). Do NOT
re-derive or second-guess the recommendation's kind or ranking — it was
computed deterministically upstream from the team's certification; your job
is only to write the story that this one recommendation calls for.

The three kinds are NOT the same story:
- "close_the_claim" — the team's own rating already describes this practice;
  verification stopped lower because the evidence on file doesn't reach that
  far. The work is producing or locating an artifact (exporting pipeline
  history, attaching a dashboard, pointing at a runbook) — never "build
  this", because the team may already have it. Say so plainly in the summary.
- "advance_practice" — the practice genuinely isn't in place. The story
  advances the dimension from its verified level toward the next one.
- "answer_question" — the dimension couldn't be assessed yet. The story is
  about answering the specific open questions, quoted verbatim.

Write the story in this shape (same shape as the source product's Jira story
template):

    | Field | Value |
    | --- | --- |
    | Project key | [NEEDS INPUT] [ID: S_Q1] |
    | Issue type | Story |
    | Team | <team id> |
    | Dimension | <digits only, e.g. 6> |
    | Verified level | <whole number, or "none on file"> |
    | Claimed level | <whole number, or "none on file"> |
    | Level this story works toward | <the level this story would help confirm> |
    | Plan entry | Close the claim | Advance the practice | Answer the question |
    | Priority | [NEEDS INPUT] [ID: S_Q2] |
    | Owner | [NEEDS INPUT] [ID: S_Q3] |
    | Labels | maturity-dim-<same dimension number> |
    | Generated From | <path or description of the source this was drafted from> |
    | Jira Key | |

    ## Summary
    ...

    ## Acceptance Criteria
    - Each criterion cites the specific enterprise-context pattern it enforces,
      by name, when one was supplied (e.g. "per the CI pipeline policy").

    ## Definition of Done
    ...

    ## Open Questions
    - [NEEDS INPUT] [ID: S_Qn] ...

Anything unknown (Jira project, priority, owner, an exact repo or tooling
detail) becomes a "[NEEDS INPUT] [ID: S_Qn]" marker — never invent it.

HARD RULES, enforced in code as well as here — call check_story_draft on your
draft before returning it, and rewrite anything it flags:
- NEVER promise a level. Attaching an artifact does not guarantee a higher
  verified level. Write "this is what we would need to confirm Level 3", never
  "this moves the team to Level 3".
- NEVER estimate human effort. No story points, no hours, no "quick win", no
  target sprint. Sizing is the team's call, made with context you don't have.
- Certification vocabulary only: claimed level, verified level, evidence
  requested — never "grade", "capped", "penalty", "marked down", "revised
  down". A missing artifact is a request, not a fault.
- Write for a non-technical reader on the assessed team: complete sentences,
  no arrow notation, no bare equations, no jargon.

═══ mode = "context" ═══

Input: one document's text (and, for a team-scoped document, a team id).
Extract organization-wide or team-specific governance facts: process (SDLC
workflows, approval gates), organization (roles, team structures, ownership),
tooling (systems, integrations), standards (conventions, tribal knowledge).

NEVER profile or evaluate a specific named individual — role and process
context is fine, assessing a person is not.

For each fact, produce {category, scope, fact_type, text, source_span}:
- category: standards | process | organization | tooling
- scope: "shared" (broadly applicable) or "team" (about exactly one team)
- fact_type: "observed" (current practice) | "gap" (a stated deficiency) |
  "recommendation" (proposed future-state guidance) — never report a
  recommendation as already-implemented practice
- text: the extracted fact, concise, no padding
- source_span: a VERBATIM substring of the input document that supports this
  fact — never paraphrase into source_span, and never fabricate one

Call validate_facts(facts, source_text) before returning — it drops any fact
whose source_span isn't verbatim in the document, or whose vocabulary is
outside the fixed enums above. Return only what it validates.

OUTPUT (context mode) — return exactly one JSON object and nothing else:
{"facts": [ <validated facts> ]}
"""

SYSTEM_PROMPT += DOCUMENT_PROMPT + DECK_PROMPT + EVIDENCE_PROMPT + AGENT_PLAN_PROMPT

# System prompt is resolved from Bedrock Prompt Management at run time
# (falls back to the SYSTEM_PROMPT literal above). Editing the managed
# prompt `orgiq-assessment-drafter-system-prompt` changes this agent within
# PROMPT_REFRESH_S — no image rebuild, no redeploy.
_agent = RegistryAgent(
    role=MODEL_ROLE,
    **_MODEL_DEFAULTS,
    baked=SYSTEM_PROMPT,
    agent_name="assessment-drafter",
    build=lambda system_prompt, model_id: Agent(
        model=BedrockModel(**_model_kwargs(model_id)),
        tools=[check_story_draft, validate_facts],
        system_prompt=with_data_rule(system_prompt),
    ),
)


def _validate_payload(payload: dict) -> str | None:
    """None if payload is well-formed for its mode; else an error string."""
    mode = payload.get("mode")
    if mode not in ("story", "context") and mode not in DOCUMENT_MODES and mode not in DECK_MODES and mode not in EVIDENCE_MODES and mode not in AGENT_PLAN_MODES and mode not in DECK_NARRATIVE_MODES:
        return "mode must be story, context, or a supported document or deck command"
    if mode in EVIDENCE_MODES:
        dim = payload.get("dimension")
        if not isinstance(dim, dict) or not isinstance(dim.get("id"), str) or not isinstance(dim.get("evidence"), list):
            return f"{mode} requires dimension: {{id, facts, criteria, evidence}}"
        return None
    if mode in DECK_REVISE_MODES:
        if not isinstance(payload.get("spec"), dict) or not isinstance(payload.get("instruction"), str):
            return f"{mode} requires spec and instruction"
        return None
    if mode in DECK_NARRATIVE_MODES:
        slides = payload.get("slides")
        if not isinstance(slides, list) or not slides or any(
            not isinstance(s, dict) or not isinstance(s.get("slideId"), str) for s in slides
        ):
            return f"{mode} requires slides: [{{slideId, kind, facts, evidence}}]"
        return None
    if mode in AGENT_PLAN_MODES:
        if not isinstance(payload.get("goal"), str) or not isinstance(payload.get("allowed_kinds"), list):
            return f"{mode} requires goal and allowed_kinds"
        return None
    if mode == "draft-review-deck":
        slides = payload.get("slides")
        if not isinstance(slides, list) or not slides or any(
            not isinstance(s, dict) or not isinstance(s.get("slideId"), str) for s in slides
        ):
            return "draft-review-deck requires slides: [{slideId, kind, facts, evidence}]"
        return None
    if mode == "revise-review-deck":
        if not isinstance(payload.get("spec"), dict) or not isinstance(payload.get("instruction"), str):
            return "revise-review-deck requires spec and instruction"
        return None
    if mode == "story":
        rec = payload.get("recommendation")
        if not isinstance(rec, dict) or not rec.get("dimension_id") or not rec.get("kind"):
            return "story mode requires recommendation: {kind, dimension_id, title, rationale}"
    else:
        doc = payload.get("document")
        if not isinstance(doc, dict) or not isinstance(doc.get("text"), str) or not doc.get("text"):
            return "context mode requires document: {text, ...}"
    return None


@app.entrypoint
async def handle(payload: dict) -> AsyncIterator | dict:
    """AG-UI stream when asked for one, dict for A2A callers.

    Unlike the other agents this does NOT stream the model's tokens. Every path
    through ``_handle_sync`` ends in a deterministic backstop —
    ``scrub_forbidden_promises`` for a story, ``validate_context_facts`` (which
    fails closed) for context — and those exist precisely to keep certain text
    from reaching the caller. Emitting deltas as the model produced them would
    hand over the unscrubbed, unvalidated draft first and leave the backstops
    with nothing left to protect. So the run completes, the backstops apply, and
    the validated answer is emitted as AG-UI events: same protocol and same
    consumers, one content event instead of many.
    """
    result = await _handle_sync(payload)
    if wants_stream(payload):
        return _stream_result(result)
    return result


async def _stream_result(result: dict) -> AsyncIterator:
    """The dict from ``_handle_sync`` as AG-UI events."""
    error = result.get("error")
    if error:
        # The agents' error envelope becomes a terminal AG-UI event, so the
        # middleware marks the run failed instead of rendering a blank answer.
        yield run_error_event(str(error), code="assessment_drafter_stream_error")
        return
    for event in agui_events_for_text(result.get("response") or ""):
        yield event


#: The input JSON carries uploaded documents and evidence text; the middleware
#: caps it near 64 KB, so this bound only matters for a direct invoke.
MAX_INPUT_CHARS = 80_000


def _fenced_input(fields: dict) -> str:
    """The run's input JSON (documents, evidence, team context: untrusted
    text) as one fenced data block (_shared/untrusted_text.py)."""
    return Fence().wrap(json.dumps(fields, ensure_ascii=False, default=str), kind="input-json",
                        max_chars=MAX_INPUT_CHARS)


async def _handle_sync(payload: dict) -> dict:
    if not isinstance(payload, dict):
        payload = {}

    rejection = reject_wrong_mode_tenant(
        payload, mode_tenants=MODE_TENANTS, default_tenant=EXPECTED_TENANT,
        agent_id="orgiq-assessment-drafter",
    )
    if rejection is not None:
        log.warning("assessment-drafter: %s", rejection["detail"])
        return rejection

    # The structured fields (mode, document, ...) arrive nested under `input`;
    # identity is read only from the verified auth block (the guard above).
    fields = request_fields(payload)
    error = _validate_payload(fields)
    if error is not None:
        return {"agent": "assessment-drafter", "error": error}

    mode = fields["mode"]
    team_id = fields.get("team_id") or ""

    ctx = TraceContext.from_request_payload(payload)
    token = _current_ctx.set(ctx)
    shared_token = set_active_ctx(ctx)

    input_text = (DOCUMENT_PROMPT + "\n" if mode in DOCUMENT_MODES else DECK_PROMPT + "\n" if mode in DECK_MODES else EVIDENCE_PROMPT + "\n" if mode in EVIDENCE_MODES else AGENT_PLAN_PROMPT + "\n" if mode in AGENT_PLAN_MODES else DECK_NARRATIVE_PROMPT + "\n" if mode in DECK_NARRATIVE_MODES else "") + _fenced_input(fields)

    log.info(
        "AssessmentDrafter handling (invocation=%s, parent=%s, team=%s, mode=%s)",
        ctx.invocation_id, ctx.parent_invocation_id or "—", team_id, mode,
    )

    t0 = time.monotonic()
    try:
        result = _agent(input_text)
    finally:
        _current_ctx.reset(token)
        reset_active_ctx(shared_token)
    duration_ms = int((time.monotonic() - t0) * 1000)

    response_text = str(result)

    # Deterministic backstops — belt and suspenders over the prompt + tool
    # calls the model may or may not have made faithfully.
    if mode == "story":
        scrubbed, violations = scrub_forbidden_promises(response_text)
        if violations:
            log.warning(
                "assessment-drafter: story draft contained forbidden phrases, scrubbed: %s",
                violations,
            )
            response_text = scrubbed
    elif mode in EVIDENCE_MODES:
        response_text = validate_evidence_output(mode, response_text, fields)
    elif mode in DECK_NARRATIVE_MODES:
        response_text = validate_deck_narrative_output(mode, response_text, fields)
    elif mode in AGENT_PLAN_MODES:
        response_text = validate_agent_plan(mode, response_text, fields)
    elif mode in DECK_MODES:
        response_text = validate_deck_output(mode, response_text, fields)
    elif mode in DOCUMENT_MODES:
        try:
            response_text = validate_document_output(mode, response_text, fields["document"]["text"])
        except (ValueError, TypeError, KeyError) as exc:
            return {"agent": "assessment-drafter", "error": f"Invalid document draft: {exc}"}
    else:  # context
        document_text = (fields.get("document") or {}).get("text", "")
        try:
            parsed = json.loads(response_text)
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            # Not JSON at all — there is no facts array to re-validate, and
            # the caller will fail to parse this the same way we did.
            log.warning("assessment-drafter: response was not JSON, left as-is: %s", exc)
        else:
            if isinstance(parsed, dict) and isinstance(parsed.get("facts"), list):
                try:
                    validated = validate_context_facts(parsed["facts"], document_text)
                except Exception as exc:  # noqa: BLE001
                    # Fail CLOSED. This backstop's whole job is to drop facts
                    # whose source_span isn't in the document; if it cannot
                    # run, passing the model's own list through unchecked is
                    # the one outcome worse than returning nothing.
                    log.error(
                        "assessment-drafter: fact validation failed (%s) — dropping all "
                        "%d candidate fact(s) rather than returning unvalidated ones",
                        exc, len(parsed["facts"]),
                    )
                    validated = []
                parsed["facts"] = validated
                response_text = json.dumps(parsed, ensure_ascii=False)

    try:
        bundle = ctx.build_trace_bundle(
            prompt=input_text,
            response=response_text,
            agent_id="orgiq-assessment-drafter",
            agent_name="AssessmentDrafter",
            model_id=_agent.model_id,
            duration_ms=duration_ms,
            prompt_version=_agent.prompt_sha,
        )
        post_trace(bundle)
    except Exception as exc:  # noqa: BLE001
        log.warning("assessment-drafter: trace emission failed: %s", exc)

    return attach_usage(
        {
            "agent": "assessment-drafter",
            "response": response_text,
            "invocationId": ctx.invocation_id,
        },
        ctx,
        _agent.model_id,
    )


if __name__ == "__main__":
    app.run()
