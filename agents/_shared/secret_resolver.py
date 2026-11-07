"""Resolve a secret by Secrets Manager NAME, with a plaintext escape hatch.

The infra stacks no longer put callback or lab secret values in the runtime
environment. They set ``<VAR>_ID`` to the secret's name and grant
GetSecretValue on exactly that secret (infra/SECURITY-NOTES.md). This helper
is the agent half.

Order for ``resolve_secret("APPROVALS_REQUEST_SECRET")``:

1. ``APPROVALS_REQUEST_SECRET_ID`` set -> GetSecretValue by that name, once
   per process (cached). A failure raises ``SecretResolutionError`` naming the
   variable and the secret, unless the plaintext fallback below applies.
2. ``PLAINTEXT_CALLBACK_SECRETS=1`` and ``APPROVALS_REQUEST_SECRET`` set ->
   that value (the one-release rollout fallback, and also the answer if the
   secret lookup failed).
3. Neither ``_ID`` nor the flag -> ``""``. Plain env values without the flag
   are ignored once an ``_ID`` exists; with no ``_ID`` at all (local dev,
   docker-compose) the plain variable is still honoured, as before.

Whitespace is stripped (a trailing newline is not a legal header value).
boto3 is imported lazily so hosts without it can import this module.
"""

from __future__ import annotations

import logging
import os
import threading

log = logging.getLogger(__name__)

PLAINTEXT_FLAG = "PLAINTEXT_CALLBACK_SECRETS"

_CACHE: dict[str, str] = {}
_LOCK = threading.Lock()


class SecretResolutionError(RuntimeError):
    """A secret named by ``<VAR>_ID`` could not be read and no fallback applies."""


def _plaintext_allowed() -> bool:
    return (os.environ.get(PLAINTEXT_FLAG) or "").strip() == "1"


def _fetch(secret_id: str) -> str:
    import boto3  # lazy: agent images have it, a bare dev host may not

    client = boto3.client("secretsmanager")
    resp = client.get_secret_value(SecretId=secret_id)
    value = resp.get("SecretString")
    if value is None:
        raise ValueError("secret has no SecretString")
    return value.strip()


def resolve_secret(var: str) -> str:
    """The value for ``var`` (see module docstring); ``""`` when unconfigured."""
    plaintext = (os.environ.get(var) or "").strip()
    secret_id = (os.environ.get(var + "_ID") or "").strip()

    if not secret_id:
        # No named secret configured: local dev / legacy deploy.
        return plaintext

    with _LOCK:
        if secret_id in _CACHE:
            return _CACHE[secret_id]
        try:
            value = _fetch(secret_id)
            if not value:
                raise ValueError("secret value is empty")
        except Exception as exc:  # noqa: BLE001 — re-raised with a clear message below
            if _plaintext_allowed() and plaintext:
                log.warning("secrets: could not read %s (%s: %s); using plaintext %s because %s=1",
                            secret_id, type(exc).__name__, exc, var, PLAINTEXT_FLAG)
                return plaintext
            raise SecretResolutionError(
                f"{var}_ID names secret {secret_id!r} but it could not be read "
                f"({type(exc).__name__}: {exc}). Check the runtime role's "
                f"secretsmanager:GetSecretValue grant and the secret name, or set "
                f"{PLAINTEXT_FLAG}=1 with {var} as a temporary fallback."
            ) from exc
        _CACHE[secret_id] = value
        return value


def reset_cache() -> None:
    """Test hook."""
    with _LOCK:
        _CACHE.clear()
