FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
# Drop the sibling-repo dep before installing — its file: path escapes the
# Docker build context. Re-injected below from additional_contexts.realtime_modules.
RUN node -e " \
  const fs = require('fs'); \
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')); \
  delete pkg.dependencies['@connorhoehn/realtime-modules']; \
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2)); \
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')); \
  delete lock.packages['node_modules/@connorhoehn/realtime-modules']; \
  delete lock.packages['../../websocket-gateway/realtime-modules']; \
  if (lock.dependencies) delete lock.dependencies['@connorhoehn/realtime-modules']; \
  fs.writeFileSync('package-lock.json', JSON.stringify(lock)); \
"
RUN npm config set strict-ssl false
RUN --mount=type=cache,target=/root/.npm \
    npm install --ignore-scripts

COPY --from=realtime_modules package.json ./node_modules/@connorhoehn/realtime-modules/package.json
COPY --from=realtime_modules dist/ ./node_modules/@connorhoehn/realtime-modules/dist/

FROM node:20-slim AS development
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY seeds ./seeds
COPY tsconfig.json ./
CMD ["npx", "tsx", "watch", "src/index.ts"]

# ── Stage 3: production build ─────────────────────────────────────────────────
FROM node:20-slim AS production

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY seeds ./seeds
COPY tsconfig.json ./

RUN npm run build

EXPOSE 3001
CMD ["node", "dist/index.js"]
