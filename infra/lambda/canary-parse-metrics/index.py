"""
Canary Parse Metrics Lambda — Prompt A/B canary controller.

Consumes CloudWatch Logs Insights query results comparing prompt versions A vs B
and decides whether to PROMOTE B (shift more traffic), ROLLBACK B (drop to 0%),
or HOLD the current traffic split. Honors manual overrides, cooldown windows,
and minimum-sample gates so we don't act on noisy data.

Input contract (from the Step Functions ParseMetrics task):
  results : list of CW Logs Insights rows (one row per version_label bucket)
  weight  : current weight_b as a string (SSM Parameter.Value)
  control : control flags JSON string (SSM Parameter.Value)
  config  : controller thresholds JSON string (SSM Parameter.Value)

Output:
  action, reason, weight_b_before, weight_b_after, composite_a/b,
  error_rate_a/b, latency_p95_a_ms / _b_ms, sample_count_a/b. Plus on
  PROMOTE/ROLLBACK only: `new_control` — a JSON string the SetCooldown
  step writes back to SSM with cooldown_until = now + cooldown_seconds.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logger = logging.getLogger()
logger.setLevel(logging.INFO)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_NONE_SENTINEL = "0"
_PROMOTE_LATENCY_HEADROOM = 1.25  # B's p95 must be <= A's p95 * 1.25 to promote
_WEIGHT_MIN = 0
_WEIGHT_MAX = 100
_DEFAULT_COOLDOWN_SECONDS = 90


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _coerce_float(raw: Any, default: float = 0.0) -> float:
    """Best-effort float parse. Returns *default* on any failure."""
    if raw is None:
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def _coerce_int(raw: Any, default: int = 0) -> int:
    """Best-effort int parse (via float to tolerate '45.0'). Returns *default* on failure."""
    if raw is None:
        return default
    try:
        return int(float(raw))
    except (TypeError, ValueError):
        return default


def _coerce_dict(raw: Any) -> dict[str, Any]:
    """
    SSM parameters arrive as JSON strings. Accept either a dict (already parsed)
    or a JSON string; bad input degrades to {} so the caller can apply defaults.
    """
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except (TypeError, ValueError):
            logger.warning("Unparseable JSON payload: %r", raw[:120])
            return {}
    return {}


def _parse_iso_or_sentinel(raw: Any) -> datetime | None:
    """
    Parse an ISO 8601 timestamp. Returns None if the sentinel "0" (or any
    unparseable value) is provided.
    """
    if raw is None:
        return None
    s = str(raw).strip()
    if s == "" or s == _NONE_SENTINEL:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        logger.warning("Unparseable ISO timestamp: %r", raw)
        return None


def _flatten_results(rows: list[list[dict]]) -> dict[str, dict[str, Any]]:
    """
    Flatten CW Logs Insights queryResults into {"A": {...}, "B": {...}}.

    Each row is a list of {"field": <name>, "value": <str>} dicts. The
    version_label field selects which bucket the row lands in (matches the
    `by version_label` group in the Insights query). Missing versions yield
    empty dicts (callers should treat absent metrics as 0).
    """
    out: dict[str, dict[str, Any]] = {"A": {}, "B": {}}
    if not rows:
        return out

    for row in rows:
        if not isinstance(row, list):
            continue
        kv: dict[str, Any] = {}
        for cell in row:
            if not isinstance(cell, dict):
                continue
            field = cell.get("field")
            value = cell.get("value")
            if isinstance(field, str):
                kv[field] = value

        version = kv.get("version_label")
        if version in ("A", "B"):
            out[version] = {
                "composite": _coerce_float(kv.get("composite")),
                "error_rate": _coerce_float(kv.get("error_rate")),
                "p95": _coerce_float(kv.get("p95")),
                "n": _coerce_int(kv.get("n")),
            }

    # Ensure both buckets always have the canonical numeric keys.
    for v in ("A", "B"):
        if not out[v]:
            out[v] = {"composite": 0.0, "error_rate": 0.0, "p95": 0.0, "n": 0}

    return out


def _decide(
    metrics: dict[str, dict[str, Any]],
    current: int,
    config: dict[str, Any],
) -> dict[str, Any]:
    """
    Apply the canary decision rules.

    Returns a dict with keys: action, weight_b_after, reason.
    """
    min_samples = _coerce_int(config.get("min_samples"), 30)
    promotion_delta = _coerce_float(config.get("promotion_delta"), 0.05)
    rollback_floor = _coerce_float(config.get("rollback_floor"), 0.55)
    error_ceiling = _coerce_float(config.get("error_ceiling"), 0.05)
    latency_p95_ceiling_ms = _coerce_float(
        config.get("latency_p95_ceiling_ms"), 8000.0
    )
    step_pp = _coerce_int(config.get("step_pp"), 10)

    a = metrics["A"]
    b = metrics["B"]

    n_a = _coerce_int(a.get("n"))
    n_b = _coerce_int(b.get("n"))

    # Gate 1: minimum samples
    if n_a < min_samples or n_b < min_samples:
        return {
            "action": "SKIPPED_NO_SAMPLES",
            "weight_b_after": current,
            "reason": (
                f"Insufficient samples (A={n_a}, B={n_b}, "
                f"min_samples={min_samples})"
            ),
        }

    composite_a = _coerce_float(a.get("composite"))
    composite_b = _coerce_float(b.get("composite"))
    error_rate_b = _coerce_float(b.get("error_rate"))
    p95_a = _coerce_float(a.get("p95"))
    p95_b = _coerce_float(b.get("p95"))

    delta_ba = composite_b - composite_a
    delta_ab = composite_a - composite_b

    # Gate 2: rollback rules (any one trips it)
    if composite_b < rollback_floor:
        return {
            "action": "ROLLBACK",
            "weight_b_after": 0,
            "reason": (
                f"B composite {composite_b:.4f} below rollback floor "
                f"{rollback_floor:.4f}"
            ),
        }
    if error_rate_b > error_ceiling:
        return {
            "action": "ROLLBACK",
            "weight_b_after": 0,
            "reason": (
                f"B error_rate {error_rate_b:.4f} exceeds ceiling "
                f"{error_ceiling:.4f}"
            ),
        }
    if p95_b > latency_p95_ceiling_ms:
        return {
            "action": "ROLLBACK",
            "weight_b_after": 0,
            "reason": (
                f"B p95 {p95_b:.0f}ms exceeds latency ceiling "
                f"{latency_p95_ceiling_ms:.0f}ms"
            ),
        }
    if delta_ab >= promotion_delta:
        return {
            "action": "ROLLBACK",
            "weight_b_after": 0,
            "reason": (
                f"A beats B by {delta_ab:.4f} (>= promotion_delta "
                f"{promotion_delta:.4f})"
            ),
        }

    # Gate 3: promotion rule
    promote_latency_ok = p95_b <= p95_a * _PROMOTE_LATENCY_HEADROOM
    if (
        delta_ba >= promotion_delta
        and error_rate_b <= error_ceiling
        and promote_latency_ok
    ):
        new_weight = min(_WEIGHT_MAX, current + step_pp)
        return {
            "action": "PROMOTE",
            "weight_b_after": new_weight,
            "reason": (
                f"B beats A by {delta_ba:.4f}, error {error_rate_b:.4f} "
                f"under ceiling"
            ),
        }

    # Otherwise: hold
    return {
        "action": "HOLD",
        "weight_b_after": current,
        "reason": (
            f"No rule fired (delta_BA={delta_ba:.4f}, "
            f"error_B={error_rate_b:.4f}, p95_B={p95_b:.0f}ms)"
        ),
    }


def _round_float(value: Any, places: int = 4) -> float:
    """Round to *places* decimals, coercing non-numeric inputs to 0.0."""
    return round(_coerce_float(value), places)


def _clamp_weight(value: int) -> int:
    return max(_WEIGHT_MIN, min(_WEIGHT_MAX, int(value)))


def _build_new_control(control: dict[str, Any], cooldown_seconds: int) -> str:
    """
    Merge a new cooldown_until into the existing control dict and serialize.
    Preserves manual_override_until and halted unchanged.
    """
    cooldown_until = (
        datetime.now(tz=timezone.utc) + timedelta(seconds=cooldown_seconds)
    ).isoformat()
    merged = {
        "manual_override_until": control.get("manual_override_until", _NONE_SENTINEL),
        "cooldown_until": cooldown_until,
        "halted": bool(control.get("halted", False)),
    }
    return json.dumps(merged)


# ---------------------------------------------------------------------------
# Lambda entry point
# ---------------------------------------------------------------------------


def lambda_handler(event: dict, context: Any) -> dict:  # noqa: ARG001
    """
    Main entry point.

    Decision order:
      1. Manual halt (control.halted) -> SKIPPED_OVERRIDE.
      2. Manual override window (control.manual_override_until) -> SKIPPED_OVERRIDE.
      3. Cooldown window (control.cooldown_until) -> SKIPPED_COOLDOWN.
      4. Sample-size gate -> SKIPPED_NO_SAMPLES.
      5. Rollback rules -> ROLLBACK.
      6. Promotion rule -> PROMOTE.
      7. Otherwise -> HOLD.
    """
    query_results = event.get("results") or []
    current_weight_b = _clamp_weight(_coerce_int(event.get("weight"), 0))
    config = _coerce_dict(event.get("config"))
    control = _coerce_dict(event.get("control"))

    metrics = _flatten_results(query_results)
    a = metrics["A"]
    b = metrics["B"]

    # Build the metric scaffold the response always includes.
    base_response: dict[str, Any] = {
        "weight_b_before": current_weight_b,
        "weight_b_after": current_weight_b,
        "composite_a": _round_float(a.get("composite")),
        "composite_b": _round_float(b.get("composite")),
        "error_rate_a": _round_float(a.get("error_rate")),
        "error_rate_b": _round_float(b.get("error_rate")),
        "latency_p95_a_ms": _coerce_int(a.get("p95")),
        "latency_p95_b_ms": _coerce_int(b.get("p95")),
        "sample_count_a": _coerce_int(a.get("n")),
        "sample_count_b": _coerce_int(b.get("n")),
    }

    # Step 1: explicit halt
    if bool(control.get("halted")):
        logger.info("Canary halted via control.halted=true")
        return {
            "action": "SKIPPED_OVERRIDE",
            "reason": "Canary halted via control.halted=true",
            **base_response,
        }

    now = datetime.now(tz=timezone.utc)

    # Step 2: manual override window
    override_until = _parse_iso_or_sentinel(control.get("manual_override_until"))
    if override_until is not None and now < override_until:
        logger.info("Manual override active until %s", override_until.isoformat())
        return {
            "action": "SKIPPED_OVERRIDE",
            "reason": (
                f"Manual override active until {override_until.isoformat()}"
            ),
            **base_response,
        }

    # Step 3: cooldown window
    cooldown_until = _parse_iso_or_sentinel(control.get("cooldown_until"))
    if cooldown_until is not None and now < cooldown_until:
        logger.info("Cooldown active until %s", cooldown_until.isoformat())
        return {
            "action": "SKIPPED_COOLDOWN",
            "reason": f"Cooldown active until {cooldown_until.isoformat()}",
            **base_response,
        }

    # Steps 4-7: sample gate + rollback/promote/hold decision
    decision = _decide(metrics, current_weight_b, config)
    new_weight = _clamp_weight(_coerce_int(decision.get("weight_b_after"), current_weight_b))

    response: dict[str, Any] = {
        "action": decision["action"],
        "reason": decision["reason"],
        **base_response,
        "weight_b_after": new_weight,
    }

    # Only PROMOTE / ROLLBACK update SSM weight + cooldown. The Step Function
    # routes those two actions through SetCooldown which writes new_control;
    # HOLD / SKIPPED_* go straight to audit.
    if decision["action"] in ("PROMOTE", "ROLLBACK"):
        cooldown_seconds = _coerce_int(
            config.get("cooldown_seconds"), _DEFAULT_COOLDOWN_SECONDS
        )
        response["new_control"] = _build_new_control(control, cooldown_seconds)

    logger.info(
        "Canary decision: action=%s weight_b %d->%d reason=%s",
        response["action"],
        current_weight_b,
        new_weight,
        response["reason"],
    )
    return response
