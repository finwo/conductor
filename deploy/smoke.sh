#!/bin/sh
# deploy/smoke.sh - build the images and run a pipeline through them
#
# Checks the thing people actually deploy, rather than the code the tests
# import: both images build, the conductor starts on an empty volume,
# a worker registers, and a real pipeline runs to completion with its log
# and artifact readable afterwards.
#
# Usage: deploy/smoke.sh [--keep]
#
#   --keep  leave the stack running afterwards for poking at
#
# Needs docker and a few hundred megabytes of disk. Takes about a minute.

set -eu

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK=$(mktemp -d)
PORT="${SMOKE_PORT:-18500}"
PROJECT=conductor-smoke
SECRET=smoke-trigger-secret

# Published ports live on the docker host, which is the gateway when this
# runs in a container, as it does in CI.
if [ -z "${SMOKE_HOST:-}" ] && [ -f /.dockerenv ]; then
  SMOKE_HOST=$(ip route 2>/dev/null | awk '/^default/{print $3; exit}')
fi
SMOKE_HOST="${SMOKE_HOST:-127.0.0.1}"



log()  { printf '\n== %s\n' "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

cleanup() {
  status=$?
  if [ "${KEEP}" -eq 1 ] && [ "${status}" -eq 0 ]; then
    printf '\nleaving the stack up; tear it down with:\n'
    printf '  docker compose -p %s -f %s down -v\n' "${PROJECT}" "${WORK}/compose.yml"
    return
  fi
  printf '\n== cleaning up\n'
  SMOKE_TOKEN=unused docker compose -p "${PROJECT}" -f "${WORK}/compose.yml" down -v >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

log "building images"
docker build -q -f "${ROOT}/deploy/Dockerfile" -t conductor:smoke "${ROOT}"
docker build -q -f "${ROOT}/deploy/Dockerfile.worker" -t conductor-worker:smoke "${ROOT}"

log "preparing a repository"
mkdir -p "${WORK}/repo"
cat > "${WORK}/repo/.conductor.yml" <<'PIPELINE'
version: 1
visibility: public
defaults:
  image: alpine:3
tasks:
  build:
    script:
      - echo "run $CONDUCTOR_JOB_NUMBER of $CONDUCTOR_PROJECT"
      - mkdir -p out && echo "packaged" > out/result.txt
    artifacts:
      paths: [out/**]
  publish:
    needs: [build]
    script: ['echo published']
  release:
    needs: [build]
    only:
      refs: [refs/heads/main]
    script: ['echo released']
PIPELINE
echo 'smoke test repository' > "${WORK}/repo/README.md"
git -C "${WORK}/repo" init -q -b main
git -C "${WORK}/repo" config user.email smoke@example.invalid
git -C "${WORK}/repo" config user.name Smoke
git -C "${WORK}/repo" add -A
git -C "${WORK}/repo" commit -q -m 'smoke test'
SHA=$(git -C "${WORK}/repo" rev-parse HEAD)

cat > "${WORK}/compose.yml" <<COMPOSE
name: ${PROJECT}
services:
  conductor:
    image: conductor:smoke
    ports: ["${PORT}:9080"]
    environment:
      CONDUCTOR_PORT: "9080"
      CONDUCTOR_PUBLIC_URL: http://conductor:9080
      CONDUCTOR_SESSION_SECRET: smoke-session-secret
      CONDUCTOR_ADMIN_PASSWORD: smoke-admin-password
    volumes:
      - smoke-data:/data
  worker:
    image: conductor-worker:smoke
    depends_on: [conductor]
    environment:
      CONDUCTOR_URL: http://conductor:9080
      CONDUCTOR_WORKER_NAME: smoke-worker
      CONDUCTOR_WORKER_TOKEN: "\${SMOKE_TOKEN}"
      CONDUCTOR_WORKER_CONCURRENCY: "2"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
volumes:
  smoke-data:
COMPOSE

compose() { SMOKE_TOKEN="${SMOKE_TOKEN:-unused}" docker compose -p "${PROJECT}" -f "${WORK}/compose.yml" "$@"; }

log "starting the conductor"
compose up -d conductor

BASE_URL="http://${SMOKE_HOST}:${PORT}"
printf 'using %s\n' "${BASE_URL}"

i=0
while [ "${i}" -lt 60 ]; do
  curl -fsS -m 2 "${BASE_URL}/health" >/dev/null 2>&1 && break
  i=$((i + 1))
  sleep 1
done
if [ "${i}" -ge 60 ]; then
  compose logs conductor | tail -40
  fail "the conductor did not become healthy"
fi
curl -fsS "${BASE_URL}/health"
printf '\n'

# Copied rather than bind mounted: the daemon resolves a mount source on the
# host, where a path made in this container does not exist.
log "copying the repository into the conductor"
CONDUCTOR_CID=$(compose ps -q conductor)
[ -n "${CONDUCTOR_CID}" ] || fail "the conductor container is not running"
docker cp "${WORK}/repo" "${CONDUCTOR_CID}:/repo"
# docker cp writes as root; git refuses a repository owned by somebody else.
docker exec -u 0 "${CONDUCTOR_CID}" chown -R conductor:conductor /repo
compose exec -T conductor git -C /repo rev-parse HEAD >/dev/null \
  || fail "the copied repository is not readable inside the conductor"

log "registering the project and a worker"
compose exec -T conductor node src/admin-cli.js project:add demo /repo --secret "${SECRET}" >/dev/null
SMOKE_TOKEN=$(compose exec -T conductor node src/admin-cli.js token:add smoke-worker | awk '/token:/{print $2}')
[ -n "${SMOKE_TOKEN}" ] || fail "no worker token was issued"
export SMOKE_TOKEN

log "starting the worker"
compose up -d worker

log "triggering a job"
BODY=$(printf '{"sha":"%s","ref":"refs/heads/main"}' "${SHA}")
SIG=$(printf '%s' "${BODY}" | openssl dgst -sha256 -hmac "${SECRET}" | sed 's/^.*[= ]//')
RESPONSE=$(curl -fsS -X POST "${BASE_URL}/api/v1/projects/demo/trigger" \
  -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: sha256=${SIG}" \
  -d "${BODY}")
printf '%s\n' "${RESPONSE}"

JOB=$(printf '%s' "${RESPONSE}" | sed 's/.*"job_id":"\([^"]*\)".*/\1/')
[ -n "${JOB}" ] || fail "no job was created"

# The job state is the first badge on the job page. A job still being
# compiled is not readable yet, so a refusal is just another turn.
job_state() {
  curl -fsS "${BASE_URL}/jobs/$1" 2>/dev/null \
    | sed -n 's/.*class="badge \([a-z]*\)".*/\1/p' | head -1
}

# A pipeline that fails to compile is recorded on the job row and nowhere
# else, and leaves the job private, which reads here as a 404.
job_row() {
  compose exec -T conductor node --input-type=module -e "
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.env.CONDUCTOR_DATABASE_PATH);
    const row = db.prepare('SELECT state, visibility, error FROM jobs WHERE id = ?').get('$1');
    console.log(JSON.stringify(row));
  " 2>/dev/null || true
}

log "waiting for the job to finish"
STATE_NOW=
i=0
while [ "${i}" -lt 90 ]; do
  STATE_NOW=$(job_state "${JOB}")
  case "${STATE_NOW}" in
    success|failed|cancelled) break ;;
  esac
  # An unreadable job page does not become readable by waiting it out.
  if [ -z "${STATE_NOW}" ] && [ "${i}" -ge 10 ]; then
    printf 'the job page stayed unreadable\njob row: %s\n' "$(job_row "${JOB}")" >&2
    compose logs conductor | tail -20 >&2
    fail "the job never became readable"
  fi
  i=$((i + 1))
  sleep 1
done

printf 'job %s finished as %s after %ss\n' "${JOB}" "${STATE_NOW}" "${i}"
[ "${STATE_NOW}" = success ] || {
  printf 'job row: %s\n' "$(job_row "${JOB}")"
  compose logs worker | tail -30
  fail "the job ended as ${STATE_NOW}"
}

log "checking the log and the artifact"
# Task ids carry no structure, so the build task is found by following the
# link from the job page rather than by assembling an id.
TASK=$(curl -fsS "${BASE_URL}/jobs/${JOB}" \
  | sed -n 's#.*href="/tasks/\([^"]*\)">build<.*#\1#p' | head -1)
[ -n "${TASK}" ] || fail "no build task was linked from the job page"

PAGE=$(curl -fsS "${BASE_URL}/tasks/${TASK}")
printf '%s\n' "${PAGE}" | grep -q 'run 1 of demo' || fail "the task environment did not reach the script"

ARTIFACT_PATH=$(printf '%s' "${PAGE}" \
  | sed -n 's#.*href="\(/api/v1/[^"]*/artifacts/[^"]*\)".*#\1#p' | head -1)
[ -n "${ARTIFACT_PATH}" ] || fail "no artifact was recorded"

CONTENT=$(curl -fsSL "${BASE_URL}${ARTIFACT_PATH}")
printf 'artifact contents: %s\n' "${CONTENT}"
[ "${CONTENT}" = packaged ] || fail "the artifact did not round trip"

log "reading the task back through the api"
# Both paths describe a public task to anyone, with no credential at all.
# The absence of the environment is the point of the endpoint, so it is
# checked here against the running image rather than trusted from the unit
# tests: the pipeline above puts CONDUCTOR_PROJECT in the script, so a
# response carrying it would mean the environment had escaped.
for URL in "/api/v1/tasks/${TASK}" "/api/v1/projects/demo/tasks/${TASK}"; do
  BODY=$(curl -fsS "${BASE_URL}${URL}") || fail "${URL} was not readable"

  printf '%s' "${BODY}" | grep -q '"state":"success"' \
    || fail "${URL} did not report the task state"
  printf '%s' "${BODY}" | grep -q '"path":"out/result.txt"' \
    || fail "${URL} did not list the artifact"
  printf '%s' "${BODY}" | grep -q '"url":"http' \
    || fail "${URL} did not offer a download url"

  if printf '%s' "${BODY}" | grep -q 'CONDUCTOR_PROJECT'; then
    fail "${URL} leaked the task environment"
  fi
  if printf '%s' "${BODY}" | grep -q '"script"'; then
    fail "${URL} leaked the task script"
  fi
done

log "checking the interface"
curl -fsS "${BASE_URL}/" | grep -q 'conductor' || fail "the interface did not render"

# The release task is restricted to main. A push to anything else must not
# produce it at all, rather than produce it and skip it, since a skipped
# task fails the job.
log "checking that a branch push leaves the restricted task out"
BRANCH_BODY=$(printf '{"sha":"%s","ref":"refs/heads/feature"}' "${SHA}")
BRANCH_SIG=$(printf '%s' "${BRANCH_BODY}" | openssl dgst -sha256 -hmac "${SECRET}" | sed 's/^.*[= ]//')
BRANCH=$(curl -fsS -X POST "${BASE_URL}/api/v1/projects/demo/trigger" \
  -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: sha256=${BRANCH_SIG}" \
  -d "${BRANCH_BODY}")
printf '%s\n' "${BRANCH}"

BRANCH_JOB=$(printf '%s' "${BRANCH}" | sed 's/.*"job_id":"\([^"]*\)".*/\1/')
[ -n "${BRANCH_JOB}" ] || fail "no branch job was created"

i=0
while [ "${i}" -lt 90 ]; do
  BRANCH_STATE=$(job_state "${BRANCH_JOB}")
  case "${BRANCH_STATE}" in
    success|failed|cancelled) break ;;
  esac
  i=$((i + 1))
  sleep 1
done

# The trigger only records the job, so the tasks are counted off the
# finished job rather than the response.
BRANCH_PAGE=$(curl -fsS "${BASE_URL}/jobs/${BRANCH_JOB}")
BRANCH_TASKS=$(printf '%s' "${BRANCH_PAGE}" | grep -c 'href="/tasks/')
[ "${BRANCH_TASKS}" -eq 2 ] \
  || fail "expected 2 tasks on a branch, got ${BRANCH_TASKS}"

printf '%s' "${BRANCH_PAGE}" | grep -q '>release<' \
  && fail "the release task should not exist on a branch job"

printf 'branch job finished as %s with %s tasks and no release task\n' \
  "${BRANCH_STATE}" "${BRANCH_TASKS}"
[ "${BRANCH_STATE}" = success ] || fail "the branch job ended as ${BRANCH_STATE}"

printf '\nPASSED\n'
