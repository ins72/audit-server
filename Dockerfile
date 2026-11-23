# the node version for running the app (node:sqlite needs 22.13 or newer)
ARG NODE_VERSION=22-alpine
FROM node:$NODE_VERSION AS base

# Setup pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable
RUN apk add --no-cache git

# Meta
LABEL Description="Web streaming app with own accounts, paywall and operator panel"

RUN mkdir -p /var/www/stremio-web
WORKDIR /var/www/stremio-web

# Setup app
FROM base AS app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml /var/www/stremio-web
RUN pnpm i --frozen-lockfile

COPY . /var/www/stremio-web
RUN pnpm build

# Setup server
FROM base AS server

RUN pnpm i express@4 stripe@23

# Finalize
FROM base

COPY http_server.js /var/www/stremio-web
COPY server /var/www/stremio-web/server
COPY --from=server /var/www/stremio-web/node_modules /var/www/stremio-web/node_modules
COPY --from=app /var/www/stremio-web/build /var/www/stremio-web/build

# Users and billing data live here: mount a persistent volume on /var/www/stremio-web/data
ENV NODE_ENV=production
RUN mkdir -p /var/www/stremio-web/data && chown node:node /var/www/stremio-web/data
VOLUME /var/www/stremio-web/data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD sh -c 'wget -qO- http://127.0.0.1:${PORT:-8080}/healthz' || exit 1
CMD ["node", "http_server.js"]
