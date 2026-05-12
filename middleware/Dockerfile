# syntax=docker/dockerfile:1
FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm config set strict-ssl false
RUN --mount=type=cache,target=/root/.npm \
    npm install --ignore-scripts

FROM node:20-slim AS development
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY seeds ./seeds
COPY tsconfig.json ./
CMD ["npx", "tsx", "watch", "src/index.ts"]
