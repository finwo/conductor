// src/worker/source.js - getting the tree into the task container
//
// The conductor serves a tarball of the exact commit a task was created
// for. The worker never sees a repository, holds no credentials for one,
// and cannot reach any ref other than the one it was given work for.
//
// The tarball goes straight from the conductor into the container: it is
// decompressed in flight and handed to docker cp, so it is never written
// to the worker's disk and never sits in a directory shared with the
// container. That is what lets a worker run with no mounts at all.
//
// docker creates the destination as it extracts, including any missing
// parents, so the tree can be delivered to a path the image has never
// heard of without preparing anything first.

import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

export async function sourceIntoContainer({ client, runtime, task, container, workdir }) {
  const url = task.endpoints?.source;
  if (!url) throw new Error('the task carries no source endpoint');

  const body = await client.source(url);
  const stream = body instanceof Readable ? body : Readable.fromWeb(body);

  // Decompressed on this side, because docker cp takes a plain tar and
  // the container has no shell of its own to unpack anything with.
  await runtime.copyStreamIn(container, stream.pipe(createGunzip()), workdir);
}
