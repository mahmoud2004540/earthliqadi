# syntax=docker/dockerfile:1
# API image. Build context: repository root.
ARG NODE_IMAGE=node:22.23.4-alpine3.24

FROM ${NODE_IMAGE} AS base
RUN corepack enable && apk add --no-cache openssl
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/config/package.json packages/config/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter "@platform/api..."
COPY packages/config packages/config
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @platform/config --filter @platform/shared run build \
 && pnpm --filter @platform/api run build \
 && pnpm --filter @platform/api deploy --prod --legacy /out \
 && cd /out && ./node_modules/.bin/prisma generate

FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache openssl tini \
 && addgroup -S app && adduser -S -G app app
ENV NODE_ENV=production
WORKDIR /app
# Application files are owned by root and read-only for the runtime user.
COPY --from=build --chown=root:root /out ./
USER app
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health/live >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
