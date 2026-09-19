# conductor

A small CI server. Accepts triggers, schedules runs, serves the worker
API and renders the interface. One service, one image.

Source and issues: https://github.com/finwo/conductor

## Tags

| Tag              | What it is                                 |
| ---------------- | ------------------------------------------ |
| `latest`         | the most recent release                    |
| `0.1.0`          | an exact version                           |
| `0.1`            | the latest patch of that minor series      |
| `<commit>`       | an exact build from main, twelve hex chars |

Built for `linux/amd64`, `linux/arm64` and `linux/riscv64`.

## Quick start

```sh
docker run -d \
  --name conductor \
  -p 8080:8080 \
  -v conductor-data:/data \
  -e CONDUCTOR_PUBLIC_URL=http://localhost:8080 \
  finwo/conductor
```

The administrator password is printed once in the log on first start.
Set `CONDUCTOR_ADMIN_PASSWORD` to choose it instead.

Jobs need a worker, which is a separate image: see
[finwo/conductor-worker](https://hub.docker.com/r/finwo/conductor-worker).
A compose file running both is in the repository under `deploy/`.

## State

Everything lives in `/data`, so mount a volume there:

```
/data/conductor.db   sqlite, unless a database url is configured
/data/mirrors        one bare git mirror per project
/data/logs           the live log spool
/data/storage        artifacts and archived logs, unless S3 is configured
```

## Configuration

Every setting has a default and can come from the environment, so no
configuration file is needed. Worth setting in production:

| Variable                   | Why                                              |
| -------------------------- | ------------------------------------------------ |
| `CONDUCTOR_PUBLIC_URL`     | Workers get absolute callback URLs built from it. |
| `CONDUCTOR_SESSION_SECRET` | Otherwise sessions end at every restart.          |
| `CONDUCTOR_SECRET_KEY`     | Otherwise stored secrets are kept in the clear.   |
| `CONDUCTOR_ADMIN_PASSWORD` | Otherwise one is generated and logged once.       |

Generate the two secrets with `openssl rand -hex 32`.

Postgres or MySQL instead of sqlite:

```sh
-e CONDUCTOR_DATABASE_URL=postgres://conductor:secret@postgres:5432/conductor
```

S3 compatible storage instead of the volume:

```sh
-e CONDUCTOR_S3_ENDPOINT=http://minio:9000 \
-e CONDUCTOR_S3_BUCKET=conductor \
-e CONDUCTOR_S3_ACCESS_KEY_ID=... \
-e CONDUCTOR_S3_SECRET_ACCESS_KEY=...
```

Artifacts and finished logs then go to the bucket, and downloads are
handed over with a presigned redirect rather than proxied.

## Retention

Build output is deleted on a schedule, or a busy server fills its disk
with logs nobody will read. The defaults keep artifacts for 30 days or
the last 10 runs, and logs for 14 days, and a project may override any of
it. Upgrading an installation that has been running for a while will
delete a lot on the first sweep, so set these before starting if that
matters:

```sh
-e CONDUCTOR_RETENTION_ARTIFACT_DAYS=0 \
-e CONDUCTOR_RETENTION_LOG_DAYS=0
```

Zero means keep forever.

## Documentation

- [Deployment](https://github.com/finwo/conductor/blob/main/docs/deployment.md)
- [Pipelines](https://github.com/finwo/conductor/blob/main/docs/pipeline.md)
- [Workers](https://github.com/finwo/conductor/blob/main/docs/worker.md)
- [HTTP API](https://github.com/finwo/conductor/blob/main/docs/api.md)
