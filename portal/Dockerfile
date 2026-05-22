# ── Stage 1: install deps ──────────────────────────────────────────────────────
# ui-components and realtime-modules are injected from sibling repos via
# additional_contexts so npm never needs SSH, a GitHub token, or a path that
# escapes the Docker build context at install time.
FROM node:20-slim AS deps

WORKDIR /app

COPY package.json ./
# Drop sibling-repo deps before installing — we inject them from the
# additional_contexts below so npm never needs SSH auth, a GitHub token, or
# a file: path that escapes the build context.
RUN node -e " \
  const fs = require('fs'); \
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')); \
  delete pkg.dependencies['@connorhoehnslalom/ui-components']; \
  delete pkg.dependencies['@connorhoehn/realtime-modules']; \
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2)); \
"

RUN npm config set strict-ssl false
RUN --mount=type=cache,target=/root/.npm \
    npm install --legacy-peer-deps

# Inject pre-built dist + package.json from the sibling repos. The contexts
# are passed as additional_contexts.{ui_components,realtime_modules} in
# docker-compose.yml.
COPY --from=ui_components package.json ./node_modules/@connorhoehnslalom/ui-components/package.json
COPY --from=ui_components dist/ ./node_modules/@connorhoehnslalom/ui-components/dist/
COPY --from=realtime_modules package.json ./node_modules/@connorhoehn/realtime-modules/package.json
COPY --from=realtime_modules dist/ ./node_modules/@connorhoehn/realtime-modules/dist/

# ── Stage 2: dev server ────────────────────────────────────────────────────────
FROM node:20-slim AS development

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 5173
CMD ["npx", "vite", "--host", "0.0.0.0"]

# ── Stage 3: production build + preview server ────────────────────────────────
FROM node:20-slim AS production

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

EXPOSE 5173
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "5173"]
