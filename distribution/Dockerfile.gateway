# Multi-stage Dockerfile for TRAECNclaw.
# Stage 1: install all deps (incl. dev) for running tests / lint in CI.
# Stage 2: lean runtime image with production deps only.

ARG NODE_VERSION=22

# ---- deps stage ----
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` requires package-lock.json; fall back to `npm install` if absent.
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi

# ---- runtime stage ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=8788

# Create a non-root user for runtime.
RUN groupadd --system traecnclaw \
 && useradd --system --gid traecnclaw --home /app --shell /usr/sbin/nologin traecnclaw

# Copy production node_modules from deps stage.
COPY --from=deps --chown=traecnclaw:traecnclaw /app/node_modules ./node_modules
COPY --chown=traecnclaw:traecnclaw package.json ./
COPY --chown=traecnclaw:traecnclaw README.md CHANGELOG.md ./
COPY --chown=traecnclaw:traecnclaw src ./src
COPY --chown=traecnclaw:traecnclaw scripts ./scripts
COPY --chown=traecnclaw:traecnclaw integrations ./integrations
COPY --chown=traecnclaw:traecnclaw mcp-server.js ./
COPY --chown=traecnclaw:traecnclaw start-traecnapi.sh ./

# Re-install without devDependencies to drop playwright/eslint/prettier in the
# slim runtime layer (cheaper, smaller attack surface). Skip if no lockfile.
RUN if [ -f package-lock.json ]; then \
      npm prune --omit=dev; \
    fi

USER traecnclaw

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+ (process.env.PORT||8788) +'/api/status',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))" \
  || exit 1

CMD ["node", "src/server.js"]