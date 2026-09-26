.conductor.yml reference
========================

The pipeline file is read from the repository at the commit being built, so
it is versioned with the code it builds. The conductor never executes
anything from the repository while parsing it; the file is data.

Every unknown key is an error rather than a warning, and all problems in a
file are reported together.

Top level
---------

| Key          | Required | Description                                         |
| ------------ | -------- | --------------------------------------------------- |
| `version`    | yes      | Must be `1`.                                        |
| `workdir`    | no       | Absolute path tasks run in. Overrides the project.  |
| `defaults`   | no       | Values inherited by every task.                     |
| `tasks`      | yes      | Mapping of task name to task.                       |

The file may be named `.conductor.yml` or `.conductor.yaml`; both are
looked for unless the project was pointed at some other path explicitly.
Carrying both at once is an error rather than a coin toss, since two
pipelines in one repository will disagree sooner or later.

This key was called `jobs` before 0.3.0. A job is now the pipeline run
that these tasks belong to, and a file still using the old spelling is
refused with a message saying so.

Task names may contain letters, digits, underscore, dot and hyphen, and must
start with a letter or digit.

```yaml
version: 1
defaults:
  image: debian:bookworm-slim
tasks:
  test:
    script: [make test]
```

Visibility
----------

Visibility is a project setting, not a pipeline one. It is recorded on each
job as it is created, so turning a project private stops exposing future jobs
without retroactively hiding, or revealing, earlier ones.

A `visibility` key here is rejected: a repository that could publish its own
results would let anyone able to land a commit read a private project's logs
and artifacts. Set it with `PATCH /api/v1/projects/:id` instead.

A public job, its logs and its artifacts are readable by anyone. A private
job is readable by the project's owner and by administrators.

Tasks
----

| Key             | Type              | Default        | Inheritable |
| --------------- | ----------------- | -------------- | ----------- |
| `image`         | string            | none, required | yes         |
| `script`        | list of strings   | none, required | no          |
| `needs`         | list              | `[]`           | no          |
| `after`         | list              | `[]`           | no          |
| `arch`          | string or list    | none           | yes         |
| `matrix`        | mapping           | none           | no          |
| `requires`      | list of strings   | `[]`           | yes         |
| `services`      | list              | `[]`           | yes         |
| `env`           | mapping           | `{}`           | merged      |
| `artifacts`     | list or mapping   | none           | no          |
| `allow_failure` | boolean           | `false`        | yes         |
| `timeout`       | duration          | server default | yes         |
| `max_attempts`  | integer, 1 to 10  | `1`            | yes         |
| `only`          | mapping           | none           | no          |

`image` and `script` are the only required fields, and `image` may come from
`defaults`.

### script

A list of shell commands, run in order in the task's container. The task fails
on the first command that exits non-zero.

Take care with YAML scalars. Unquoted `true`, `false`, `yes`, `no` and `on`
parse as booleans, not strings, and are rejected:

```yaml
script: ['true']      # correct
script: [true]        # rejected, this is a boolean
```

### timeout

Accepts whole seconds, or a duration with units `s`, `m`, `h`, `d` and `w`,
optionally combined: `90`, `90s`, `30m`, `1h`, `1h30m`. A task timeout may not
exceed seven days; `artifacts.expire` may not exceed a year.

Fanning out
-----------

### only

Restricts a task to certain refs. Without it a task runs on every push.

```yaml
publish:
  needs: [build]
  only:
    refs: [refs/heads/main, 'refs/tags/v*']
  script:
    - ./deploy/publish.sh
```

Patterns match the whole ref, so `refs/heads/main` rather than `main`.
A `*` stands for any run of characters; everything else is literal, so a
dot is a dot rather than any character.

A task that does not match is left out of the job entirely, not recorded
as skipped. A skipped task means a dependency collapsed and fails the job,
which is the wrong reading for a publish step that was never meant to run
on this branch.

Anything depending on an excluded task is excluded with it. Dropping the
dependency instead would let a task run without something it declared it
needed, which is the worse surprise:

```yaml
# On a branch, none of these three run.
publish:
  only: { refs: [refs/heads/main] }
  script: ['make publish']
announce:
  needs: [publish]
  script: ['make announce']
```

