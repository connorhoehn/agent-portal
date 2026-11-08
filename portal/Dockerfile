# Library artifacts are exported from the exact committed Git pins, then the
# existing lockfile graph is installed without running dependency lifecycle hooks.
FROM node:22-slim AS deps
WORKDIR /app
COPY package*.json ./
COPY --from=locked_libraries / /vendor/
RUN node /vendor/install-locked.mjs
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --legacy-peer-deps

FROM node:22-slim AS development

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 5173
CMD ["npx", "vite", "--host", "0.0.0.0"]

# ── Stage 3: production build + preview server ────────────────────────────────
FROM node:22-slim AS production

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

ENV NODE_ENV=production
EXPOSE 5173
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "5173"]
