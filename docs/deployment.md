Deployment
==========

One service, one image. The conductor accepts triggers, schedules runs,
serves the worker API and renders the interface. Workers are separate and
may live anywhere, including on machines you do not administer.

Quick start
-----------

```sh
docker compose -f deploy/docker-compose.yml up -d
```

That pulls the published images and brings up a conductor on port 8080
with sqlite on a volume, and one worker. The compose file needs a worker token, so the first run is
two steps:

```sh
# Start the conductor on its own.
docker compose -f deploy/docker-compose.yml up -d conductor

# Mint a token, then bring the worker up with it.
docker compose -f deploy/docker-compose.yml exec conductor \
  node src/admin-cli.js token:add compose-worker

CONDUCTOR_WORKER_TOKEN=... docker compose -f deploy/docker-compose.yml up -d worker
```

The administrator password is written to the conductor log once on first
start. Set `CONDUCTOR_ADMIN_PASSWORD` to choose it instead.

To check the whole thing before trusting it with anything:

```sh
deploy/smoke.sh
```

That builds both images, starts them, runs a real pipeline and verifies the
log and artifact came back.

Images
------

| Image                     | Contents                                    |
| ------------------------- | ------------------------------------------- |
| `finwo/conductor`         | the conductor: node, git, the application   |
| `finwo/conductor-worker`  | the worker: node, git, tar, the docker CLI  |

Published for `linux/amd64`, `linux/arm64` and `linux/riscv64`. Tags:
`latest` follows releases, `1.2.3` and `1.2` pin a version, and a twelve
character commit id pins an exact build from main.

Both are built on Alpine rather than the official node image, which is
only published for amd64, arm64 and ppc64le. Alpine 3.23 carries node 24
on every architecture here, and a docker client too, so the worker no
longer fetches a static binary that has no riscv64 build at all.

To build them yourself:

```sh
docker build -f deploy/Dockerfile -t finwo/conductor .
docker build -f deploy/Dockerfile.worker -t finwo/conductor-worker .
```

The worker image installs `yaml` so its configuration file may be YAML; the
worker source itself has no npm dependencies at all.

State
-----

Everything the conductor keeps lives in `/data`:

```
/data/conductor.db   sqlite, unless database.url points elsewhere
/data/mirrors        one bare mirror per project
/data/logs           the live log spool
/data/storage        artifacts and archived logs, unless S3 is configured
```

Mount a volume there. Losing it loses run history, and the mirrors and
spool will be rebuilt.

Configuration
-------------

Every setting has a default and can come from the environment, so the image
needs no config file. See `conductor.example.yaml` for the annotated list.

Worth setting in production:

| Variable                   | Why                                              |
| -------------------------- | ------------------------------------------------ |
| `CONDUCTOR_PUBLIC_URL`     | Workers get absolute callback URLs built from it. |
| `CONDUCTOR_SESSION_SECRET` | Otherwise sessions end at every restart.          |
| `CONDUCTOR_SECRET_KEY`     | Otherwise stored secrets are kept in the clear.   |
| `CONDUCTOR_ADMIN_PASSWORD` | Otherwise one is generated and logged once.       |

Generate the two secrets with `openssl rand -hex 32`.

### Postgres or MySQL

```sh
CONDUCTOR_DATABASE_URL=postgres://conductor:secret@postgres:5432/conductor \
  docker compose --profile postgres -f deploy/docker-compose.yml up -d
```

The schema is created on start. `npm run migrate` applies it separately
when a deployment wants that as its own reviewable step.

### Object storage

```sh
CONDUCTOR_S3_ENDPOINT=http://minio:9000 \
CONDUCTOR_S3_BUCKET=conductor \
CONDUCTOR_S3_ACCESS_KEY_ID=... \
CONDUCTOR_S3_SECRET_ACCESS_KEY=... \
  docker compose --profile s3 -f deploy/docker-compose.yml up -d
```

Artifacts and finished logs then go to the bucket instead of the volume,
and downloads are handed to the store with a presigned redirect rather than
being proxied. The bucket must already exist.

Workers
-------

