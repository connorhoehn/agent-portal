"""Synth pipeline configuration — demo-grade defaults."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


SYNTH_DIR = Path(__file__).resolve().parent
CACHE_DIR = SYNTH_DIR / "cache"
CACHE_DIR.mkdir(exist_ok=True)


# AWS-native models only. See memory: feedback_aws_native_models.
NOVA_PRO = "amazon.nova-pro-v1:0"
NOVA_LITE = "amazon.nova-lite-v1:0"
TITAN_V2 = "amazon.titan-embed-text-v2:0"
NOVA_CANVAS = "amazon.nova-canvas-v1:0"   # image generation (avatars)
EMBEDDING_DIM = 1024


_ACCOUNT_CACHE: dict[str, str] = {}


def _caller_account() -> str:
    """Account id of the active credentials, asked once per process."""
    if "id" not in _ACCOUNT_CACHE:
        import boto3
        try:
            _ACCOUNT_CACHE["id"] = boto3.client("sts").get_caller_identity()["Account"]
        except Exception as exc:  # noqa: BLE001 — surface the real cause
            raise RuntimeError(
                "Could not determine the AWS account for the documents bucket. "
                "Run `aws-azure-login --mode gui`, or set AWS_ACCOUNT_ID explicitly."
            ) from exc
    return _ACCOUNT_CACHE["id"]


@dataclass(frozen=True)
class SynthConfig:
    region: str = field(default_factory=lambda: os.environ.get("AWS_REGION", "us-east-1"))
    aurora_stack: str = "OrgIQ-Aurora"
    aurora_db: str = "orgiq"

    # Demo-grade doc counts (override via env for stress testing).
    n_adrs_per_decision: int = 1               # 1 × ~10 decisions = ~10
    n_postmortems_per_project: int = 1         # 1 × ~12 projects = ~12
    n_perf_reviews_per_person: int = 1         # 1 × ~60 people  = ~60
    n_slack_threads_per_project: int = 5       # 5 × ~12 projects = ~60
    n_all_hands: int = 6                       # monthly cadence

    # Generation params.
    temperature_structured: float = 0.4        # ADR / postmortem / perf review
    temperature_casual: float = 0.7            # Slack / all-hands
    max_output_tokens: int = 4096

    # Validation thresholds.
    dup_cosine_threshold: float = 0.92

    # S3 layout for KB ingestion.
    @property
    def s3_bucket(self) -> str:
        """
        The documents bucket for the account these credentials belong to.

        Resolved from STS rather than required in the environment. An env var
        has to be kept in agreement with the ambient credentials by hand, and
        when it drifts the pipeline writes documents into a bucket name built
        from one account while every other call in the run — Aurora, Bedrock,
        the KB sync — goes to another. Asking the credentials who they are
        cannot disagree with itself. AWS_ACCOUNT_ID still wins if set, so an
        explicit override remains possible.
        """
        acct = os.environ.get("AWS_ACCOUNT_ID") or _caller_account()
        return f"orgiq-documents-{acct}-{self.region}"

    s3_internal_prefix: str = "synth/internal/"

    # The `knowledge_bases.slug` every corpus doc is attributed to.
    #
    # `documents.kb_registry_slug` is a nullable FK to that registry, and the
    # loader used not to write it at all — so all 157 corpus docs sat with a
    # NULL slug while the row that describes their knowledge base sat beside
    # them, unlinked. Nothing joined the two, which is why a document could be
    # indexed in Bedrock and still look unattached to any knowledge base from
    # the admin surface. The CDK-provisioned KB is the `default` row.
    kb_registry_slug: str = os.environ.get("SYNTH_KB_REGISTRY_SLUG", "default")


CONFIG = SynthConfig()
