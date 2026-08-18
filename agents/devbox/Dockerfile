# syntax=docker/dockerfile:1.7
#
# orgiq-devbox — Claude Code inside an AgentCore Runtime microVM.
#
# Unlike the 9 OrgIQ Strands agents this image does NOT extend orgiq-agent-base:
# it needs Node.js + the Claude Code CLI and none of the Strands/AG-UI stack.
# Built + pushed via agents/devbox/build.sh (NOT part of agents/build-all.sh).
#
# The wrapper (main.py) satisfies the AgentCore Runtime contract and shells out
# to `claude -p` headless mode. Model access is Bedrock-only: the execution
# role's credentials + CLAUDE_CODE_USE_BEDROCK=1 — no Anthropic API key exists
# anywhere in this image or its environment.

FROM --platform=linux/arm64 python:3.12-slim

# System deps: git (workspace VCS), ripgrep (Claude Code's search backend),
# curl/ca-certificates (NodeSource install + general use), procps (ps for
# subprocess management inside the microVM).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates ripgrep procps \
    && rm -rf /var/lib/apt/lists/*

# Node 20 (NodeSource) + Claude Code CLI. Global npm installs land in
# /usr/lib/node_modules with world-readable bin links — usable by UID 1000.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code \
    && npm cache clean --force

# Python deps for the runtime-contract wrapper. No Strands/AG-UI — the "agent"
# here is Claude Code itself; bedrock-agentcore only provides the HTTP contract.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir \
      "bedrock-agentcore>=1.9" \
      # ADOT distro — AgentCore injects OTEL_PYTHON_CONFIGURATOR=aws_configurator,
      # which only aws-opentelemetry-distro provides (vanilla distro exports nothing).
      "aws-opentelemetry-distro>=0.12.1" \
      "opentelemetry-instrumentation" \
      "opentelemetry-exporter-otlp"

# Non-root user required by AgentCore Runtime contract. UID 1000 also matches
# what BYO filesystem access points would expect if ever attached.
RUN useradd -m -u 1000 bedrock_agentcore

WORKDIR /app
COPY --chown=bedrock_agentcore:bedrock_agentcore main.py /app/

# Claude Code environment. ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL are
# injected by the OrgIQ-Devbox CDK stack (overridable via context) — the values
# here are only local-dev fallbacks. DISABLE_AUTOUPDATER: the image is
# immutable; self-update inside a microVM is wasted work and version drift.
ENV CLAUDE_CODE_USE_BEDROCK=1 \
    DISABLE_AUTOUPDATER=1 \
    ANTHROPIC_MODEL=us.anthropic.claude-sonnet-5 \
    ANTHROPIC_SMALL_FAST_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0

# Runtime contract: exact CMD form, ports, /ping healthcheck.
CMD ["opentelemetry-instrument", "python", "-m", "main"]

EXPOSE 8080 8000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/ping')"

USER bedrock_agentcore
