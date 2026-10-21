# MAGoCo Router - ModelScope Studio image.
#
# ModelScope Docker studios require the app to listen on 0.0.0.0:7860.
# DATA_DIR must live under /mnt/workspace: that is the persistent volume, so the
# database survives every redeploy.
ARG NODE_IMAGE=node:22-alpine
ARG ALPINE_MIRROR=mirrors.aliyun.com
ARG NPM_REGISTRY=https://registry.npmmirror.com/
ARG APP_VERSION=0.0.1

FROM ${NODE_IMAGE} AS base
ARG ALPINE_MIRROR
WORKDIR /app
RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; fi

FROM base AS builder
ARG NPM_REGISTRY
RUN apk add --no-cache python3 make g++ linux-headers
COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --registry="${NPM_REGISTRY}" --fetch-retries=5 --fetch-timeout=300000 --omit=dev

FROM ${NODE_IMAGE} AS runner
ARG ALPINE_MIRROR
ARG APP_VERSION
WORKDIR /app
RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; fi

LABEL org.opencontainers.image.title="magoco-router" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV NODE_ENV=production
ENV PORT=7860
ENV HOST=0.0.0.0
ENV DATA_DIR=/mnt/workspace/magoco-data
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY web ./web

RUN mkdir -p /mnt/workspace/magoco-data && \
    apk add --no-cache su-exec && \
    printf '#!/bin/sh\nmkdir -p "$DATA_DIR" 2>/dev/null\nchown -R node:node "$DATA_DIR" 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
    chmod +x /entrypoint.sh

EXPOSE 7860
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server/src/index.js"]
