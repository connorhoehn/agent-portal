# syntax=docker/dockerfile:1

# ── Stage 1: system packages + gcloud CLI ─────────────────────────────────────
# Cached layer — only rebuilds when base image or apt packages change.
FROM python:3.12-slim AS base

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        git curl gnupg lsb-release apt-transport-https ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install gcloud CLI from Google's apt repo. Pinning to the package channel is
# fine here — the SDK is back-compat for years.
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        google-cloud-cli \
    && rm -rf /var/lib/apt/lists/*

# ── Stage 2: Python deps ───────────────────────────────────────────────────────
# Rebuilds only when requirements.txt changes. pip cache mounted from host so
# subsequent rebuilds don't re-download packages.
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
