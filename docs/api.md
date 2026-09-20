HTTP API
========

Two words to get straight first, because everything below turns on them.

A **job** is one run of a pipeline. Creating it compiles the repository's
`.conductor.yml` at a commit, which produces one or more **tasks**. A task
is the standalone unit a worker runs: one container, one script, one
result.

A worker deals only in tasks. It is never told which project or job a task
belongs to, and the task id it receives carries no structure it could read
that out of. What it gets is a context and a script.

The conductor exposes five HTTP surfaces, all under `/api/v1`. Everything
else, including signing in and managing projects, workers and users,
happens in the interface.

| Surface                                       | Authentication        |
| --------------------------------------------- | --------------------- |
| `POST /api/v1/projects/:project/trigger`       | per project HMAC      |
| `POST /api/v1/projects/:project/jobs`          | per project HMAC      |
| `GET  /api/v1/projects/:project/jobs/:job`     | HMAC, session, or anonymous for a public job |
| `GET  /api/v1/tasks/:task`                     | session, or anonymous for a public task |
| `GET  /api/v1/projects/:project/tasks/:task`   | HMAC, session, or anonymous for a public task |
| `POST /api/v1/tasks/claim`, `/tasks/:task/...` | worker token          |
| `GET  /api/v1/projects/.../artifacts/...`      | session, or anonymous for a public job |

Note the two readings of `/api/v1/tasks/:task`. Asking after the task
itself is a public read; everything below it is the worker protocol and
needs a token. They are separate plugins for that reason, so the token
requirement cannot accidentally spread to the first or lapse on the rest.

Errors are `{"error": "..."}` with a meaningful status. A resource the
caller may not see returns 404 rather than 403, so absence and denial are
indistinguishable.

Starting a job
--------------

Two ways in, differing only in the shape of what they accept. Both take the
same signature, and both read the pipeline from the repository at the
commit rather than trusting anything the caller says about it.

### From a push

```
POST /api/v1/projects/:project/trigger
```

Accepts the payload from `hooks/post-receive`, and the push events of
GitHub, Gitea and GitLab. Signed with the project's trigger secret:
`X-Hub-Signature-256: sha256=<hmac>` over the exact request body, or
`X-Gitlab-Token`.

```json
{ "sha": "<40 hex>", "base": "<40 hex or empty>", "ref": "refs/heads/main", "actor": "alice" }
```

A push that deletes a branch is reported as ignored rather than refused,
since there is nothing there to build.

### Deliberately

```
POST /api/v1/projects/:project/jobs
```

For anything driving the conductor on purpose rather than forwarding a
hook. No payload archaeology: `sha` is required and must be a full commit
id, and a missing one is an error rather than something to infer.

```json
{ "sha": "<40 hex>", "ref": "refs/heads/main", "base": null, "actor": "alice", "trigger": "api" }
```

Only `sha` is required. `trigger` is recorded as-is and defaults to `api`,
so a job started this way stays distinguishable from one a hook forwarded.

Both return:

```json
{ "status": "created", "job_id": "m2y5rj7ykdm9sfbr54hf", "tasks": 6 }
```

| Status | Meaning                                        |
| ------ | ---------------------------------------------- |
| 200    | job created, or ignored for a branch deletion  |
| 400    | no usable commit in the payload                |
| 401    | signature missing or wrong                     |
| 404    | no such project                                |
| 409    | project disabled                               |
| 422    | the pipeline at that commit is invalid         |

A 422 carries `problems`, an array of `{path, message}`, so a broken
pipeline says which key is wrong rather than only that something is.

Reading a job back
------------------

```
GET /api/v1/projects/:project/jobs/:job
```

Returns the job and the state of every task in it.

```json
{
  "job": { "id": "...", "number": 12, "state": "running", "ref": "refs/heads/main",
           "head_sha": "...", "visibility": "private", "created_at": 1800000000000 },
  "tasks": [
    { "id": "...", "name": "build:arch=x86_64", "state": "success", "exit_code": 0,
      "arch": "x86_64", "attempt": 1, "worker_name": "builder-1" }
  ]
}
```

Three ways to be allowed: the job is public, the caller holds the project's
trigger secret, or the caller is signed in and may manage the project. One
credential therefore covers starting a build and watching it.

Reading a task back
-------------------

```
GET /api/v1/tasks/:task
GET /api/v1/projects/:project/tasks/:task
```

A task's state and the artifacts it stored. Both paths return the same
body. A task id is unique on its own, so naming the project is optional;
doing so only widens what may reach a private task, because there is then a
trigger secret to check against.

| | public task | trigger secret | session that may manage the project |
| --- | --- | --- | --- |
| `/tasks/:task` | yes | not applicable | yes |
| `/projects/:project/tasks/:task` | yes | yes | yes |

A signature on the bare path proves nothing, since there is no project in
it to look a secret up from. On the scoped path the project must be the one
the task belongs to, so a guessed id cannot be read through some other
project that happens to be readable. Signing a GET means an HMAC over an
empty body.

