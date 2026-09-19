# syntax=docker/dockerfile:1

# ── Stage 1: system packages + AWS CLI ────────────────────────────────────────
# This layer is cached indefinitely. Only rebuilds when the base image changes
# or you add/remove apt packages. BuildKit cache mount keeps the apt cache on
# the host so even a rebuild doesn't re-download packages from the internet.
FROM python:3.12-slim AS base

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
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
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