A worker needs the docker socket, because it runs each job in a container.
Those containers are siblings on the host daemon, not children of the
worker, which has one consequence that catches people out:

**The workspace path must be identical inside and outside the worker
container.** The `-v` flags the worker passes are resolved by the host
daemon, so a path that only exists inside the worker produces an empty
workspace and a job that cannot find its own source. The compose files
mount `/var/lib/conductor/work` at the same path on both sides for exactly
this reason. A named volume will not do.

To contribute capacity to somebody else's conductor, use
`deploy/worker/docker-compose.yml`; see [worker.md](worker.md).

Behind a reverse proxy
----------------------

```
server {
  server_name ci.example.com;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Artifacts can be large, and a build can be quiet for a long time.
    client_max_body_size 0;
    proxy_read_timeout 3600s;
    proxy_request_buffering off;
  }
}
```

`proxy_request_buffering off` matters: with it on, nginx spools an entire
artifact to its own disk before the conductor sees a byte, which for
multi gigabyte build output is both slow and surprising.

Set `CONDUCTOR_PUBLIC_URL=https://ci.example.com` to match, or workers will
be handed callback URLs that do not work.

Backups
-------

With sqlite and local storage, the `/data` volume is the whole system. With
postgres and S3, back up the database and the bucket; the mirrors and the
log spool are caches and rebuild themselves.

Secrets are encrypted with `CONDUCTOR_SECRET_KEY`. A backup restored
without that key leaves trigger secrets and project variables unreadable,
so keep it somewhere other than next to the backup.

Upgrading
---------

Migrations run on start and are forward only. They are recorded with a
checksum, so an edited migration is refused rather than applied twice.
Take a backup first: there is no automatic downgrade.

```sh
docker compose -f deploy/docker-compose.yml pull
docker compose -f deploy/docker-compose.yml up -d
```

Pin a version rather than tracking `latest` if an unattended restart
picking up a new release would be unwelcome:

```sh
CONDUCTOR_IMAGE=finwo/conductor:1.2.3 \
CONDUCTOR_WORKER_IMAGE=finwo/conductor-worker:1.2.3 \
  docker compose -f deploy/docker-compose.yml up -d
```

Workers can be upgraded independently and in any order. The worker API is
the boundary between them, and a worker that goes away mid-job has that job
requeued after `scheduler.heartbeat_timeout`.

Publishing
----------

The images are built and pushed by the project's own pipeline, from
`deploy/publish.sh`. It runs only on `main` and on `v*` tags, enforced by
an `only:` rule in `.conductor.yml` rather than by a check inside the
script, so a branch build cannot move `latest` even by accident.

| Ref                | Tags pushed                          |
| ------------------ | ------------------------------------ |
| `refs/heads/main`  | `latest`, `<short sha>`              |
| `refs/tags/v1.2.3` | `1.2.3`, `1.2`, `latest`             |

A tag that is not a plain version, `v1.2.3-rc1` for instance, is refused
rather than guessed at.

Pushing needs `REGISTRY_USERNAME` and `REGISTRY_TOKEN` as project
variables. They are masked in job logs, and passed to `docker login` on
standard input rather than on the command line so they stay out of the
process list. The job logs out again on the way out, whether or not it
succeeded, so nothing is left behind on a shared worker.

The foreign architectures are emulated with QEMU, registered per run with
`tonistiigi/binfmt`. Giving the pool a worker of that architecture makes
it native instead, since a worker declares its own architectures when it
polls.

Emulation needs `binfmt_misc` mounted on the host running the docker
daemon, which is not the default everywhere:

```sh
sudo mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc
```

Without it the registration step still reports success, because the
handlers are written into the container's own mount namespace and go away
with it. The build then fails much later with `exec format error`.
`publish.sh` checks that the builder really offers every platform before
building anything, and says this if it does not.

To see what a release would push without pushing it:

```sh
CONDUCTOR_REF=refs/tags/v1.2.3 CONDUCTOR_SHA=$(git rev-parse HEAD) \
  DRY_RUN=1 deploy/publish.sh
```
