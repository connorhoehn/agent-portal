# syntax=docker/dockerfile:1

# ── Stage 1: install deps ──────────────────────────────────────────────────────
# npm cache stays on the host so packages aren't re-downloaded on rebuild.
# GITHUB_TOKEN is consumed here and NOT baked into the image (npmrc is deleted).
FROM node:20-slim AS deps

WORKDIR /app

ARG GITHUB_TOKEN
RUN printf "@connorhoehn:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n" "${GITHUB_TOKEN}" > .npmrc

COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install && rm -f .npmrc

# ── Stage 2: dev server ────────────────────────────────────────────────────────
FROM node:20-slim AS development

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 5173
CMD ["npx", "vite", "--host", "0.0.0.0"]
