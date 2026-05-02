FROM node:20-slim AS deps
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM node:20-slim AS builder
WORKDIR /app
COPY . .
COPY --from=deps /app/node_modules ./node_modules
RUN yarn build

# Node 18 uses OpenSSL 1.1.1 which supports TLS 1.0 needed by iLO4
FROM node:18-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-client sshpass ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

ARG APP_ENV=production
ARG NODE_ENV=production
ARG PORT=3000

ENV APP_ENV=${APP_ENV} \
    NODE_ENV=${NODE_ENV} \
    PORT=${PORT} \
    NODE_TLS_REJECT_UNAUTHORIZED=0

RUN addgroup --gid 1001 nodejs
RUN adduser --disabled-password --gecos "" --uid 1001 --ingroup nodejs nextjs

RUN mkdir -p /app/.next/cache/images && chown nextjs:nodejs /app/.next/cache/images
VOLUME /app/.next/cache/images

COPY --from=builder /app/next.config.js ./
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

USER nextjs

EXPOSE ${PORT}

CMD ["yarn", "start"]
