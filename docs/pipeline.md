.conductor.yml reference
========================

The pipeline file is read from the repository at the commit being built, so
it is versioned with the code it builds. The conductor never executes
anything from the repository while parsing it; the file is data.

Every unknown key is an error rather than a warning, and all problems in a
file are reported together.

Top level
---------

| Key          | Required | Description                                  |
| ------------ | -------- | -------------------------------------------- |
| `version`    | yes      | Must be `1`.                                 |
| `visibility` | no       | `public` or `private`. Overrides the project. |
| `defaults`   | no       | Values inherited by every job.               |
| `jobs`       | yes      | Mapping of job name to job.                  |

Job names may contain letters, digits, underscore, dot and hyphen, and must
start with a letter or digit.

```yaml
version: 1
defaults:
  image: debian:bookworm-slim
jobs:
  test:
    script: [make test]
```

Visibility
----------

Runs are private unless something says otherwise, and the repository has the
final word on its own results:

```yaml
version: 1
visibility: public
```

Unset means the project's setting stands. The value is recorded on each run
as it is created, so turning a repository private stops exposing future runs
without retroactively hiding, or revealing, earlier ones.

A public run, its logs and its artifacts are readable by anyone. A private
run is readable by the project's owner and by administrators.

Jobs
----

| Key             | Type              | Default        | Inheritable |
| --------------- | ----------------- | -------------- | ----------- |
| `image`         | string            | none, required | yes         |
| `script`        | list of strings   | none, required | no          |
| `needs`         | list              | `[]`           | no          |
| `arch`          | string or list    | none           | yes         |
| `matrix`        | mapping           | none           | no          |
| `requires`      | list of strings   | `[]`           | yes         |
| `services`      | list              | `[]`           | yes         |
| `env`           | mapping           | `{}`           | merged      |
| `artifacts`     | list or mapping   | none           | no          |
| `cache`         | list or mapping   | none           | yes         |
| `allow_failure` | boolean           | `false`        | yes         |
| `timeout`       | duration          | server default | yes         |
| `max_attempts`  | integer, 1 to 10  | `1`            | yes         |

`image` and `script` are the only required fields, and `image` may come from
`defaults`.

### script

A list of shell commands, run in order in the job's container. The job fails
on the first command that exits non-zero.

Take care with YAML scalars. Unquoted `true`, `false`, `yes`, `no` and `on`
parse as booleans, not strings, and are rejected:

```yaml
script: ['true']      # correct
script: [true]        # rejected, this is a boolean
```

### timeout

Accepts whole seconds, or a duration with units `s`, `m`, `h`, `d` and `w`,
optionally combined: `90`, `90s`, `30m`, `1h`, `1h30m`. A job timeout may not
exceed seven days; `artifacts.expire` may not exceed a year.

Fanning out
-----------

### arch

Expands the job into one job per architecture, and restricts each to a worker
that offers it. The value is available to the script as `$ARCH`.

```yaml
build:
  arch: [x86_64, aarch64]
  script: ['./build.sh $ARCH']
```

produces `build:arch=x86_64` and `build:arch=aarch64`.

### matrix

Expands over the cartesian product of its dimensions. Each value is available
as `$MATRIX_<NAME>` in upper case. Dimension order follows the file, so
generated names are predictable.

```yaml
package:
  matrix:
    pkg: [musl, busybox]
    mode: [debug, release]
```

produces four jobs, named `package:pkg=musl,mode=debug` and so on.

Matrix values become part of the job name, so they are limited to letters,
digits, underscore, dot and hyphen. Use `arch` rather than a matrix dimension
called `arch`.

Dependencies
------------

`needs` lists jobs that must succeed first. A cycle is rejected, naming the
cycle.

When a dependency shares a dimension with the dependent, it is matched on
that dimension rather than fanned out across it:

```yaml
build:
  arch: [x86_64, aarch64]
  script: ['./build.sh $ARCH']

package:
  needs: [build]
  arch: [x86_64, aarch64]
  script: ['./package.sh $ARCH']

publish:
  needs: [package]
  script: ['./publish.sh']
```

