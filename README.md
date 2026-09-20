conductor
=========

A stand-alone CI system. Pipelines live in the repository, tasks run in
containers, and workers pull work rather than being pushed to.

Summary
-------

The conductor accepts a push notification, reads `.conductor.yml` at the
pushed commit, and turns it into a graph of tasks. Workers poll for work,
advertising the architectures and features they can offer. Any task whose
dependencies have succeeded is eligible, so a wide graph runs wide.

Workers need no repository credentials: the conductor serves the source tree
for the exact commit a task was handed. A worker on someone else's hardware
can therefore build for you without being able to read anything else.

Nothing has to be set up before it will run. With no configuration it uses
sqlite on disk, stores artifacts on the local filesystem, and manages its own
user accounts. Point it at a database url, an S3 bucket or an OIDC discovery
url and it uses those instead.

Status
------

Under construction. Working today:

  - configuration, with sqlite, mysql/tidb and postgres backends
  - local and S3 compatible object storage
  - pipeline parsing, matrix and architecture expansion, dependency graphs
  - triggers, job scheduling, the worker API, live logs, artifacts, reaping
  - the worker: containerised tasks, services, features, caches, cleanup
  - accounts, OIDC, project ownership, visibility and project variables
  - the web interface, server rendered with htmx
  - container images for amd64, arm64 and riscv64, published on release

Installation
------------

With docker:

```sh
docker compose -f deploy/docker-compose.yml up -d conductor
```

Images are published as `finwo/conductor` and `finwo/conductor-worker`
for amd64, arm64 and riscv64.

From source, requiring node 24 or newer and no native modules:

```sh
npm install
cp conductor.example.yaml conductor.yaml
npm start
```

On first start an administrator account is created and its generated
password written to the log once. Open the port and sign in.

`mysql2` and `pg` are optional and only needed when `database.url` points at
one of those servers.

Configuration
-------------

Every setting has a default, so an empty config file is valid. Values are
read from defaults, then `conductor.yaml`, then the environment. See
`conductor.example.yaml` for the annotated list.

Three capabilities switch on when configured and fall back when not:

| Setting                 | Configured           | Not configured        |
| ----------------------- | -------------------- | --------------------- |
| `database.url`          | mysql/tidb, postgres | sqlite at a file path |
| `storage.s3.bucket`     | S3 compatible store  | local filesystem      |
| `auth.oidc.discovery_url` | OIDC               | built-in accounts     |

With OIDC the provider owns identity. Point `auth.oidc.discovery_url` at the
provider's OpenID configuration document and set `client_id` (and
`client_secret` for a confidential client); the issuer and every endpoint
come from that document. Register `<server.public_url>/oidc/callback` as the
redirect uri. An account is created locally the first time someone signs in,
keyed on issuer and subject, so they can own projects and workers. The role
in the token wins on every request, and disabling the local account locks
them out regardless of what the provider says.

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

Who sees what
-------------

Everything is private by default. A job is visible to an anonymous visitor
only when the project, or the pipeline at that commit, says it is public:

```yaml
version: 1
visibility: public
```

Because it is recorded per job, making a repository private stops exposing
future jobs without rewriting the history of past ones.

Users register their own projects and their own workers. A worker someone
registers is only ever offered tasks from that person's projects, which is
what makes it safe to accept build capacity from people you do not
otherwise trust. A worker created by an administrator with no owner is
shared, and runs anything.

Administrators see and manage everything, and manage accounts. Deleting an
account deletes the projects and workers it owned, along with their job
history: leaving them behind would turn a personal worker into a shared one.

Pipelines
---------

```yaml
version: 1

defaults:
  image: debian:bookworm-slim
  timeout: 30m

tasks:
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

`arch` and `matrix` fan a task out into one task per combination. A dependency
that shares a dimension is matched on it, so the aarch64 package waits for
the aarch64 build rather than for every build, while `publish`, which has no
architecture of its own, waits for all of them.

`requires` names features a worker must offer. A worker holding a signing key
advertises `sign-key`, and only tasks asking for it are sent there. The key
stays on the worker and is never known to the conductor.

See [docs/pipeline.md](docs/pipeline.md) for the full reference,
[docs/worker.md](docs/worker.md) for running a worker,
[docs/deployment.md](docs/deployment.md) for deploying, and
[docs/api.md](docs/api.md) for the HTTP API.

Architecture
------------

```
git push -> post-receive -> conductor -> task graph in the database
                                |
                          worker polls
                                |
             source tarball, container, log stream, artifacts
```

  - `src/conductor` triggers, scheduling, the worker API, the interface
  - `src/worker`    the agent that runs tasks, with no npm dependencies
  - `src/lib`       configuration, database, storage, pipelines, git

Queries are written once against all three databases using named `{key}`
markers, which each driver compiles to its own placeholder syntax.
Timestamps are epoch milliseconds everywhere.

Testing
-------

```sh
npm test
```

That is the whole setup. With docker available the suite starts what it
needs and cleans up after itself:

| Dependency          | Used for                                     |
| ------------------- | -------------------------------------------- |
| `alpine`            | containers for the worker to actually run tasks in |
| MinIO               | object storage, artifacts and archived logs  |
| mock-oauth2-server  | a real OIDC provider to authenticate against |

Nothing is stubbed, because the failures worth catching live in the parts a
stub would replace. Hand written SigV4 signing is only meaningfully tested
by a server that rejects a bad signature, and the JWKS path was wrong
against every provider except the one it was written for.

Without docker those tests skip and the rest still run:

```sh
CONDUCTOR_TEST_NO_DOCKER=1 npm test
```

To test against a different object store, such as Garage or AWS, point the
same tests at it instead of starting MinIO:

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
