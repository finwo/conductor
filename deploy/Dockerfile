# deploy/Dockerfile - the conductor
#
# Build from the repository root, since the context is the whole project:
#   docker build -f deploy/Dockerfile -t conductor .
#
# State lives in /data: the sqlite database, the git mirrors, the log spool
# and, unless object storage is configured, artifacts. Mount a volume there
# or none of it survives a restart.

FROM node:24-bookworm-slim

# git is needed for the mirrors the conductor reads pipelines and source
# archives out of. Everything else it does is in node.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so editing source does not reinstall them. mysql2 and
# pg are optional and only pulled when the database calls for them; both are
# installed here so one image covers every backend.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY src/ ./src/
COPY migrations/ ./migrations/
COPY assets/ ./assets/

# Paths point into the volume rather than at the defaults, which are
# relative to the working directory.
ENV NODE_ENV=production \
    CONDUCTOR_HOST=0.0.0.0 \
    CONDUCTOR_PORT=8080 \
    CONDUCTOR_DATABASE_PATH=/data/conductor.db \
    CONDUCTOR_STORAGE_PATH=/data/storage \
    CONDUCTOR_MIRROR_PATH=/data/mirrors \
    CONDUCTOR_LOG_PATH=/data/logs

RUN mkdir -p /data && chown -R node:node /data

USER node
VOLUME ["/data"]
EXPOSE 8080

# No curl in the image, so the check is made with node itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.CONDUCTOR_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/conductor/index.js"]
