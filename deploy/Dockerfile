# deploy/Dockerfile - the conductor
#
# Build from the repository root, since the context is the whole project:
#   docker build -f deploy/Dockerfile -t finwo/conductor .
#
# Alpine rather than the official node image, because that one is only
# published for amd64, arm64 and ppc64le, and this is meant to run on
# riscv64 as well. Alpine 3.23 carries node 24 on every architecture we
# publish for, so the base is the same everywhere and nothing has to be
# fetched from a second source at build time.
#
# State lives in /data: the sqlite database, the git mirrors, the log spool
# and, unless object storage is configured, artifacts. Mount a volume there
# or none of it survives a restart.

ARG ALPINE_VERSION=3.23

# npm is only needed to resolve dependencies, so it stays in this stage and
# out of the image that ships.
FROM alpine:${ALPINE_VERSION} AS deps

RUN apk add --no-cache nodejs npm

WORKDIR /app

# Dependencies before source, so editing code does not reinstall them.
# mysql2 and pg are optional and pure javascript; both are installed so a
# single image covers every database backend.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# The bundle is the same bytes on every architecture, so it is built once on
# whatever is doing the building. esbuild has no riscv64 release, and
# emulating one to produce an identical file would be slow for nothing.
FROM --platform=$BUILDPLATFORM alpine:${ALPINE_VERSION} AS web

RUN apk add --no-cache nodejs npm

WORKDIR /app

# The dev dependencies the deps stage deliberately skipped.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY web/ ./web/
RUN node web/build.cjs

FROM alpine:${ALPINE_VERSION}

# git is needed for the mirrors the conductor reads pipelines and source
# archives out of. Everything else it does is node, and node's sqlite is
# built in, so there is no database client to install.
RUN apk add --no-cache ca-certificates git nodejs

# Fixed uid/gid so a mounted volume keeps working across rebuilds and
# hosts, where an automatic id would drift.
RUN addgroup -S -g 1000 conductor \
    && adduser -S -u 1000 -G conductor -h /app conductor

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY --from=web /app/web/dist ./web/dist

# Paths point into the volume rather than at the defaults, which are
# relative to the working directory.
ENV NODE_ENV=production \
    CONDUCTOR_HOST=0.0.0.0 \
    CONDUCTOR_PORT=8080 \
    CONDUCTOR_DATABASE_PATH=/data/conductor.db \
    CONDUCTOR_STORAGE_PATH=/data/storage \
    CONDUCTOR_MIRROR_PATH=/data/mirrors \
    CONDUCTOR_LOG_PATH=/data/logs

RUN mkdir -p /data && chown -R conductor:conductor /data

USER conductor
VOLUME ["/data"]
EXPOSE 8080

# No curl in the image, so the check is made with node itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.CONDUCTOR_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/conductor/index.js"]
