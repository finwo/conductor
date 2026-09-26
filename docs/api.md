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

Everything the conductor does is under `/api/v1`. There is no second
surface: the application in `web/` is an ordinary client of what follows,
and the only page the conductor renders itself is the built-in login form.

Three kinds of credential reach it, all in `Authorization: Bearer`:

| Credential          | Obtained by                        | Reaches                     |
| ------------------- | ---------------------------------- | --------------------------- |
| access token        | the code flow, see `docs/auth.md`  | everything a person may do  |
| worker token        | `POST /api/v1/workers`             | the worker protocol only    |
| project HMAC        | a project's trigger secret         | starting that project's jobs |

An access token is a JWT and a worker token is 64 hex characters, so the
two never parse as each other. The project HMAC is not a bearer credential
at all: it is `X-Hub-Signature-256` over the exact request body.

Note the two readings of `/api/v1/tasks/:task`. Asking after the task
itself is a public read; everything below it is the worker protocol and
needs a token. They are separate plugins for that reason, so the token
requirement cannot accidentally spread to the first or lapse on the rest.

Anonymous is not an error. A public project's jobs and tasks read without
any credential at all.

Responses
---------

Every response carries `ok`, so success and failure are told apart by one
key rather than inferred from which others turned up.

```json
{ "ok": true, "data": { "...": "..." } }
```

```json
{ "ok": false, "error": { "name": "UnknownTask", "message": "No such task" } }
```

`error.name` is the identifier to branch on, and is stable. `error.message`
is for a person to read and may be reworded. Some errors add `error.details`
with machine-readable context; a 500 carries `details.request_id`, which is
the id the fault was logged under.

A resource the caller may not see returns 404 rather than 403, so absence
and denial are indistinguishable.

Responses holding a collection add `pagination`:

```json
{
  "ok": true,
  "data": { "...": "..." },
  "pagination": {
    "next": "https://ci.example.com/api/v1/tasks/<id>?offset=50&limit=50",
    "offset": 0,
    "total": 128
  }
}
```

Ask with `?offset=` and `?limit=`. The limit defaults to 50 and is capped at
200; an offset or limit that cannot be read falls back rather than failing.
Follow `next` rather than building the URL, and stop when it is absent:
`next` is omitted on the last page rather than sent as null, as is `details`
when there is none.

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
`X-Gitlab-Token`. A session that may manage the project is accepted
instead, for callers driving the API rather than forwarding a hook.

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
{ "ok": true, "data": { "status": "created", "job_id": "m2y5rj7ykdm9sfbr54hf" } }
```

| Status | `error.name`                           | Meaning                                       |
| ------ | -------------------------------------- | --------------------------------------------- |
| 200    | none                                   | job created, or ignored for a branch deletion |
| 400    | `NoCommitInPayload`, `InvalidSha`, `ShaRequired`, `MalformedJson` | nothing usable to build |
| 401    | `InvalidSignature`                     | signature missing or wrong                    |
| 404    | `UnknownProject`                       | no such project                               |
| 409    | `ProjectDisabled`                      | project disabled                              |

The job is recorded and the response returns immediately; the pipeline is
compiled afterwards. A pipeline that will not compile therefore surfaces as
the job going to `failed` with the reason on it, not as an error here.

Reading a job back
------------------

```
GET  /api/v1/jobs                              every job the caller may see
GET  /api/v1/projects/:project/jobs            one project's jobs
GET  /api/v1/jobs/:job
GET  /api/v1/projects/:project/jobs/:job
GET  /api/v1/jobs/:job/tasks
POST /api/v1/jobs/:job/cancel
POST /api/v1/jobs/:job/retry
```

A job id is unique on its own, so naming the project is optional. Where it
is named it is asserted: a job of some other project is a 404 rather than
being quietly served. The lists take `?state=` alongside the paging.

```json
{
  "ok": true,
  "data": { "id": "...", "number": 12, "state": "running", "ref": "refs/heads/main",
            "head_sha": "...", "visibility": "private", "created_at": 1800000000000 }
}
```

Two ways to be allowed: the job is public, or the caller may manage the
project.

`/tasks` returns the tasks and the edges between them, which is what a
stage graph is drawn from:

```json
{
  "ok": true,
  "data": {
    "tasks": [
      { "id": "...", "name": "build:arch=x86_64", "state": "success", "exit_code": 0,
        "arch": "x86_64", "attempt": 1, "worker_name": "builder-1" }
    ],
    "deps": [
      { "task_id": "...", "depends_on_id": "...", "kind": "needs" }
    ]
  },
  "pagination": { "offset": 0, "total": 6 }
}
```

`kind` is `needs` or `after`. An `after` edge orders a task without putting
it downstream of a failure.

`cancel` only applies to a running job and is a 409 otherwise. `retry`
starts a new job at the same commit and returns its id; the original stays
readable rather than being overwritten.

Reading a task back
-------------------

```
GET /api/v1/tasks/:task
GET /api/v1/tasks/:task/log
GET /api/v1/tasks/:task/outputs
GET /api/v1/tasks/:task/artifacts
```

Each also answers under `/api/v1/projects/:project/tasks/:task`, where the
project is asserted: a guessed id cannot be read through whichever project
happens to be readable. A private task needs a session on both paths.

```json
{
  "ok": true,
  "data": {
  "task": {
    "id": "m2y5t7deprrj9s6jvv4d", "name": "package:arch=x86_64,pkg=musl",
    "base_name": "package", "state": "success", "arch": "x86_64",
    "image": "debian:bookworm-slim", "attempt": 1, "max_attempts": 1,
    "allow_failure": false, "exit_code": 0, "error": null,
    "worker_name": "builder-1", "timeout": 3600, "workdir": "/work",
    "needs": ["build:arch=x86_64"], "after": [], "matrix": { "pkg": "musl" },
    "artifact_paths": ["dist/**"],
    "log_size": 4096, "log_expired": false,
    "created_at": 1800000000000, "started_at": null, "finished_at": null,
    "project_id": "demo", "job_id": "m2y5rj7ykdm9sfbr54hf", "job_number": 12,
    "ref": "refs/heads/main", "sha": "<40 hex>", "visibility": "public"
  }
  }
}
```

The log, the outputs and the artifacts are each their own page, because
each grows without bound and none of them belongs inside one response.

```
GET /api/v1/tasks/:task/log?offset=0&limit=262144
```

```json
{ "ok": true, "data": { "offset": 0, "size": 4096, "data": "...", "expired": false } }
```

`size` is the whole log, so a tail asks from where it stopped and is given
only what is new. `expired` is true once retention has removed it, which is
a different answer from an empty log.

`artifact_paths` on the task is what the pipeline told it to collect;
`/artifacts` is what it actually stored. Each carries a ready download
`url`, a convenience rather than the permission: that route checks
visibility again for itself.

`/outputs` is what the task wrote with `::set-output`. A masked one reports
its name so the shape of a run is visible, and never its value.

There is no `env` and no `services` here, deliberately. Both can hold
project variables, and a service carries an environment of its own. The
`script` is left out for the same reason: a public job can be built from a
repository that is not public. A worker gets all three because it has to;
nobody else does.

Managing things
---------------

All of this needs an access token. What it may reach follows from who the
token belongs to rather than from which URL was used: an administrator acts
on anything, anyone else on what they own. Something they may not see is
reported as missing, not refused.

```
GET    /api/v1/users            /users/:id   PATCH, DELETE   POST /users
GET    /api/v1/projects         /projects/:id PATCH, DELETE  POST /projects
GET    /api/v1/workers          /workers/:id PATCH, DELETE   POST /workers
GET    /api/v1/sessions         /sessions/:id DELETE
```

`me` is an ordinary user id that resolves to the caller, so `GET
/api/v1/users/me` is who am I. Listing users as a non-administrator returns
just themselves rather than a refusal.

Changing your own password takes `current_password` alongside the new one.
An administrator setting someone else's does not, which is what a reset is.

`repo_url` must be `https`, `ssh` or `git`, or an `scp`-style `user@host:path`.
Other schemes select a git transport rather than a location: `ext::` runs a
command, `file://` reads the conductor's own disk.

