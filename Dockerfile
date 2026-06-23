# Stage 1: build
# Debian/glibc base (NOT alpine/musl): sqlite-vec ships a glibc-linked vec0.so
# prebuilt that needs ld-linux — it cannot load on musl.
FROM node:24-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
COPY frontend/ ./frontend/

RUN npm run build:frontend
RUN npm run build:server

# Stage 2: runtime
FROM node:24-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ wget \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI — the curation step shells out to `claude -p` (auth via
# CLAUDE_CODE_OAUTH_TOKEN env at runtime).
RUN npm install -g @anthropic-ai/claude-code

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data

EXPOSE 8094
CMD ["node", "dist/server/server.js"]
