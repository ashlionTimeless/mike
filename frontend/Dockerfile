# syntax=docker/dockerfile:1.4

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS build
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/app/node_modules,sharing=locked,id=mike-frontend-nm \
    npm ci

COPY . .

# NEXT_PUBLIC_* variables are read during `next build`. Use .env when present,
# otherwise fall back to committed env.docker (used by scaffoldbench compose).
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/app/node_modules,sharing=locked,id=mike-frontend-nm \
    if [ -f .env ]; then cp .env .env.build; elif [ -f env.docker ]; then cp env.docker .env.build; else echo "frontend/.env or env.docker is required." >&2 && exit 1; fi \
    && mv .env.build .env \
    && npm run build

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs

WORKDIR /app

COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
