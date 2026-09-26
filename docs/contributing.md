Contributing
============

Layout
------

```
git push -> post-receive -> conductor -> task graph in the database
                                |
                          worker polls
                                |
             source tarball, container, log stream, artifacts
```

  - `src/conductor` triggers, scheduling, the API, the login provider
  - `src/worker`    the agent that runs tasks, with no npm dependencies
  - `src/lib`       configuration, database, storage, pipelines, git
  - `web`           the application, a mithril client of the API

Queries are written once against all three databases using named `{key}`
markers, which each driver compiles to its own placeholder syntax.
Timestamps are epoch milliseconds everywhere.

Testing
-------

```sh
npm test
```

That is the whole setup. With docker available the suite starts what it
needs and cleans up after itself:

| Dependency          | Used for                                           |
| ------------------- | -------------------------------------------------- |
| `alpine`            | containers for the worker to actually run tasks in |
| MinIO               | object storage, artifacts and archived logs        |
| mock-oauth2-server  | a real OIDC provider to authenticate against       |

Nothing is stubbed, because the failures worth catching live in the parts a
stub would replace. Hand written SigV4 signing is only meaningfully tested
by a server that rejects a bad signature, and the JWKS path was wrong
against every provider except the one it was written for.

Without docker those tests skip and the rest still run:

```sh
CONDUCTOR_TEST_NO_DOCKER=1 npm test
```

To test against a different object store, such as Garage or AWS, point the
same tests at it instead of starting MinIO:

```sh
docker run -d -p 9000:9000 -e MINIO_ROOT_USER=testkey \
  -e MINIO_ROOT_PASSWORD=testsecret123 quay.io/minio/minio server /data

CONDUCTOR_TEST_S3_ENDPOINT=http://127.0.0.1:9000 \
CONDUCTOR_TEST_S3_KEY=testkey \
CONDUCTOR_TEST_S3_SECRET=testsecret123 npm test
```

Building
--------

The application is built separately; the container image builds it in its
own stage:

```sh
npm run build
```

The icon is geometry rather than an image, drawn at each size it ships in.
Rerun after changing `util/icon.js`, then rebuild:

```sh
npm run icon
```
