Running a worker
================

A worker polls a conductor for tasks and runs them in containers. It needs no
inbound connectivity, so it can sit behind NAT, and it needs no repository
credentials, because the conductor serves the source for the exact commit a
task was handed.

The worker has no npm dependencies and keeps no state. Copying
`src/worker` onto a host with node and a container runtime is enough.

Requirements
------------

  - node 24 or newer
  - a docker compatible CLI: docker, podman or nerdctl

That is the whole list. A task's tree is unpacked into the task's own
container over the docker API, so the worker needs no `tar` of its own,
and it never touches a repository, so it needs no `git` either.

Getting a token
---------------

Ask whoever runs the conductor for a worker token. They create one with:

```sh
node src/admin-cli.js token:add friends-pi
```

The token is shown once and stored only as a hash, so it cannot be recovered
later. If it is lost, issue a new one and remove the old.

Configuration
-------------

JSON is the native format. YAML also works when the `yaml` package is
installed, which it is in the published image.

```json
{
  "conductor_url": "https://ci.example.com",
  "name": "friends-pi",
  "token_file": "/run/secrets/worker_token",
  "arches": ["aarch64"],
  "concurrency": 2,
  "features": {
    "dind": { "privileged": true },
    "sign-key": {
      "mounts": ["/srv/keys/build.rsa:/keys/build.rsa:ro"],
      "env": { "UNOS_SIGN_KEY": "/keys/build.rsa" }
    }
  }
}
```

```sh
node src/worker/agent.js --config worker.json
```

| Key              | Default              | Description                                     |
| ---------------- | -------------------- | ----------------------------------------------- |
| `conductor_url`  | `http://127.0.0.1:8080` | Base URL of the conductor.                   |
| `name`           | hostname             | Shown against tasks this worker ran.             |
| `token`          | none                 | The worker token, inline.                       |
| `token_file`     | none                 | Path to a file holding the token. Preferred.    |
| `arches`         | `[]`                 | Architectures offered. Empty means no `arch` tasks, only tasks that declare none. |
| `features`       | `{}`                 | Capabilities offered, see below.                |
| `concurrency`    | `1`                  | Tasks run at once.                               |
| `poll_interval`  | `5`                  | Seconds between polls when idle.                |
| `docker`         | `docker`             | Runtime CLI. Set to `podman` or `nerdctl`.      |
| `shell`          | `sh`                 | Shell used to run a task script in its image.    |

There is nothing here about where tasks run or what they are given, which
is deliberate: that is a property of the build and is decided by the
pipeline or the project, not by the machine that happens to run it.

Every key can also be set from the environment: `CONDUCTOR_URL`,
`CONDUCTOR_WORKER_TOKEN`, `CONDUCTOR_WORKER_TOKEN_FILE`,
`CONDUCTOR_WORKER_ARCHES`, `CONDUCTOR_WORKER_CONCURRENCY`,
`CONDUCTOR_WORKER_DOCKER`, and so on. The environment wins over the file.

Features
--------

A feature is a name this worker advertises, together with whatever local
resources a task asking for it should receive. The conductor only ever learns
the name. It will not send a task to a worker that does not advertise every
feature the task's `requires` lists.

```json
"features": {
  "sign-key": {
    "mounts": ["/srv/keys/build.rsa:/keys/build.rsa:ro"],
    "env": { "SIGN_KEY": "/keys/build.rsa" },
    "devices": [],
    "privileged": false
  }
}
```

A pipeline then asks for it by name:

```yaml
package:
  requires: [sign-key]
  script: ['./sign.sh']
```

This is how a signing key reaches a build without the conductor ever holding
it. The key stays on the machine that owns it, and only tasks that explicitly
ask for it are ever scheduled there.

`privileged: true` is what a docker in docker service needs. Grant it only
to features you intend to be privileged, since it removes the isolation
between the task and the host.

What a task gets
---------------

Each task runs in its own container, on its own network:

  - the repository tree at the task's commit, unpacked into the working
    directory, which is `/work` unless the pipeline or the project says
    otherwise
  - that directory as the working directory
  - the task's `env`, plus `ARCH` and `MATRIX_*` for a fanned out task
  - `CONDUCTOR_PROJECT`, `CONDUCTOR_JOB_ID`, `CONDUCTOR_JOB_NUMBER`,
    `CONDUCTOR_TASK`, `CONDUCTOR_TASK_ID`, `CONDUCTOR_SHA`, `CONDUCTOR_REF`
    and `CONDUCTOR_ATTEMPT`, which name the project and job the worker
    itself is never told about: they are opaque strings it copies in
  - any `services`, reachable by their alias on the task network
  - mounts and environment from the features it requires

Output is streamed to the conductor as it happens. Artifacts are read
back out of the container when the task finishes, and uploaded.

Nothing else is shared. The worker mounts no directory of its own into a
task: the tree goes in over the docker API and the artifacts come back the
same way. That is why a worker needs no volumes, no matching paths
between itself and the host, and no storage at all.

Operational notes
-----------------

**Cleanup.** Containers and networks are removed whatever the outcome.
There is no workspace to clean up, and so no trouble with a task having
written files as root that the worker then cannot delete: everything the
task wrote lived in its container and went with it.

**Shutdown.** On SIGINT or SIGTERM the worker stops polling and lets running
tasks finish. A second signal exits immediately, and the conductor will
eventually reap whatever was left running.

**Failures.** A worker that stops reporting has its tasks requeued or failed
by the conductor after `scheduler.heartbeat_timeout`. Losing a worker never
strands a job.

**Log loss.** If the conductor cannot be reached while a task runs, log output
for that window is dropped rather than failing the task. The task's outcome is
still reported.

Trust
-----

A worker is trusted with the source of the commits it builds and with
whatever its features grant it. It is not trusted with anything else: it
holds no repository credentials, it cannot read other refs, it cannot reach
another project's tasks, and it cannot write to storage except by uploading
artifacts for a task it currently holds.

Running a task means running code from the repository. Only accept work from
a conductor whose projects you are willing to execute, and keep features
narrow.