A job triggered without a ref matches no pattern, so restricted tasks stay
out rather than being handed a ref they were never written for.

The rule is not inheritable from `defaults`. A restriction that silently
applied to every task is hard to spot when the symptom is an empty job.

### arch

Expands the task into one task per architecture, and restricts each to a worker
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

produces four tasks, named `package:pkg=musl,mode=debug` and so on.

Matrix values become part of the task name, so they are limited to letters,
digits, underscore, dot and hyphen. Use `arch` rather than a matrix dimension
called `arch`.

Dependencies
------------

`needs` lists tasks that must succeed first. A cycle is rejected, naming the
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
needs: ['build:arch=x86_64']            # one specific task
needs:
  - task: build
    match: all                          # every instance, ignore dimensions
```

If a shared dimension has no counterpart, that is an error rather than a
silently dropped dependency.

A dependency that fails normally causes its dependents, and everything
reachable from them, to be skipped. A dependency with `allow_failure: true`
satisfies its dependents whether it passes or not.

### Running after something, whatever became of it

`after` waits for a task to finish without requiring it to have succeeded:

```yaml
test:
  script: ['./test.sh']

report:
  after: [test]
  script: ['./report.sh']
```

`report` runs once `test` has stopped, whether it passed, failed, or was
itself skipped because something it needed failed. This is what to reach for
with teardown, notification and result collection, which are worth running
precisely when the run went badly.

`after` takes the same three forms as `needs` and matches shared dimensions
the same way, because the matching decides which instance is meant and not
what waiting on it implies. Naming one task under both keys is the same as
naming it under `needs` alone.

Two things `after` deliberately does not change:

  It does not rescue the run. A failed task still fails the job, whether or
  not something ran after it. Use `allow_failure` on the task itself to say
  that its failure does not count.

  It does not supply anything. Artifacts from a task that failed may be
  absent or half written, so a task that reads them wants `needs`.

Where `only` keeps a task out of a run, its `after` dependents still run:
there is nothing left to wait for, so the edge is dropped rather than the
dependent. This is the opposite of `needs`, which takes its dependents out
of the run with it.

Talking back from a script
--------------------------

A script can write directives on its own output to hand a value to a later
task, or to say how it should be counted. Both take the same shape, a line
starting at column 0:

```
::<command> <arguments>[::<data>]
```

The line is removed from the log before it is shipped, so a value written
this way does not appear in it.

### Outputs

```yaml
build:
  script:
    - 'make'
    - 'echo "::set-output tag=$(git describe)::public"'

deploy:
  script: ['./deploy.sh ${{ tasks.build.outputs.tag }}']
```

`deploy` was never declared to need `build`. Reading its output says so, and
the dependency is recorded exactly as if `needs: [build]` had been written.

Outputs are masked unless stated otherwise, matching project variables:

```
::set-output token=hunter2            # masked
::set-output token=hunter2::masked    # the same, said out loud
::set-output tag=v1.2.3::public       # shown in the API and the UI
```

A masked value is redacted from the rest of that task's log, and from the log
of every task that goes on to read it. It is never returned by the API and
shows as `[masked]` in the UI. Both kinds are encrypted at rest, exactly as
project variables are; `public` decides what may be shown again, not how it
is stored.

Values are stored per task, and a value is only reachable through a reference
to the task that produced it, so two tasks may use the same output name
without colliding. A reference may be read anywhere `${{ }}` works except
`requires`, which chooses the worker before any task has run.

Naming a matrix task waits for every instance of it and looks the output up
across all of them, which is what a step collecting the whole matrix wants:

```yaml
package:
  arch: [x86_64, aarch64]
  script: ['./build.sh', 'echo "::set-output path-${{ arch }}=/out/pkg.tar::public"']

index:
  script: ['./reindex.sh ${{ tasks.package.outputs.path-x86_64 }}']
```

If the referencing task shares a dimension with the task it reads, the
reference narrows to its own instance, the same way `needs` does.

A reference to a value that was never produced fails the task before it is
handed to a worker, naming what is missing. It does not run with a hole where
the value should have been.

### Choosing the outcome

```yaml
package:
  script:
    - './build.sh'
    - '[ -f out/pkg.tar ] || echo "::set-state skipped"'
