"""Cost tracking for the synth pipeline.

bedrock.py records every Converse + invoke_model call here. Print the
running total whenever you want — `python -m schema.synth all` prints it at
the end.

Prices in $/token are conservative as of May 2026 (on-demand pricing).
"""
from __future__ import annotations

import atexit
import sys
from collections import defaultdict
from dataclasses import dataclass, field


# Prices in $/token. Update if AWS publishes new rates.
PRICES_PER_TOKEN = {
    # (input, output)
    "amazon.nova-pro-v1:0":          (0.80e-6, 3.20e-6),
    "amazon.nova-lite-v1:0":         (0.06e-6, 0.24e-6),
    "amazon.titan-embed-text-v2:0":  (0.02e-6, 0.0),
}


@dataclass
class ModelStats:
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0

    def cost(self, model_id: str) -> float:
        inp_p, out_p = PRICES_PER_TOKEN.get(model_id, (0.0, 0.0))
        return self.input_tokens * inp_p + self.output_tokens * out_p


_stats: dict[str, ModelStats] = defaultdict(ModelStats)
_printed_atexit = False


def record(model_id: str, input_tokens: int, output_tokens: int = 0) -> None:
    s = _stats[model_id]
    s.calls += 1
    s.input_tokens += int(input_tokens or 0)
    s.output_tokens += int(output_tokens or 0)


def summary() -> str:
    if not _stats:
        return "(no Bedrock calls recorded)"
    lines = [
        f"{'model':<32} {'calls':>6} {'input':>10} {'output':>10} {'cost ($)':>10}"
    ]
    total = 0.0
    for model_id, s in sorted(_stats.items()):
        c = s.cost(model_id)
        total += c
        lines.append(
            f"{model_id:<32} {s.calls:>6} {s.input_tokens:>10} {s.output_tokens:>10} {c:>10.4f}"
        )
    lines.append(f"{'TOTAL':<32} {'':>6} {'':>10} {'':>10} {total:>10.4f}")
    return "\n".join(lines)


def reset() -> None:
    _stats.clear()


def _atexit_print():
    global _printed_atexit
    if _printed_atexit or not _stats:
        return
    _printed_atexit = True
    print("\nBedrock cost summary:", file=sys.stderr)
    print(summary(), file=sys.stderr)


atexit.register(_atexit_print)
