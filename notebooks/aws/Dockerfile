# syntax=docker/dockerfile:1

# ── Stage 1: system packages + AWS CLI ────────────────────────────────────────
# This layer is cached indefinitely. Only rebuilds when the base image changes
# or you add/remove apt packages. BuildKit cache mount keeps the apt cache on
# the host so even a rebuild doesn't re-download packages from the internet.
# Node comes from the official image stage (digest-pinned), not a curl | bash script.
# Refresh digests: docker buildx imagetools inspect node:22-trixie-slim python:3.12-slim
FROM node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6 AS node

FROM python:3.12-slim@sha256:4840d514c583a4d3d8cad3940e68dee6f0f6f3635c12fcd0a3d74c21a5b93a54 AS base

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        git curl unzip groff less \
    && rm -rf /var/lib/apt/lists/*

RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then \
      curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o awscliv2.zip; \
    else \
      curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip; \
    fi && \
    unzip -q awscliv2.zip && \
    ./aws/install && \
    rm -rf aws awscliv2.zip

# Node 22 + the AgentCore CLI. Powers the devbox interactive-terminal mode
# (notebook 20): `agentcore exec --it` is a bidirectional PTY stream that
# botocore can't speak, so it runs from JupyterLab's Terminal tab instead of a
# notebook cell — which requires the CLI inside this image.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm install -g @aws/agentcore \
    && npm cache clean --force

# ── Stage 2: Python deps ───────────────────────────────────────────────────────
# Rebuilds only when requirements.txt changes. pip cache stays on the host so
# packages aren't re-downloaded on subsequent rebuilds.
FROM base AS runtime

WORKDIR /workspace

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

RUN mkdir -p /root/.jupyter
COPY jupyter_lab_config.py /root/.jupyter/

EXPOSE 8888

ENV JUPYTER_ENABLE_LAB=yes \
    JUPYTER_CONFIG_DIR=/root/.jupyter

CMD ["jupyter", "lab", "--config=/root/.jupyter/jupyter_lab_config.py"]
