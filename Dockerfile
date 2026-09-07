# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Multi-stage build for the Next.js 14 app (standalone output).
#   deps    — install ALL deps (dev deps are needed for the build)
#   builder — next build -> .next/standalone
#   runner  — minimal runtime, non-root, HOSTNAME=0.0.0.0, healthcheck
# ---------------------------------------------------------------------------

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# PUBLIC API base (API Gateway URL) inlined into the client bundle by Next.js.
# Pass via `docker build --build-arg NEXT_PUBLIC_API_BASE_URL=https://...` so
# lib/api.ts routes every browser call to the deployed backend. Blank keeps
# the image in local mode. This is a PUBLIC URL — never put secrets here.
ARG NEXT_PUBLIC_API_BASE_URL=""
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    # CRITICAL: without this the standalone server binds only the container's
    # eth0 IP, and any localhost/127.0.0.1 healthcheck gets refused.
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]