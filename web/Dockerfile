# syntax=docker/dockerfile:1
#
# Multi-stage build for the ForgeOS Next.js 16 / Prisma 7 app.
#
# Prisma 7's "prisma-client" generator (see prisma/schema.prisma) is
# engine-less at runtime -- the driver adapter (@prisma/adapter-pg) talks
# to Postgres over plain `pg`, not a native query-engine binary -- so
# there's no need for the openssl/libssl packages classic Prisma images
# required. Alpine works fine.
#
# The generated client lives at src/generated/prisma (schema.prisma's
# custom `output` path), outside node_modules. Next's standalone-output
# file tracer does not follow that path, so it's copied explicitly in the
# runner stage below -- confirmed by inspecting .next/standalone/ after a
# local build, which was missing it entirely.

FROM node:24-alpine AS base

# ---------- deps: install dependencies only (cached across builds) ----------
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- builder: generate the Prisma client, then build Next.js ----------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# ---------- runner: minimal production image ----------
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/src/generated/prisma ./src/generated/prisma
COPY --from=builder /app/prisma ./prisma

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
