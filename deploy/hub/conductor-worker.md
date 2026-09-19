# conductor-worker

Runs jobs for a [conductor](https://hub.docker.com/r/finwo/conductor)
server. Polls for work, runs each job in its own container, streams the
log back and uploads artifacts.

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

A worker needs no inbound connectivity, so this works from behind NAT.
Mint a token in the interface under Workers, or with the admin CLI on the
server, then:

```sh
docker run -d \
  --name conductor-worker \
  --restart unless-stopped \
  -e CONDUCTOR_URL=https://ci.example.com \
  -e CONDUCTOR_WORKER_TOKEN=... \
  -v /var/run/docker.sock:/var/run/docker.sock \
  finwo/conductor-worker
```

A worker you register is only ever offered jobs from your own projects.

## It keeps nothing

The socket is the only thing this image needs. A job's tree is unpacked
into the job's own container over that socket, and its artifacts are read
back the same way, so the worker shares no directory with what it runs.

That means no volumes, nothing to persist between restarts, and no paths
that have to mean the same thing inside and outside the container. The
job containers are siblings on the host daemon rather than children, but
since nothing of the worker's filesystem is handed to them, that stops
being something you have to think about.

Where a job runs is decided by the build, not by this machine: the
`workdir` key in the pipeline, the project's setting, or `/work`.

## Configuration

| Variable                       | Default        | What it does                        |
| ------------------------------ | -------------- | ----------------------------------- |
| `CONDUCTOR_URL`                | required       | Where the conductor is.             |
| `CONDUCTOR_WORKER_TOKEN`       | required       | Issued by the conductor, shown once. |
| `CONDUCTOR_WORKER_NAME`        | the hostname   | How this worker appears in runs.    |
| `CONDUCTOR_WORKER_CONCURRENCY` | `1`            | Jobs at once.                       |
| `CONDUCTOR_WORKER_ARCHES`      | any            | Architectures offered, comma separated. |
| `CONDUCTOR_WORKER_TOKEN_FILE`  | none           | Read the token from a file instead. |
| `CONDUCTOR_WORKER_DOCKER`      | `docker`       | Runtime CLI: docker, podman, nerdctl. |
| `CONDUCTOR_WORKER_POLL_INTERVAL` | `5`          | Seconds between polls when idle.    |

Leaving `CONDUCTOR_WORKER_ARCHES` unset offers every architecture, which
is what you want unless one worker serves several.

## Features

A feature is a name this worker advertises, together with the local
resources a job asking for it should be given. A pipeline job asks with
`requires:`, and the conductor will not send that job to a worker which
does not advertise every name it lists. The conductor only ever learns
the names.

Features cannot be expressed in an environment variable, because each one
carries mounts, devices and environment of its own. They need a
configuration file, JSON or YAML, mounted into the container:

```json
{
  "conductor_url": "https://ci.example.com",
  "features": {
    "docker": {},
    "sign-key": {
      "mounts": ["/srv/keys/build.rsa:/keys/build.rsa:ro"],
      "env": { "SIGN_KEY": "/keys/build.rsa" }
    }
  }
}
```

```sh
-v /etc/conductor/worker.json:/etc/conductor/worker.json:ro
```

A file at that path is picked up on its own, with the token still coming
from the environment if you would rather keep it out of the file.
Nothing enforces what a name means beyond matching it, so `docker` is
simply how you say this worker's jobs may use the socket mounted above.

## Documentation

- [Workers](https://github.com/finwo/conductor/blob/main/docs/worker.md)
- [Pipelines](https://github.com/finwo/conductor/blob/main/docs/pipeline.md)
- [Deployment](https://github.com/finwo/conductor/blob/main/docs/deployment.md)
