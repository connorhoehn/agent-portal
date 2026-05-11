# syntax=docker/dockerfile:1.7
#
# orgiq-agent-base — shared common deps for all OrgIQ Strands agents.
#
# Built once via `agents/base/build.sh`, pushed to ECR repo `orgiq-agent-base`.
# All 6 agent Dockerfiles extend this; per-agent rebuilds become a single COPY
# layer (sub-10-second rebuilds when only main.py changes).
#
# Rebuild this base image only when common deps in the install block change.

FROM --platform=linux/arm64 python:3.12-slim AS deps

# uv is much faster than pip for resolution + install.
RUN pip install --no-cache-dir uv

# Install every dep all 6 agents share. Versions match the highest constraint
# across all pyproject.toml files. bedrock-agentcore[a2a,ag-ui] is the superset
# extras set — supervisor needs a2a, all others need ag-ui.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system --no-cache \
      "strands-agents>=1.39" \
      "strands-agents-builder>=0.1" \
      "bedrock-agentcore[a2a,ag-ui]>=1.9" \
      "ag-ui-protocol>=0.1.18" \
      "ag-ui-strands>=0.1.8" \
      "opentelemetry-distro" \
      "opentelemetry-instrumentation" \
      "opentelemetry-exporter-otlp" \
      "websocket-client>=1.8"

# ── Runtime image ─────────────────────────────────────────────────────────────

FROM --platform=linux/arm64 python:3.12-slim

# Non-root user required by AgentCore Runtime contract.
RUN useradd -m -u 1000 bedrock_agentcore

# Pull only the installed Python packages + console scripts from the deps stage.
COPY --from=deps /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=deps /usr/local/bin /usr/local/bin

WORKDIR /app
RUN chown bedrock_agentcore:bedrock_agentcore /app

# Default CMD — agent images don't need to override unless their entrypoint module
# isn't `main`. The runtime contract requires this exact form.
CMD ["opentelemetry-instrument", "python", "-m", "main"]

EXPOSE 8080 8000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/ping')"

USER bedrock_agentcore
