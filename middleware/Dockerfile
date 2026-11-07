# Library artifacts are exported from the exact committed Git pins, then the
# existing lockfile graph is installed without running dependency lifecycle hooks.
FROM node:22-slim AS deps
WORKDIR /app
COPY package*.json ./
# Tracked tarballs the lockfile resolves inside the project (`file:vendor/…`).
COPY vendor ./vendor
COPY --from=locked_libraries / /vendor/
RUN node /vendor/install-locked.mjs
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --legacy-peer-deps

FROM node:22-slim AS development
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY seeds ./seeds
COPY tsconfig.json ./
CMD ["npx", "tsx", "watch", "src/index.ts"]

# ── Stage 3: production build ─────────────────────────────────────────────────
FROM node:22-slim AS production

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# package.json is required here even though deps are already installed: it is
# where the `build` script lives, and without it `npm run build` fails with
# ENOENT on /app/package.json. This stage could not build before — compose only
# ever exercised the development target, so it went unnoticed.
COPY package*.json ./
COPY src ./src
COPY seeds ./seeds
COPY tsconfig.json ./

RUN npm run build

# Run unprivileged. The service writes nothing under /app (only os.tmpdir() in
# mock code), so ownership is for tools that expect to own their cwd; the
# entrypoint is plain `node dist/index.js` on port 3001 (> 1024).
RUN chown -R node:node /app
USER node

EXPOSE 3001
CMD ["node", "dist/index.js"]