Two things are shown exactly once, in the response that creates them, and
are not readable afterwards:

```json
{ "ok": true, "data": { "id": "demo", "trigger_secret": "<64 hex>" } }
{ "ok": true, "data": { "id": "...", "name": "builder-1", "token": "<64 hex>" } }
```

`POST /api/v1/projects/:id/trigger-secret` replaces the first. There is no
way to read either back; losing one means generating another.

Project retention takes three answers and they are all different. Absent
leaves the setting alone, `null` follows the server default, and `0` keeps
forever:

```
PATCH /api/v1/projects/:id   { "artifact_keep_days": null, "log_keep_days": 0 }
```

Variables are per project, and a value is never read back:

```
GET    /api/v1/projects/:id/variables
PUT    /api/v1/projects/:id/variables/:name   { "value": "...", "masked": true }
DELETE /api/v1/projects/:id/variables/:name
```

A worker's machines and its recent tasks hang off it:

```
GET /api/v1/workers/:id/agents
GET /api/v1/workers/:id/tasks
```

Sessions are the revocation surface. Each row carries the browser and
address it was last used from, so a person can tell one from another. They
are recorded for that and nothing else: a session arriving from a new
address is ordinary, and is never refused for it.

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
  "ok": true,
  "data": {
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
}
```

There is no `project_id` and no `job_id` in that payload, deliberately. The
identifiers a build legitimately wants are in `env`, where they are opaque
strings the worker copies into the container without reading.

Log appends send `Content-Type: application/octet-stream` with
`X-Log-Offset` set to where the worker believes it is writing. An
overlapping chunk is trimmed, and a gap is refused with a 409 naming
`LogOffsetConflict` and carrying where to resume:

```json
{
  "ok": false,
  "error": {
    "name": "LogOffsetConflict",
    "message": "The log chunk does not continue from the end of the log",
    "details": { "expected_offset": 4096 }
  }
}
```

Artifact uploads send the bytes with `X-Artifact-Path` and a
`Content-Length`. The path is sanitised, so traversal is stripped rather
than honoured. Bodies are streamed and may be arbitrarily large; a body
that does not match its declared length is rejected.

`complete` reports the outcome, and is sent a body rather than given one.
Requests are not enveloped; only responses are:

```json
{
  "success": true, "state": "success", "exit_code": 0, "error": null,
  "outputs": [{ "name": "tag", "value": "v1.2.3", "masked": false }]
}
```

`state` is one of `success`, `failed` or `skipped`, and is what the task
wrote with `::set-state` if it wrote one. It takes precedence over
`success`, which is kept for workers that do not send a state. Names and
sizes in `outputs` are validated again here rather than trusted from the
worker, and values are encrypted before they are stored.

A failure with attempts remaining requeues the task, discarding any outputs
that attempt produced; otherwise everything that `needs` it, directly or
transitively, is skipped. Tasks that only name it under `after` are released
instead, since they asked to follow it rather than to be fed by it.

A task that reports `skipped` is not a failure: the job can still end
`success`, and tasks that `needs` it still run. One of them reading an output
it never produced fails on that, before it is handed to a worker.

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
