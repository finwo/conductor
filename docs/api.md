HTTP API
========

Four surfaces, distinguished by who may reach them:

| Prefix          | Authentication          |
| --------------- | ----------------------- |
| `/api/trigger`  | per project HMAC        |
| `/api/workers`  | worker token            |
| `/api/admin`    | session, admin role     |
| everything else | session, or anonymous   |

Errors are `{"error": "..."}` with a meaningful status. A resource the
caller may not see returns 404 rather than 403, so absence and denial are
indistinguishable.

Authentication
--------------

Sign in for a token, or send the session cookie the same call sets:

```sh
curl -X POST https://ci.example.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"..."}'
```

```json
{ "token": "...", "expires_in": 43200, "user": { "id": "...", "role": "admin" } }
```

Then `Authorization: Bearer <token>`. With OIDC configured the provider
issues the token instead and `/api/auth/login` refuses; `GET /api/auth/mode`
says which is in force.

| Method | Path               | Purpose                        |
| ------ | ------------------ | ------------------------------ |
| GET    | `/api/auth/mode`   | how this conductor authenticates |
| POST   | `/api/auth/login`  | sign in, built-in accounts only |
| POST   | `/api/auth/logout` | clear the cookie               |
| GET    | `/api/auth/me`     | the current user               |

Triggers
--------

```
POST /api/trigger/:project
```

Accepts the payload from `hooks/post-receive`, and the push events of
GitHub, Gitea and GitLab. Signed with the project's trigger secret:
`X-Hub-Signature-256: sha256=<hmac>` over the exact request body, or
`X-Gitlab-Token`.

```json
{ "sha": "<40 hex>", "base": "<40 hex or empty>", "ref": "refs/heads/main", "actor": "alice" }
```

Nothing in the payload is trusted beyond which commit to read. The pipeline
comes from the repository at that commit.

| Status | Meaning                                       |
| ------ | --------------------------------------------- |
| 200    | run created, or ignored for a branch deletion |
| 401    | signature missing or wrong                    |
| 404    | no such project                               |
| 409    | project disabled                              |
| 422    | the pipeline at that commit is invalid        |

Reading runs
------------

Visible without signing in when the project is public; otherwise to the
owner and to administrators.

| Method | Path                     | Purpose                         |
| ------ | ------------------------ | ------------------------------- |
| GET    | `/api/runs`              | recent runs, `?project=`, `?limit=` |
| GET    | `/api/runs/:id`          | one run with its jobs and edges |
| GET    | `/api/jobs/:id`          | one job with its artifacts      |
| GET    | `/api/jobs/:id/log`      | log bytes, `?offset=`, `?limit=` |
| GET    | `/api/artifacts/:id`     | download, may redirect          |

The log endpoint is built for following along:

| Header           | Meaning                                  |
| ---------------- | ---------------------------------------- |
| `X-Log-Offset`   | where the returned bytes start           |
| `X-Log-Size`     | total bytes available now                |
| `X-Log-Complete` | `true` once the job has finished         |

Poll with `?offset=` set to the previous size until `X-Log-Complete` is
`true`. A job environment is never returned by any of these.

Projects and workers
--------------------

Any signed in user manages what they own; administrators manage everything.

| Method | Path                                      | Purpose                    |
| ------ | ----------------------------------------- | -------------------------- |
| GET    | `/api/retention`                          | server retention defaults  |
| GET    | `/api/projects`                           | projects you may manage    |
| POST   | `/api/projects`                           | register one               |
| GET    | `/api/projects/:id`                       | one project                |
| PATCH  | `/api/projects/:id`                       | `enabled`, `visibility`, `owner_id`, retention |
| DELETE | `/api/projects/:id`                       | remove it and its runs     |
| POST   | `/api/projects/:id/trigger-secret`        | rotate, returns it once    |
| GET    | `/api/projects/:id/variables`             | names only, never values   |
| PUT    | `/api/projects/:id/variables/:name`       | set one                    |
| DELETE | `/api/projects/:id/variables/:name`       | remove one                 |
| GET    | `/api/worker-tokens`                      | tokens you may manage      |
| POST   | `/api/worker-tokens`                      | issue one, returned once   |
| PATCH  | `/api/worker-tokens/:id`                  | enable or disable          |
| DELETE | `/api/worker-tokens/:id`                  | revoke                     |
| POST   | `/api/runs/:id/cancel`                    | cancel a running run       |
| POST   | `/api/runs/:id/retry`                     | run the same commit again  |

Creating a project returns the trigger secret, and creating a worker token
returns the token. Neither can be read back afterwards; rotate or reissue.

Retention is set with `artifact_keep_runs`, `artifact_keep_days` and
`log_keep_days`. Null follows the server default, zero keeps forever, and
a number is a count of runs or of days. `GET /api/retention` reports what
a null resolves to. See [deployment.md](deployment.md) for how the two
artifact rules combine.

`owner_id` may only be changed by an administrator, and only an
administrator can create a shared worker (`{"shared": true}`), which is one
that accepts jobs from any project rather than from one owner.

Administration
--------------

Administrator role required.

| Method | Path                           | Purpose                        |
| ------ | ------------------------------ | ------------------------------ |
| GET    | `/api/admin/users`             | all accounts                   |
| POST   | `/api/admin/users`             | create one                     |
| PATCH  | `/api/admin/users/:id`         | `password`, `role`, `disabled` |
| GET    | `/api/admin/users/:id/impact`  | what deleting it would destroy |
| DELETE | `/api/admin/users/:id`         | delete it and everything it owns |

Deleting an account deletes the projects and worker tokens it owned, and
the run history of those projects. Ask `/impact` first. The last
administrator cannot be deleted, demoted or disabled.

The worker API
--------------

Documented because a worker is a normal client of it, and anyone may write
another. Every call needs `Authorization: Bearer <worker token>`, and a
worker may only touch a job it currently holds.

| Method | Path                                     | Purpose                     |
| ------ | ---------------------------------------- | --------------------------- |
| GET    | `/api/workers/poll`                      | claim work, 204 when idle   |
| GET    | `/api/workers/jobs/:id/source.tar.gz`    | the tree at the commit      |
| POST   | `/api/workers/jobs/:id/log`              | append output               |
| POST   | `/api/workers/jobs/:id/artifact`         | upload one file             |
| POST   | `/api/workers/jobs/:id/heartbeat`        | stay alive, learn of cancellation |
| POST   | `/api/workers/jobs/:id/done`             | report the outcome          |

Poll with `?arches=x86_64,aarch64&features=dind,sign-key&name=my-worker`.
Only jobs whose architecture the worker offers and whose `requires` it
satisfies are handed out. A worker owned by a user is only offered that
user's projects.

A claimed job carries everything needed to run it: image, script,
environment, services, artifact patterns, timeout, where to fetch the
source, and absolute URLs for the calls above.

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

`done` reports the outcome. A failure with attempts remaining requeues the
job; otherwise everything downstream of it is skipped.
