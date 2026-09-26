# conductor

A small CI server. Accepts triggers, schedules jobs, serves the worker
API and hosts the application that drives it. One service, one image.

Source and issues: https://github.com/finwo/conductor

## Tags

| Tag              | What it is                                 |
| ---------------- | ------------------------------------------ |
| `latest`         | the most recent release                    |
| `0.9.0`          | an exact version                           |
| `0.9`            | the latest patch of that minor series      |
| `main`           | the tip of the default branch              |

Built for `linux/amd64`, `linux/arm64` and `linux/riscv64`.

**0.9.0 changed how people sign in.** Workers are unaffected; the protocol
they speak is unchanged.

- The server rendered interface is gone. The image now serves a single page
  application that talks to `/api/v1`, and sessions are bearer tokens
  rather than a cookie. Everyone is signed out once on upgrade.
- `CONDUCTOR_OIDC_CLIENT_SECRET` no longer exists. An OIDC client must be
  reconfigured from confidential to **public**, with PKCE required, the
  conductor's origin in Web Origins, and that origin registered as a
  redirect URI. Leaving it confidential means nobody can sign in.
- `CONDUCTOR_SESSION_TTL` is replaced by `CONDUCTOR_ACCESS_TTL` and
  `CONDUCTOR_REFRESH_TTL`.

**Upgrade the conductor and its workers together.** Two releases have
changed what a worker has to understand:

- **0.5.0** put every API response in an envelope: `{"ok":true,"data":...}`
  on success, `{"ok":false,"error":{"name":...}}` on failure. A worker older
  than 0.5.0 reads the claim response one level too high and will not run
  anything for a 0.5 or newer conductor.
- **0.3.0** made a job one run of a pipeline and a task the unit a worker
  runs. A 0.2.x worker cannot claim from a 0.3 or newer conductor.

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

Tasks need a worker, which is a separate image: see
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
| `CONDUCTOR_PUBLIC_URL`     | Workers get absolute callback URLs built from it, and it is the issuer tokens are signed under. |
| `CONDUCTOR_SESSION_SECRET` | Otherwise every access token stops verifying at restart. |
| `CONDUCTOR_SECRET_KEY`     | Otherwise stored secrets are kept in the clear.   |
| `CONDUCTOR_ADMIN_PASSWORD` | Otherwise one is generated and logged once.       |

Generate the two secrets with `openssl rand -hex 32`.

## Signing in

The image serves the application and a login page for it.

| Variable                        | Default        | What it does                    |
| ------------------------------- | -------------- | ------------------------------- |
| `CONDUCTOR_ACCESS_TTL`          | `900`          | Access token lifetime, seconds. |
| `CONDUCTOR_REFRESH_TTL`         | `2592000`      | Session lifetime, seconds.      |
| `CONDUCTOR_REFRESH_SLIDING`     | `true`         | Measure that from last use rather than from signing in. |
| `CONDUCTOR_LOCAL_REDIRECT_URIS` | `CONDUCTOR_PUBLIC_URL` | Origins the browser may be sent back to, comma separated. |
| `CONDUCTOR_LOCAL_AUTH`          | derived        | Force the built-in login page even with a provider configured. |

`localhost` and `127.0.0.1` are different origins. An unregistered origin
is refused, so list every one in use. `*` allows any, for local testing.

An external provider instead of the built-in page:

```sh
-e CONDUCTOR_OIDC_DISCOVERY_URL=https://idp.example.com/realms/ci/.well-known/openid-configuration \
-e CONDUCTOR_OIDC_CLIENT_ID=conductor \
-e CONDUCTOR_OIDC_ADMIN_ROLE=conductor-admin
```

Register conductor as a **public** client with PKCE. There is no client
secret: the application redeems the code itself and the conductor never
does. Only one provider is ever used, so configuring this turns the
built-in login page off.

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
the last 10 jobs, and logs for 14 days, and a project may override any of
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
- [Authentication](https://github.com/finwo/conductor/blob/main/docs/auth.md)
- [Pipelines](https://github.com/finwo/conductor/blob/main/docs/pipeline.md)
- [Workers](https://github.com/finwo/conductor/blob/main/docs/worker.md)
- [HTTP API](https://github.com/finwo/conductor/blob/main/docs/api.md)