```json
{
  "task": {
    "id": "m2y5t7deprrj9s6jvv4d", "name": "package:arch=x86_64,pkg=musl",
    "base_name": "package", "state": "success", "arch": "x86_64",
    "image": "debian:bookworm-slim", "attempt": 1, "max_attempts": 1,
    "allow_failure": false, "exit_code": 0, "error": null,
    "worker_name": "builder-1", "timeout": 3600, "workdir": "/work",
    "needs": ["build:arch=x86_64"], "matrix": { "pkg": "musl" },
    "artifact_paths": ["dist/**"], "log_size": 4096,
    "created_at": 1800000000000, "started_at": null, "finished_at": null,
    "project_id": "demo", "job_id": "m2y5rj7ykdm9sfbr54hf", "job_number": 12,
    "ref": "refs/heads/main", "sha": "<40 hex>", "visibility": "public"
  },
  "artifacts": [
    { "id": "...", "path": "dist/app", "size": 1048576, "sha256": "<64 hex>",
      "created_at": 1800000000000, "expires_at": null,
      "url": "https://ci.example.com/api/v1/projects/demo/jobs/<job>/tasks/<task>/artifacts/<id>" }
  ]
}
```

`artifact_paths` is what the pipeline told the task to collect; `artifacts`
is what it actually stored. Each carries a ready download `url`, which is a
convenience rather than the permission: that route checks visibility again
for itself.

There is no `env` and no `services` here, deliberately. Both can hold
project variables, and a service carries an environment of its own. The
`script` is left out for the same reason: a public job can be built from a
repository that is not public. A worker gets all three because it has to;
nobody else does.

The worker API
--------------

Documented because a worker is a normal client of it, and anyone may write
another. Every call needs `Authorization: Bearer <worker token>`, and a
worker may only touch a task it currently holds.

| Method | Path                                   | Purpose                           |
| ------ | -------------------------------------- | --------------------------------- |
| POST   | `/api/v1/tasks/claim`                  | claim work, 204 when idle         |
| GET    | `/api/v1/tasks/:task/source.tar.gz`    | the tree at the commit            |
| POST   | `/api/v1/tasks/:task/log`              | append output                     |
| POST   | `/api/v1/tasks/:task/artifacts`        | upload one file                   |
| POST   | `/api/v1/tasks/:task/heartbeat`        | stay alive, learn of cancellation |
| POST   | `/api/v1/tasks/:task/complete`         | report the outcome                |

Claim with a JSON body:
`{"arches":["x86_64","aarch64"],"features":["dind","sign-key"],"name":"my-worker"}`.
Only tasks whose architecture the worker offers and whose `requires` it
satisfies are handed out. A worker owned by a user is only offered that
user's projects.

`/api/v1/tasks/claim` is the only URL a worker needs to know. A claimed
task carries absolute URLs for every other call in `endpoints`, so the rest
of the surface is discovered rather than assembled:

```json
{
  "task": {
    "id": "m2y5t7deprrj9s6jvv4d",
    "name": "build:arch=x86_64",
    "image": "debian:bookworm-slim",
    "script": ["./build.sh $ARCH"],
    "env": { "ARCH": "x86_64", "CONDUCTOR_PROJECT": "demo" },
    "requires": [], "services": [], "artifacts": { "paths": ["dist/**"] },
    "workdir": "/work", "timeout": 3600, "attempt": 1,
    "sha": "<40 hex>", "ref": "refs/heads/main",
    "masked": [], "heartbeat_interval": 30,
    "endpoints": {
      "source":    "https://ci.example.com/api/v1/tasks/<id>/source.tar.gz",
      "log":       "https://ci.example.com/api/v1/tasks/<id>/log",
      "artifact":  "https://ci.example.com/api/v1/tasks/<id>/artifacts",
      "heartbeat": "https://ci.example.com/api/v1/tasks/<id>/heartbeat",
      "done":      "https://ci.example.com/api/v1/tasks/<id>/complete"
    }
  }
}
```

There is no `project_id` and no `job_id` in that payload, deliberately. The
identifiers a build legitimately wants are in `env`, where they are opaque
strings the worker copies into the container without reading.

Log appends send `Content-Type: application/octet-stream` with
`X-Log-Offset` set to where the worker believes it is writing. An
overlapping chunk is trimmed and a gap is refused with 409 and
`expected_offset`, which makes a retry after a dropped connection safe.

Artifact uploads send the bytes with `X-Artifact-Path` and a
`Content-Length`. The path is sanitised, so traversal is stripped rather
than honoured. Bodies are streamed and may be arbitrarily large; a body
that does not match its declared length is rejected.

```json
{ "success": true, "exit_code": 0, "error": null }
```

`complete` reports the outcome. A failure with attempts remaining requeues
the task; otherwise everything downstream of it is skipped.

Artifacts
---------

```
GET /api/v1/projects/:project/jobs/:job/tasks/:task/artifacts/:artifact
```

The one read endpoint that exists for a browser, so the task page can link
straight at a build's output. The project, job and task in the path must
all agree with the artifact. A public job is downloadable by anyone; a
private one by its owner or an administrator. The response is the bytes, or
a redirect to the object store when it can presign.
