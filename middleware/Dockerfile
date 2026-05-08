# syntax=docker/dockerfile:1
FROM node:20-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y git openssh-client && rm -rf /var/lib/apt/lists/*
RUN mkdir -p -m 0700 ~/.ssh && ssh-keyscan github.com >> ~/.ssh/known_hosts
COPY package*.json ./
RUN --mount=type=ssh npm install --ignore-scripts

FROM node:20-slim AS development
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY tsconfig.json ./
CMD ["npx", "tsx", "watch", "src/index.ts"]
