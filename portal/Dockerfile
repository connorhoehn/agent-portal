# syntax=docker/dockerfile:1

# ── Stage 1: install deps ──────────────────────────────────────────────────────
# SSH agent is forwarded via --mount=type=ssh so private GitHub deps can be
# cloned without baking credentials into the image.
FROM node:20-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm config set strict-ssl false
RUN mkdir -p -m 0700 ~/.ssh && ssh-keyscan github.com >> ~/.ssh/known_hosts
RUN --mount=type=ssh \
    --mount=type=cache,target=/root/.npm \
    npm install
# Inject pre-built dist AND matching package.json — ui-components has no prepare
# script so npm won't build it. Copying both keeps the exports map in sync with
# what's actually in dist/. Pass the sibling repo as additional_contexts.ui_components.
COPY --from=ui_components package.json ./node_modules/@connorhoehnslalom/ui-components/package.json
COPY --from=ui_components dist/ ./node_modules/@connorhoehnslalom/ui-components/dist/

# ── Stage 2: dev server ────────────────────────────────────────────────────────
FROM node:20-slim AS development

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 5173
CMD ["npx", "vite", "--host", "0.0.0.0"]
