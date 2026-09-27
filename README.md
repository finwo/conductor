conductor
=========

A stand-alone CI system. Pipelines live in the repository, tasks run in
containers, and workers pull work rather than being pushed to.

```yaml
# .conductor.yml
version: 1

defaults:
  image: debian:bookworm-slim

tasks:
  test:
    script: [make test]

  version:
    script:
      - echo "::set-output tag=$(cat VERSION)::public"

  build:
    needs: [version]
    arch: [x86_64, aarch64]
    script:
      - ./build.sh $ARCH ${{ tasks.version.outputs.tag }}

  publish:
    needs: [build, test]
    script: [./publish.sh]
```

`arch` and `matrix` fan a task out into one task per combination. A dependent
sharing a dimension is matched on it; `publish` has no architecture of its
own, so it waits for every build.

A script hands a value to a later task with `::set-output`, read back as
`${{ tasks.<task>.outputs.<name> }}`, which is itself a reason to wait for
that task. Outputs are masked unless marked `::public`, so a token passed
between tasks stays out of the logs.

Quick start
-----------

```sh
docker compose -f deploy/docker-compose.yml up -d conductor
```

Or from source, needing node 24 or newer and no native modules:

```sh
npm install && npm start
```

Either way an administrator account is created on first start and its
password written to the log once. Then register a project and a worker:

```sh
node src/admin-cli.js project:add demo https://git.example.com/demo.git
node src/admin-cli.js token:add builder-1
node src/worker/agent.js --config worker.json
```

Both commands print a secret once. The trigger secret goes in the git hook
(`hooks/post-receive`), the worker token in the worker configuration.
GitHub, Gitea and GitLab webhooks are accepted at the same endpoint.

How it works
------------

The conductor reads `.conductor.yml` at the pushed commit and turns it into
a graph of tasks. Workers poll for work, advertising the architectures and
features they offer; any task whose dependencies have succeeded is eligible,
so a wide graph runs wide.

Workers need no repository credentials. The conductor serves the source tree
for the exact commit a task was handed, so someone else's hardware can build
for you without being able to read anything else.

Projects and workers have owners. A worker you register is only ever offered
tasks from your own projects, which is what makes it safe to accept build
capacity from people you do not otherwise trust.

Configuration
-------------

Nothing has to be configured; every setting has a default, so an empty file
is valid. Three capabilities switch on when configured and fall back when
not:

| Setting                   | Configured           | Not configured          |
| ------------------------- | -------------------- | ----------------------- |
| `database.url`            | mysql/tidb, postgres | sqlite at a file path   |
| `storage.s3.bucket`       | S3 compatible store  | local filesystem        |
| `auth.oidc.discovery_url` | that provider        | the built-in login page |

See `conductor.example.yaml` for the annotated list.

Documentation
-------------

| Document                                   | Covers                                |
| ------------------------------------------ | ------------------------------------- |
| [pipeline.md](docs/pipeline.md)            | the `.conductor.yml` reference        |
| [worker.md](docs/worker.md)                | running a worker                      |
| [auth.md](docs/auth.md)                    | accounts, OIDC, who may see what      |
| [deployment.md](docs/deployment.md)        | images, state, production settings    |
| [api.md](docs/api.md)                      | the HTTP API                          |
| [contributing.md](docs/contributing.md)    | layout, testing, building             |

Status
------

Under construction, and usable. Working today: sqlite, mysql/tidb and
postgres; local and S3 compatible storage; pipeline parsing with matrix and
architecture expansion; triggers, scheduling, live logs, artifacts and
reaping; containerised tasks with services, features and caches; accounts,
OIDC, ownership and project variables; a JSON API with a single page
application in front of it; images for amd64, arm64 and riscv64.

Testing
-------

```sh
npm test
npm run build
```

With docker present the suite starts MinIO, an OIDC provider and real task
containers, and cleans up after itself. `npm run build` compiles the
frontend, which the test suite does not cover. See
[docs/contributing.md](docs/contributing.md).

License
-------

See [LICENSE.md](LICENSE.md).
