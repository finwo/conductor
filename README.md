conductor
=========

A stand-alone CI system. Pipelines live in the repository, jobs run in
containers, and workers pull work rather than being pushed to.

Summary
-------

The conductor accepts a push notification, reads `.conductor.yml` at the
pushed commit, and turns it into a graph of jobs. Workers poll for work,
advertising the architectures and features they can offer. Any job whose
dependencies have succeeded is eligible, so a wide graph runs wide.

Workers need no repository credentials: the conductor serves the source tree
for the exact commit a job was handed. A worker on someone else's hardware
can therefore build for you without being able to read anything else.

Nothing has to be set up before it will run. With no configuration it uses
sqlite on disk, stores artifacts on the local filesystem, and manages its own
user accounts. Point it at a database url, an S3 bucket or an OIDC issuer and
it uses those instead.

Status
------

Under construction. Working today:

  - configuration, with sqlite, mysql/tidb and postgres backends
  - local and S3 compatible object storage
  - pipeline parsing, matrix and architecture expansion, dependency graphs
  - triggers, run scheduling, the worker API, live logs, artifacts, reaping
  - the worker: containerised jobs, services, features, caches, cleanup
  - accounts, OIDC, the admin API, and project variables
  - the read-api and the dashboard

Not yet built: container images and deployment manifests.

Installation
------------

Requires node 24 or newer. No native modules.

```sh
npm install
cp conductor.example.yaml conductor.yaml
npm start
```

On first start an administrator account is created and its generated
password written to the log once. The dashboard is on the same port.

Run the public read surface separately when the write surface should not be
exposed:

```sh
npm run read-api
```

It serves the dashboard and the read API only. The trigger, worker and admin
routes are not registered on it at all, so no credential can reach them.

`mysql2` and `pg` are optional and only needed when `database.url` points at
one of those servers.

Configuration
-------------

Every setting has a default, so an empty config file is valid. Values are
read from defaults, then `conductor.yaml`, then the environment. See
`conductor.example.yaml` for the annotated list.

Three capabilities switch on when configured and fall back when not:

| Setting               | Configured           | Not configured        |
| --------------------- | -------------------- | --------------------- |
| `database.url`        | mysql/tidb, postgres | sqlite at a file path |
| `storage.s3.bucket`   | S3 compatible store  | local filesystem      |
| `auth.oidc.issuer`    | OIDC                 | built-in accounts     |

Usage
-----

Register a project and mint a worker token:

```sh
node src/admin-cli.js project:add demo https://git.example.com/demo.git
node src/admin-cli.js token:add builder-1
```

Both print a secret once. Put the trigger secret in the git hook and the
worker token in the worker configuration.

Install `hooks/post-receive` into the bare repository:

```sh
cp hooks/post-receive /srv/git/demo.git/hooks/
chmod +x /srv/git/demo.git/hooks/post-receive
```

and set `CONDUCTOR_URL`, `CONDUCTOR_PROJECT` and `CONDUCTOR_SECRET` for it.
GitHub, Gitea and GitLab webhooks are accepted at the same endpoint, so a
forge can drive it instead.

Then run a worker, on this machine or any other:

```sh
node src/worker/agent.js --config worker.json
```

See [docs/worker.md](docs/worker.md), and `examples/worker.json`.

Pipelines
---------

```yaml
version: 1

defaults:
  image: debian:bookworm-slim
  timeout: 30m

jobs:
  test:
    script:
      - make test

  build:
    arch: [x86_64, aarch64]
    script:
      - ./build.sh $ARCH
    artifacts:
      paths: [dist/**]

  package:
    needs: [build]
    arch: [x86_64, aarch64]
    matrix:
      pkg: [musl, busybox]
    requires: [sign-key]
    script:
      - ./package.sh $MATRIX_PKG $ARCH

  publish:
    needs: [package, test]
    script:
      - ./publish.sh
```

`arch` and `matrix` fan a job out into one job per combination. A dependency
that shares a dimension is matched on it, so the aarch64 package waits for
the aarch64 build rather than for every build, while `publish`, which has no
architecture of its own, waits for all of them.

`requires` names features a worker must offer. A worker holding a signing key
advertises `sign-key`, and only jobs asking for it are sent there. The key
stays on the worker and is never known to the conductor.

See `docs/pipeline.md` for the full reference.

Architecture
------------

```
git push -> post-receive -> conductor -> job graph in the database
                                |
                          worker polls
                                |
             source tarball, container, log stream, artifacts
```

  - `src/conductor` the write side: triggers, scheduling, the worker API
  - `src/read-api`  the public read side, deployable separately
  - `src/worker`    the agent that runs jobs
  - `src/lib`       configuration, database, storage, pipelines, git

Queries are written once against all three databases using named `{key}`
markers, which each driver compiles to its own placeholder syntax.
Timestamps are epoch milliseconds everywhere.

Testing
-------

```sh
npm test
```

S3 coverage is skipped unless a server is available:

```sh
docker run -d -p 9000:9000 -e MINIO_ROOT_USER=testkey \
  -e MINIO_ROOT_PASSWORD=testsecret123 quay.io/minio/minio server /data

CONDUCTOR_TEST_S3_ENDPOINT=http://127.0.0.1:9000 \
CONDUCTOR_TEST_S3_KEY=testkey \
CONDUCTOR_TEST_S3_SECRET=testsecret123 npm test
```

LICENSE
-------

See [LICENSE.md](LICENSE.md).
