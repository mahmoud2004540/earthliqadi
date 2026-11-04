# syntax=docker/dockerfile:1
# Isolated operator signer (ADR-0015). Build context: repository root.
# Runs on its own host/network segment in production; only the API may reach it.
ARG NODE_IMAGE=node:22.23.4-alpine3.24

FROM ${NODE_IMAGE} AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/signer/package.json apps/signer/
RUN pnpm install --frozen-lockfile --filter "@platform/signer..."
COPY apps/signer apps/signer
RUN pnpm --filter @platform/signer run build \
 && pnpm --filter @platform/signer deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache tini \
 && addgroup -S signer && adduser -S -G signer signer \
 && mkdir /data && chown signer:signer /data
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /out ./
USER signer
# The audit log (and the daily-limit state rebuilt from it) lives here.
VOLUME ["/data"]
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4100/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