`package:arch=x86_64` waits only for `build:arch=x86_64`. `publish` declares
no architecture, so it waits for every `package`.

Three forms are accepted:

```yaml
needs: [build]                          # match shared dimensions
needs: ['build:arch=x86_64']            # one specific job
needs:
  - job: build
    match: all                          # every instance, ignore dimensions
```

If a shared dimension has no counterpart, that is an error rather than a
silently dropped dependency.

A dependency that fails normally causes its dependents, and everything
reachable from them, to be skipped. A dependency with `allow_failure: true`
satisfies its dependents whether it passes or not.

Worker features
---------------

`requires` names capabilities the worker must advertise. The conductor only
offers a job to a worker that advertises all of them.

```yaml
package:
  requires: [sign-key]
  script: ['./sign.sh']
```

What a feature provides is defined on the worker, not here: a mount, some
environment, a privileged container. This is how a signing key reaches a
build without the conductor ever holding it, and how a job asks for docker in
docker.

Services
--------

Sidecar containers started alongside the job on the same network, reachable
by their alias.

```yaml
test:
  image: node:22
  services:
    - postgres:16
    - image: docker:dind
      alias: docker
      env:
        DOCKER_TLS_CERTDIR: ''
  script: [npm test]
```

The alias defaults to the image name without registry, path or tag, so
`postgres:16` is reachable as `postgres`. Aliases must be unique within a job.

Artifacts
---------

```yaml
artifacts:
  paths:
    - dist/**
    - build/*.tar.gz
  when: on_success
  expire: 30d
```

A bare list is shorthand for `paths`. Paths are relative to the workspace;
absolute paths are rejected. `when` is `on_success`, `on_failure` or
`always`.

Artifacts are streamed rather than buffered, so size is bounded by where
they are stored rather than by the conductor's memory. Object storage
receives anything over 32 MiB as a multipart upload, which keeps memory
flat and lifts the five gigabyte limit that applies to a single request.
Disk images and other multi gigabyte output are fine; what they cost is
storage, not resident memory.

Cache
-----

```yaml
cache:
  key: deps-$MATRIX_PKG
  paths: [.npm, vendor]
```

A directory preserved between jobs on the same worker, keyed by `key`. A
cache is an optimisation, never a correctness guarantee: a job must work with
an empty one.

Environment
-----------

`env` values must be scalars, and names must be valid environment variable
names. Job `env` is merged over `defaults.env`.

Injected automatically:

| Variable          | Present when                     |
| ----------------- | -------------------------------- |
| `ARCH`            | the job declares `arch`          |
| `MATRIX_<NAME>`   | for each matrix dimension        |

Interpolation
-------------

`${{ ... }}` is substituted before the job is stored, in `image`, `script`,
`env` values, `requires`, `services` and `cache`. Two expressions are
available: `arch` and `matrix.<name>`.

```yaml
build:
  arch: [x86_64]
  matrix:
    pkg: [musl]
  image: 'builder:${{ arch }}'
  script: ['./build.sh ${{ matrix.pkg }}']
```

Referring to a dimension the job does not declare is an error. Inside
`script` the `$ARCH` and `$MATRIX_*` variables usually read better, since the
shell expands them; interpolation exists for the fields the shell never sees,
such as `image`.

Full example
------------

```yaml
version: 1

defaults:
  image: debian:bookworm-slim
  timeout: 30m

jobs:
  lint:
    script: [make lint]

  build:
    arch: [x86_64, aarch64]
    script: ['./mk/build.sh $ARCH']
    artifacts:
      paths: [build/out/**]
      expire: 7d

  package:
    needs: [build]
    arch: [x86_64, aarch64]
    matrix:
      pkg: [musl, busybox]
    requires: [sign-key]
    script: ['./mk/package.sh $MATRIX_PKG $ARCH']
    artifacts:
      paths: ['build/repo/$ARCH/*.apk']

  publish:
    needs: [package, lint]
    requires: [publish-key]
    script: ['./mk/publish.sh']
```

This yields nine jobs: one `lint`, two `build`, four `package` and one
`publish`. The two `build` jobs run at the same time as `lint`; each
`package` starts as soon as its own architecture's `build` finishes.
