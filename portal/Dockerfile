# syntax=docker/dockerfile:1
FROM node:20-slim AS deps

WORKDIR /app
RUN npm install -g npm@latest

ARG GITHUB_TOKEN
RUN printf "@connorhoehn:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n" "${GITHUB_TOKEN}" > .npmrc

COPY package.json ./
RUN npm install && rm -f .npmrc

FROM node:20-slim AS development

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 5173
CMD ["npx", "vite", "--host", "0.0.0.0"]
