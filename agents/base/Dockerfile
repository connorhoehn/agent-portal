# syntax=docker/dockerfile:1.7
#
# orgiq-agent-base — shared common deps for all OrgIQ Strands agents.
#
# Built once via `agents/base/build.sh`, pushed to ECR repo `orgiq-agent-base`.
# All 6 agent Dockerfiles extend this; per-agent rebuilds become a single COPY
# layer (sub-10-second rebuilds when only main.py changes).
#
# Rebuild this base image only when common deps in the install block change.

FROM --platform=linux/arm64 python:3.12-slim@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS deps

# uv is much faster than pip for resolution + install.
RUN pip install --no-cache-dir uv

# Install every dep all 6 agents share. Versions match the highest constraint
# across all pyproject.toml files. bedrock-agentcore[a2a,ag-ui] is the superset
# extras set — supervisor needs a2a, all others need ag-ui.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system --no-cache \
      "strands-agents==1.64.0" \
      "strands-agents-builder==0.1.10" \
      "bedrock-agentcore[a2a,ag-ui]==1.25.4" \
      "ag-ui-protocol==1.0.0" \
      "ag-ui-strands==1.0.2" \
      # ADOT distro (not vanilla opentelemetry-distro): AgentCore Runtime
      # injects OTEL_PYTHON_CONFIGURATOR=aws_configurator, which only exists
      # in aws-opentelemetry-distro. With the vanilla distro no configurator
      # loads at all and no spans are ever exported (aws/spans stays empty).
      "aws-opentelemetry-distro==0.22.0" \
      "opentelemetry-instrumentation==0.66b1" \
      "opentelemetry-exporter-otlp==1.45.1" \
      # OpenInference instrumentation — translates Strands/Bedrock spans to OI format
      "openinference-instrumentation-bedrock==0.1.63" \
      "openinference-instrumentation-strands-agents==0.1.15" \
      "openinference-semantic-conventions==0.1.43" \
      "openinference-instrumentation==0.1.75" \
      "websocket-client==1.9.2"

# ── Runtime image ─────────────────────────────────────────────────────────────

FROM --platform=linux/arm64 python:3.12-slim@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54

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
