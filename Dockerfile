# syntax=docker/dockerfile:1

# ---------- deps ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- build ----------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time telemetry off only; UNRAID_*/PROMETHEUS_* secrets are runtime-only.
ENV NEXT_TELEMETRY_DISABLED=1
# Build provenance (overridable); baked into the image and exposed via /api/version.
ARG APP_VERSION=0.5.0
ARG GIT_SHA=dev
ARG BUILD_TIME
LABEL org.opencontainers.image.title="unraid-dashboard" \
      org.opencontainers.image.description="Self-hosted Unraid server dashboard (Unraid GraphQL + Prometheus)" \
      org.opencontainers.image.vendor="Cyxno" \
      org.opencontainers.image.source=https://github.com/Cyxno/unraid-dashboard \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version=${APP_VERSION} \
      org.opencontainers.image.revision=${GIT_SHA}
ENV APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA} \
    BUILD_TIME=${BUILD_TIME}
RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine AS runner
WORKDIR /app
# ARGs are per-stage: re-declare so provenance reaches the runtime process.
ARG APP_VERSION=0.5.0
ARG GIT_SHA=dev
ARG BUILD_TIME
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA} \
    BUILD_TIME=${BUILD_TIME}

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs \
    && mkdir -p /app/data \
    && chown nextjs:nodejs /app/data

# /app/data holds the append-only action audit log. Optionally mount a
# narrow host directory for persistence across container recreation:
#   -v /mnt/user/appdata/unraid-dashboard:/app/data

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
