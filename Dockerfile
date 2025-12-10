# syntax=docker/dockerfile:1

FROM node:20-bullseye-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-bullseye-slim AS builder
WORKDIR /app
ARG NEXT_PUBLIC_API_URL=https://anclick.id.vn
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bullseye-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001
ARG NEXT_PUBLIC_API_URL=https://anclick.id.vn
ARG PUBLIC_BASE_URL=https://anclick.id.vn
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV PUBLIC_BASE_URL=$PUBLIC_BASE_URL
COPY --from=builder /app ./
RUN npm prune --omit=dev
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential && rm -rf /var/lib/apt/lists/*
RUN mkdir -p music_cache worker_build && \
    if [ ! -f users.json ]; then echo "[]" > users.json; fi
EXPOSE 3001
CMD ["npm","run","start"]