```

`::set-state` takes `success`, `failed` or `skipped`, and overrides what the
exit code would have meant. It does not stop the script: the run continues,
and the last directive written is the one that counts.

A timeout, a cancellation, or a failure to start the container still fails
the task. Those are not outcomes a script gets to talk its way out of.

**A skip is not a failure.** A skipped task leaves the job green, and
everything that needed it still runs: the indexer at the end of a package
repository does its work whether or not this particular package was rebuilt.
What it does not do is invent values: a task reading an output that a skipped
task never produced fails on that missing output, which is the difference
between not needing the value and needing one that is not there.

Worker features
---------------

`requires` names capabilities the worker must advertise. The conductor only
offers a task to a worker that advertises all of them.

```yaml
package:
  requires: [sign-key]
  script: ['./sign.sh']
```

What a feature provides is defined on the worker, not here: a mount, some
environment, a privileged container. This is how a signing key reaches a
build without the conductor ever holding it, and how a task asks for docker in
docker.

Services
--------

Sidecar containers started alongside the task on the same network, reachable
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
`postgres:16` is reachable as `postgres`. Aliases must be unique within a task.

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

`expire` sets an exact deadline for what this task produces, and overrides
the project's retention policy in both directions: sooner than the project
would delete, or later than it would keep. It also overrides the rule that
protects the most recent successful job, which is the point of it. A
node_modules tree is worth dropping within the hour whether or not its job
was green, and without that the largest artifacts are the ones kept
longest.

Leave it out and the project's policy applies, which is the usual case.
See [deployment.md](deployment.md) for what those policies are.

Artifacts are streamed rather than buffered, so size is bounded by where
they are stored rather than by the conductor's memory. Object storage
receives anything over 32 MiB as a multipart upload, which keeps memory
flat and lifts the five gigabyte limit that applies to a single request.
Disk images and other multi gigabyte output are fine; what they cost is
storage, not resident memory.

Working directory
-----------------

```yaml
version: 1
workdir: /usr/src/app
```

Where the tree is unpacked inside the task container, and the directory
every script starts in. It must be an absolute path of ordinary directory
names; it does not have to exist in the image, and is created as the tree
is unpacked.

Three answers, most specific first: this key, the project's setting, and
failing both `/work`. The repository has the last word because the path
belongs with the code: an image that expects to build in `/usr/src/app`
knows that, and whoever registered the project should not have to.

Nothing else is shared with the container. The tree arrives over the
docker API and artifacts leave the same way, so a worker needs no
directory in common with the tasks it jobs, and no storage of its own.

Environment
-----------

`env` values must be scalars, and names must be valid environment variable
names. Task `env` is merged over `defaults.env`.

Injected automatically:

| Variable          | Present when                     |
| ----------------- | -------------------------------- |
| `ARCH`            | the task declares `arch`          |
| `MATRIX_<NAME>`   | for each matrix dimension        |

Interpolation
-------------

`${{ ... }}` is substituted in `image`, `script`, `env` values, `requires`
and `services`. Three expressions are available:

| Expression                        | Substituted            |
| --------------------------------- | ---------------------- |
| `arch`                            | when the task is stored |
| `matrix.<name>`                   | when the task is stored |
| `tasks.<task>.outputs.<name>`     | when the task is dispatched |

```yaml
build:
  arch: [x86_64]
  matrix:
    pkg: [musl]
  image: 'builder:${{ arch }}'
  script: ['./build.sh ${{ matrix.pkg }}']
```

Referring to a dimension the task does not declare is an error. Inside
`script` the `$ARCH` and `$MATRIX_*` variables usually read better, since the
shell expands them; interpolation exists for the fields the shell never sees,
such as `image`.

The third is different in kind: its value does not exist until another task
has run, so it survives compilation and is filled in when a worker claims the
task. That is why it cannot appear in `requires`, which is read to decide
which worker to offer the task to. See [talking back from a
script](#talking-back-from-a-script).

Full example
------------

```yaml
version: 1

defaults:
  image: debian:bookworm-slim
  timeout: 30m

tasks:
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

This yields nine tasks: one `lint`, two `build`, four `package` and one
`publish`. The two `build` tasks run at the same time as `lint`; each
`package` starts as soon as its own architecture's `build` finishes.
