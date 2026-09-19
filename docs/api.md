HTTP API
========

The conductor exposes exactly three HTTP surfaces, all under `/api/v1`.
Everything else, including signing in and managing projects, workers and
users, happens in the interface.

| Surface                              | Authentication        |
| ------------------------------------ | --------------------- |
| `/api/v1/projects/:project/trigger`  | per project HMAC      |
| `/api/v1/workers/jobs`               | worker token          |
| `/api/v1/projects/.../artifacts/...` | session, or anonymous for a public run |

Errors are `{"error": "..."}` with a meaningful status. A resource the
caller may not see returns 404 rather than 403, so absence and denial are
indistinguishable.

Triggers
--------

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

Nothing in the payload is trusted beyond which commit to read. The pipeline
comes from the repository at that commit.

| Status | Meaning                                       |
| ------ | --------------------------------------------- |
| 200    | run created, or ignored for a branch deletion |
| 401    | signature missing or wrong                    |
| 404    | no such project                               |
| 409    | project disabled                              |
| 422    | the pipeline at that commit is invalid        |

The worker API
--------------

Documented because a worker is a normal client of it, and anyone may write
another. Every call needs `Authorization: Bearer <worker token>`, and a
worker may only touch a job it currently holds.

| Method | Path                                            | Purpose                     |
| ------ | ----------------------------------------------- | --------------------------- |
| POST   | `/api/v1/workers/jobs`                          | claim work, 204 when idle   |
| GET    | `/api/v1/workers/jobs/:id/source.tar.gz`        | the tree at the commit      |
| POST   | `/api/v1/workers/jobs/:id/log`                  | append output               |
| POST   | `/api/v1/workers/jobs/:id/artifacts`            | upload one file             |
| POST   | `/api/v1/workers/jobs/:id/heartbeat`            | stay alive, learn of cancellation |
| POST   | `/api/v1/workers/jobs/:id/complete`             | report the outcome          |

Claim with a JSON body: `{"arches":["x86_64","aarch64"],"features":["dind","sign-key"],"name":"my-worker"}`.
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

`complete` reports the outcome. A failure with attempts remaining requeues
the job; otherwise everything downstream of it is skipped.

Artifacts
---------

```
GET /api/v1/projects/:project/runs/:run/jobs/:job/artifacts/:artifact
```

The one read endpoint that is not the interface, so the job page can link
straight at a build's output. The project, run and job in the path must all
agree with the artifact. A public run is downloadable by anyone; a private
one by its owner or an administrator. The response is the bytes, or a
redirect to the object store when it can presign.
