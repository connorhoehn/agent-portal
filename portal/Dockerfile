# syntax=docker/dockerfile:1

# ── Stage 1: install deps ──────────────────────────────────────────────────────
# ui-components is injected from the sibling repo via additional_contexts so npm
# never needs SSH or a GitHub token at build time.
FROM node:20-slim AS deps

WORKDIR /app

COPY package.json ./
# Drop the github: dep before installing — we inject it from the sibling repo
# context below so npm never needs SSH auth or a GitHub token.
RUN node -e " \
  const fs = require('fs'); \
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')); \
  delete pkg.dependencies['@connorhoehnslalom/ui-components']; \
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2)); \
"

RUN npm config set strict-ssl false
RUN --mount=type=cache,target=/root/.npm \
    npm install --legacy-peer-deps

# Inject pre-built dist + package.json from the sibling ui-components repo.
# Pass the repo as additional_contexts.ui_components in docker-compose.yml.
COPY --from=ui_components package.json ./node_modules/@connorhoehnslalom/ui-components/package.json
COPY --from=ui_components dist/ ./node_modules/@connorhoehnslalom/ui-components/dist/

# ── Stage 2: dev server ────────────────────────────────────────────────────────
FROM node:20-slim AS development

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 5173
CMD ["npx", "vite", "--host", "0.0.0.0"]
