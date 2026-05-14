import json
import logging
import os
import re
import sys
from pathlib import Path

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models.bedrock import BedrockModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = BedrockAgentCoreApp()

REGION = os.environ.get("AWS_REGION", "us-east-1")
MODEL_ID = os.environ.get("MODEL_ID", "amazon.nova-pro-v1:0")

# ── Heuristic scoring tool ─────────────────────────────────────────────────────

_ACTION_VERBS = {
    "reveals", "exposes", "launches", "warns", "breaks", "surges", "drops",
    "hits", "beats", "misses", "wins", "loses", "fights", "defends", "calls",
    "urges", "demands", "pledges", "vows", "unveils", "announces", "confirms",
    "denies", "reports", "shows", "finds", "proves", "sparks", "triggers",
    "boosts", "cuts", "raises", "slashes", "bans", "approves", "rejects",
    "backs", "blocks", "halts", "crashes", "jumps", "falls", "climbs",
    "faces", "targets", "accuses", "joins", "quits", "leaves", "returns",
    "plans", "eyes", "seeks", "pushes", "pulls", "signals", "overtakes",
    "leads", "trails", "outruns", "doubles", "triples", "threatens",
}


@tool
def score_headline(headline: str) -> str:
    """Compute heuristic quality signals for a news headline.

    Returns a JSON object with the following keys:
      - headline: the original headline text
      - length: character count
      - wordCount: number of words
      - hasNumber: true if the headline contains a digit
      - hasActionVerb: true if a recognised action verb appears (case-insensitive)
      - hasQuestion: true if the headline ends with '?'
      - capsRatio: fraction of alphabetic characters that are uppercase (0.0–1.0)
      - startsWithKeyword: true if the headline begins with a strong news keyword

    Args:
        headline: The headline text to evaluate.
    """
    words = headline.split()
    alpha_chars = [c for c in headline if c.isalpha()]
    upper_chars = [c for c in alpha_chars if c.isupper()]
    caps_ratio = round(len(upper_chars) / len(alpha_chars), 3) if alpha_chars else 0.0

    # Check action verb presence (full-word match, case-insensitive)
    word_set = {re.sub(r"[^a-z]", "", w.lower()) for w in words}
    has_action_verb = bool(word_set & _ACTION_VERBS)

    # Strong opening keywords that signal a news lead
    _LEAD_KEYWORDS = {"how", "why", "what", "who", "when", "inside", "exclusive", "breaking"}
    first_word = re.sub(r"[^a-z]", "", words[0].lower()) if words else ""
    starts_with_keyword = first_word in _LEAD_KEYWORDS

    result = {
        "headline": headline,
        "length": len(headline),
        "wordCount": len(words),
        "hasNumber": bool(re.search(r"\d", headline)),
        "hasActionVerb": has_action_verb,
        "hasQuestion": headline.strip().endswith("?"),
        "capsRatio": caps_ratio,
        "startsWithKeyword": starts_with_keyword,
    }
    return json.dumps(result, ensure_ascii=False)


# ── System prompt ──────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are the OrgIQ Headline Optimizer. Your job is to help journalists
craft compelling, SEO-friendly headlines that maximise click-through and reader clarity.

## Task
Given a draft article headline and first paragraph (lede), produce exactly 5 alternative
headline variants, each emphasising a different editorial angle:

  1. DESCRIPTIVE  — clear, factual, informative
  2. QUESTION     — opens a curiosity gap with a direct question
  3. SURPRISE     — subverts expectation; uses contrast or unexpected framing
  4. LIST-FORMAT  — numbered list teaser ("5 Ways…", "3 Reasons…")
  5. QUOTE-STYLE  — paraphrases a compelling implied quote or insider claim

## Scoring
For EACH variant, call the `score_headline` tool and use the returned heuristics to
inform three editorial scores (0–10 integers):
  - clarity:    How unambiguous and easy to parse is the headline?
  - engagement: How likely is a reader to click or share?
  - seo:        How well does it use searchable keywords without keyword-stuffing?

Scoring guide (use the heuristic signals as inputs):
  - A short headline (≤ 80 chars) scores +1 on clarity.
  - `hasActionVerb` scores +1 on engagement.
  - `hasNumber` scores +1 on seo AND +1 on engagement.
  - `hasQuestion` scores +1 on engagement.
  - `capsRatio` > 0.25 (excessive shouting) deducts 1 from clarity.
  - `startsWithKeyword` scores +1 on seo.
  Remaining points come from editorial judgement based on the lede content.

## Output format
After scoring all 5 variants, respond with ONLY a JSON array — no markdown fences,
no preamble, no trailing commentary. The array must have exactly 5 objects:

[
  {
    "variant": "<headline text>",
    "angle": "<DESCRIPTIVE|QUESTION|SURPRISE|LIST-FORMAT|QUOTE-STYLE>",
    "clarity": <0-10>,
    "engagement": <0-10>,
    "seo": <0-10>,
    "rationale": "<one sentence explaining why this variant works>"
  },
  ...
]

Strict JSON only. Do not wrap in markdown. Do not add any text before or after the array."""

_model = BedrockModel(model_id=MODEL_ID)
_agent = Agent(
    model=_model,
    tools=[score_headline],
    system_prompt=SYSTEM_PROMPT,
)


# ── Entrypoint ────────────────────────────────────────────────────────────────

@app.entrypoint
async def handle(payload: dict) -> dict:
    if isinstance(payload, dict):
        input_text = (
            payload.get("input_text")
            or payload.get("prompt")
            or payload.get("message")
            or ""
        )
    else:
        input_text = str(payload)

    if not input_text:
        return {"agent": "news-headline", "error": "missing input_text/prompt/message"}

    log.info("HeadlineOptimizer handling: %s", input_text[:120])

    result = _agent(input_text)
    response_text = str(result)

    return {
        "agent": "news-headline",
        "response": response_text,
    }


if __name__ == "__main__":
    app.run()
