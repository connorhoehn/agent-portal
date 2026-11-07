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

# Node comes from the official image stage (digest-pinned) instead of a
# curl | bash NodeSource script. Refresh: docker buildx imagetools inspect node:20-trixie-slim
FROM --platform=linux/arm64 node:20-trixie-slim@sha256:abfbe12cc943141a0c9e8c0a57d710df1dadd95d35e8662cc02958b284d1f35b AS node

# Refresh: docker buildx imagetools inspect python:3.12-slim
FROM --platform=linux/arm64 python:3.12-slim@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54

# System deps: git (workspace VCS), ripgrep (Claude Code's search backend),
# curl/ca-certificates (general use), procps (ps for
# subprocess management inside the microVM).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates ripgrep procps \
    && rm -rf /var/lib/apt/lists/*

# Node 20 (copied from the pinned node stage) + Claude Code CLI, pinned to the
# version in use on the build machine. Global npm installs land in
# /usr/local/lib/node_modules with bin links in /usr/local/bin, world-readable
# and usable by UID 1000.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm install -g @anthropic-ai/claude-code@2.1.319 \
    && npm cache clean --force

# Python deps for the runtime-contract wrapper. No Strands/AG-UI — the "agent"
# here is Claude Code itself; bedrock-agentcore only provides the HTTP contract.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir \
      "bedrock-agentcore==1.25.4" \
      # ADOT distro — AgentCore injects OTEL_PYTHON_CONFIGURATOR=aws_configurator,
      # which only aws-opentelemetry-distro provides (vanilla distro exports nothing).
      "aws-opentelemetry-distro==0.22.0" \
      "opentelemetry-instrumentation==0.66b1" \
      "opentelemetry-exporter-otlp==1.45.1"

# Non-root user required by AgentCore Runtime contract. UID 1000 also matches
# what BYO filesystem access points would expect if ever attached.
RUN useradd -m -u 1000 bedrock_agentcore

WORKDIR /app
COPY --chown=bedrock_agentcore:bedrock_agentcore main.py /app/

# The lab loop: `lab` (signal | remember | recall | consult) is how a session
# reaches the platform surfaces that outlive it, and the managed SessionStart
# hook injects the fleet's memory for the repo into every new session. Both
# are inert until the runtime sets LAB_API_BASE (the CLI soft-exits without
# it), so local `agentcore dev` behaves exactly as before.
COPY lab /usr/local/bin/lab
COPY managed-settings.json /etc/claude-code/managed-settings.json
RUN chmod 755 /usr/local/bin/lab

# Claude Code environment. ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL are
# injected by the OrgIQ-Devbox CDK stack (overridable via context) — the values
# here are only local-dev fallbacks. DISABLE_AUTOUPDATER: the image is
# immutable; self-update inside a microVM is wasted work and version drift.
ENV CLAUDE_CODE_USE_BEDROCK=1 \
    DISABLE_AUTOUPDATER=1 \
    ANTHROPIC_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0 \
    ANTHROPIC_SMALL_FAST_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0 \
    DEVBOX_ALLOWED_MODELS=us.anthropic.claude-haiku-4-5-20251001-v1:0,us.anthropic.claude-sonnet-5,us.anthropic.claude-opus-4-8

# Runtime contract: exact CMD form, ports, /ping healthcheck.
CMD ["opentelemetry-instrument", "python", "-m", "main"]

EXPOSE 8080 8000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/ping')"

USER bedrock_agentcore
