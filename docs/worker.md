Running a worker
================

A worker polls a conductor for jobs and runs them in containers. It needs no
inbound connectivity, so it can sit behind NAT, and it needs no repository
credentials, because the conductor serves the source for the exact commit a
job was handed.

The worker has no npm dependencies. Copying `src/worker` onto a host with
node, tar and a container runtime is enough.

Requirements
------------

  - node 24 or newer
  - a docker compatible CLI: docker, podman or nerdctl
  - `tar`, to unpack job sources
  - `git`, only for projects configured to clone rather than download

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
| `name`           | hostname             | Shown against jobs this worker ran.             |
| `token`          | none                 | The worker token, inline.                       |
| `token_file`     | none                 | Path to a file holding the token. Preferred.    |
| `arches`         | `[]`                 | Architectures offered. Empty means no `arch` jobs, only jobs that declare none. |
| `features`       | `{}`                 | Capabilities offered, see below.                |
| `concurrency`    | `1`                  | Jobs run at once.                               |
| `poll_interval`  | `5`                  | Seconds between polls when idle.                |
| `docker`         | `docker`             | Runtime CLI. Set to `podman` or `nerdctl`.      |
| `shell`          | `sh`                 | Shell used to run a job script in its image.    |
| `workspace_root` | a temp directory     | Where job workspaces are created.               |
| `cache_root`     | a temp directory     | Where job caches are kept between runs.         |

Every key can also be set from the environment: `CONDUCTOR_URL`,
`CONDUCTOR_WORKER_TOKEN`, `CONDUCTOR_WORKER_TOKEN_FILE`,
`CONDUCTOR_WORKER_ARCHES`, `CONDUCTOR_WORKER_CONCURRENCY`,
`CONDUCTOR_WORKER_DOCKER`, and so on. The environment wins over the file.

Features
--------

A feature is a name this worker advertises, together with whatever local
resources a job asking for it should receive. The conductor only ever learns
the name. It will not send a job to a worker that does not advertise every
feature the job's `requires` lists.

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
it. The key stays on the machine that owns it, and only jobs that explicitly
ask for it are ever scheduled there.

`privileged: true` is what a docker in docker service needs. Grant it only
to features you intend to be privileged, since it removes the isolation
between the job and the host.

What a job gets
---------------

Each job runs in its own container, on its own network, in its own
workspace:

  - the repository tree at the job's commit, unpacked into `/workspace`
  - `/workspace` as the working directory
  - the job's `env`, plus `ARCH` and `MATRIX_*` for a fanned out job
  - `CONDUCTOR_PROJECT`, `CONDUCTOR_RUN_ID`, `CONDUCTOR_RUN_NUMBER`,
    `CONDUCTOR_JOB`, `CONDUCTOR_JOB_ID`, `CONDUCTOR_SHA`, `CONDUCTOR_REF`
    and `CONDUCTOR_ATTEMPT`
  - any `services`, reachable by their alias on the job network
  - mounts and environment from the features it requires

Output is streamed to the conductor as it happens. Artifacts are uploaded
when the job finishes, and the workspace is then removed.

Caches are bind mounted from `cache_root` straight onto their path in the
workspace. A cache is an optimisation and nothing more: a job must still work
with an empty one, and a cache is never shared between workers.

Operational notes
-----------------

**Cleanup.** Containers, networks and workspaces are removed whatever the
outcome. Most images run as root, so files a job creates are owned by root
while the worker usually is not. When removing the workspace fails for that
reason, the worker empties it from inside a container first. Nothing is left
behind either way.

**Shutdown.** On SIGINT or SIGTERM the worker stops polling and lets running
jobs finish. A second signal exits immediately, and the conductor will
eventually reap whatever was left running.

**Failures.** A worker that stops reporting has its jobs requeued or failed
by the conductor after `scheduler.heartbeat_timeout`. Losing a worker never
strands a run.

**Log loss.** If the conductor cannot be reached while a job runs, log output
for that window is dropped rather than failing the job. The job's outcome is
still reported.

Trust
-----

A worker is trusted with the source of the commits it builds and with
whatever its features grant it. It is not trusted with anything else: it
holds no repository credentials, it cannot read other refs, it cannot reach
another project's jobs, and it cannot write to storage except by uploading
artifacts for a job it currently holds.

Running a job means running code from the repository. Only accept work from
a conductor whose projects you are willing to execute, and keep features
narrow.
