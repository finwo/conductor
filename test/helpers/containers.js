// test/helpers/containers.js - cleaning up after jobs that crashed
//
// A test job that is killed never reaches its cleanup hook and leaves its
// containers behind, so each helper tidies up before it starts.
//
// Doing that by name prefix alone is wrong, and was: node --test jobs
// test files in parallel processes, two files each start their own MinIO,
// and whichever starts second force-removes the container the first is
// using. The first then waits out its whole timeout and fails with the
// container gone from under it. That showed up as a flake under load,
// which is exactly the wrong thing to go looking for.
//
// So age is the thing that makes a container stale, not its name. A
// sibling that started seconds ago is left alone; a leftover from a job
// that died half an hour ago is removed.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Comfortably longer than any test takes, comfortably shorter than the
// gap between one job and the next.
export const STALE_AGE = 30 * 60 * 1000;

export async function reapStale(prefix, maxAgeMs = STALE_AGE) {
  try {
    const { stdout } = await execFileAsync(
      'docker', ['ps', '-aq', '--filter', `name=${prefix}`], { timeout: 30000 },
    );
    const ids = stdout.trim().split('\n').filter(Boolean);
    if (ids.length === 0) return;

    // One call for all of them; .Created is RFC3339 and parses directly.
    const { stdout: detail } = await execFileAsync(
      'docker', ['inspect', '--format', '{{.Id}} {{.Created}}', ...ids], { timeout: 30000 },
    );

    const cutoff = Date.now() - maxAgeMs;
    const stale = detail.trim().split('\n')
      .map((line) => line.split(' '))
      .filter(([, created]) => {
        const at = Date.parse(created);
        // A timestamp that will not parse is not grounds for deleting
        // somebody's running container.
        return Number.isFinite(at) && at < cutoff;
      })
      .map(([id]) => id);

    if (stale.length > 0) {
      await execFileAsync('docker', ['rm', '-f', ...stale], { timeout: 60000 });
    }
  } catch {
    // Best effort. A failure here must not fail the tests, and whatever
    // is wrong will be reported more usefully by the start that follows.
  }
}
