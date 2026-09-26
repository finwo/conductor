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
# Every run names its own compose project, images and port, so several can
# run against one docker host at once. SMOKE_PORT pins the port if needed.
#
# Needs docker and a few hundred megabytes of disk. Takes about a minute.

set -eu

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK=$(mktemp -d)
SECRET=smoke-trigger-secret

# Everything that a second run on the same host could collide on carries
# this: the compose project owns the network, volume and container names,
# and the image tags would otherwise be overwritten mid-run by a build of
# a different commit.
RUN=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
PROJECT="conductor-smoke-${RUN}"
IMAGE="conductor:smoke-${RUN}"
WORKER_IMAGE="conductor-worker:smoke-${RUN}"

# 0 lets docker pick a free port; the real one is read back once the
# container is up. Picking one here would race with whoever takes it next.
PORT="${SMOKE_PORT:-0}"

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
  docker rmi "${IMAGE}" "${WORKER_IMAGE}" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

log "building images"
docker build -q -f "${ROOT}/deploy/Dockerfile" -t "${IMAGE}" "${ROOT}"
docker build -q -f "${ROOT}/deploy/Dockerfile.worker" -t "${WORKER_IMAGE}" "${ROOT}"

log "preparing a repository"
mkdir -p "${WORK}/repo"
cat > "${WORK}/repo/.conductor.yml" <<'PIPELINE'
version: 1
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
    image: ${IMAGE}
    ports: ["${PORT}:9080"]
    environment:
      CONDUCTOR_PORT: "9080"
      CONDUCTOR_PUBLIC_URL: http://conductor:9080
      CONDUCTOR_SESSION_SECRET: smoke-session-secret
      CONDUCTOR_ADMIN_PASSWORD: smoke-admin-password
    volumes:
      - smoke-data:/data
  worker:
    image: ${WORKER_IMAGE}
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

# Ask docker which port it settled on rather than assuming, since PORT is
# normally 0.
PUBLISHED=$(compose port conductor 9080 | sed 's/.*://')
[ -n "${PUBLISHED}" ] || fail "the conductor published no port"
BASE_URL="http://${SMOKE_HOST}:${PUBLISHED}"
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
compose exec -T conductor node src/admin-cli.js project:add demo /repo --secret "${SECRET}" --visibility public >/dev/null
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

# A job still being compiled is not readable yet, so a refusal is just
# another turn.
job_state() {
  curl -fsS "${BASE_URL}/api/v1/jobs/$1" 2>/dev/null \
    | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p' | head -1
}

# One object per line, so a task can be matched on its name and read for
# its id without depending on which order the keys came out in.
objects() { printf '%s' "$1" | tr '{' '\n'; }

task_id() {
  objects "$1" | grep "\"name\":\"$2\"" | sed 's/.*"id":"\([^"]*\)".*/\1/' | head -1
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
# Task ids carry no structure, so the build task is found by name in the
# job's task list rather than by assembling an id.
TASKS=$(curl -fsS "${BASE_URL}/api/v1/jobs/${JOB}/tasks")
TASK=$(task_id "${TASKS}" build)
[ -n "${TASK}" ] || fail "no build task was listed for the job"

# The edges are what a stage graph is drawn from, and nothing else
# publishes them.
printf '%s' "${TASKS}" | grep -q '"depends_on_id"' \
  || fail "the task list carried no dependency edges"

LOG=$(curl -fsS "${BASE_URL}/api/v1/tasks/${TASK}/log")
printf '%s' "${LOG}" | grep -q 'run 1 of demo' \
  || fail "the task environment did not reach the script"
printf '%s' "${LOG}" | grep -q '"expired":false' \
  || fail "the log did not report whether it had expired"

ARTIFACTS=$(curl -fsS "${BASE_URL}/api/v1/tasks/${TASK}/artifacts")
printf '%s' "${ARTIFACTS}" | grep -q '"path":"out/result.txt"' \
  || fail "the artifact was not listed"

ARTIFACT_URL=$(printf '%s' "${ARTIFACTS}" | sed -n 's#.*"url":"\([^"]*\)".*#\1#p' | head -1)
[ -n "${ARTIFACT_URL}" ] || fail "no artifact download url was offered"

# The url is built from public_url, which is the conductor's own name on
# the compose network rather than the published port this runs against.
ARTIFACT_PATH=$(printf '%s' "${ARTIFACT_URL}" | sed 's#^https\{0,1\}://[^/]*##')
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

  if printf '%s' "${BODY}" | grep -q 'CONDUCTOR_PROJECT'; then
    fail "${URL} leaked the task environment"
  fi
  if printf '%s' "${BODY}" | grep -q '"script"'; then
    fail "${URL} leaked the task script"
  fi
done

# Naming a project that does not own the task must not widen anything.
curl -fsS -o /dev/null "${BASE_URL}/api/v1/projects/absent/tasks/${TASK}" 2>/dev/null \
  && fail "a task was readable through a project that does not own it"

log "signing in"
# The whole flow against the shipped image: discovery, the login page, a
# code, a token, and a call that needs it.
DISCOVERY=$(curl -fsS "${BASE_URL}/.well-known/openid-configuration")
printf '%s' "${DISCOVERY}" | grep -q '"client_id":"conductor"' \
  || fail "discovery did not name the client"

REDIRECT="http://conductor:9080/"
VERIFIER=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
CHALLENGE=$(printf '%s' "${VERIFIER}" \
  | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=\n')

AUTHORIZE="${BASE_URL}/auth/authorize?response_type=code&client_id=conductor"
AUTHORIZE="${AUTHORIZE}&redirect_uri=http%3A%2F%2Fconductor%3A9080%2F"
AUTHORIZE="${AUTHORIZE}&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=smoke"

curl -fsS "${AUTHORIZE}" | grep -q 'name="password"' \
  || fail "the login page was not served"

LOCATION=$(curl -sS -o /dev/null -w '%{redirect_url}' -X POST "${AUTHORIZE}" \
  -d 'username=admin&password=smoke-admin-password')
CODE=$(printf '%s' "${LOCATION}" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
[ -n "${CODE}" ] || fail "signing in produced no authorization code"

GRANT=$(curl -fsS -X POST "${BASE_URL}/auth/token" \
  -d "grant_type=authorization_code&code=${CODE}&code_verifier=${VERIFIER}&redirect_uri=${REDIRECT}")
ACCESS=$(printf '%s' "${GRANT}" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
REFRESH=$(printf '%s' "${GRANT}" | sed -n 's/.*"refresh_token":"\([^"]*\)".*/\1/p')
[ -n "${ACCESS}" ] || fail "no access token was issued"

curl -fsS "${BASE_URL}/api/v1/users/me" -H "Authorization: Bearer ${ACCESS}" \
  | grep -q '"username":"admin"' || fail "the access token did not identify the administrator"

# The session is listed with what it was last used from, which is the
# whole point of the revocation screen.
curl -fsS "${BASE_URL}/api/v1/sessions" -H "Authorization: Bearer ${ACCESS}" \
  | grep -q '"user_agent":"curl' || fail "the session was not listed"

# Redeeming a code twice must not work.
curl -fsS -o /dev/null -X POST "${BASE_URL}/auth/token" \
  -d "grant_type=authorization_code&code=${CODE}&code_verifier=${VERIFIER}&redirect_uri=${REDIRECT}" 2>/dev/null \
  && fail "an authorization code was redeemed twice"

# An unregistered origin is refused rather than redirected to.
curl -fsS -o /dev/null "${BASE_URL}/auth/authorize?response_type=code&client_id=conductor&redirect_uri=https%3A%2F%2Fevil.example%2F&code_challenge=${CHALLENGE}&code_challenge_method=S256" 2>/dev/null \
  && fail "an unregistered redirect uri was accepted"

# Refreshing keeps the same token and issues a new access token.
SECOND=$(curl -fsS -X POST "${BASE_URL}/auth/token" \
  -d "grant_type=refresh_token&refresh_token=${REFRESH}")
printf '%s' "${SECOND}" | grep -q "\"refresh_token\":\"${REFRESH}\"" \
  || fail "refreshing did not keep the refresh token"

log "checking the application"
INDEX=$(curl -fsS "${BASE_URL}/")
printf '%s' "${INDEX}" | grep -q '<title>conductor</title>' \
  || fail "the application index was not served"
BUNDLE=$(printf '%s' "${INDEX}" | sed -n 's/.*<script src="\([^"]*\)".*/\1/p' | head -1)
[ -n "${BUNDLE}" ] || fail "the application index referenced no bundle"
curl -fsS -o /dev/null "${BASE_URL}/${BUNDLE}" || fail "the bundle ${BUNDLE} was not served"

# The policy is what keeps a refresh token in local storage out of reach of
# an injected script, so its absence is a finding rather than a detail.
curl -fsS -D - -o /dev/null "${BASE_URL}/" | grep -qi 'content-security-policy' \
  || fail "the application was served without a content security policy"

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
BRANCH_LIST=$(curl -fsS "${BASE_URL}/api/v1/jobs/${BRANCH_JOB}/tasks")
BRANCH_TASKS=$(objects "${BRANCH_LIST}" | grep -c '"name":"')
[ "${BRANCH_TASKS}" -eq 2 ] \
  || fail "expected 2 tasks on a branch, got ${BRANCH_TASKS}"

printf '%s' "${BRANCH_LIST}" | grep -q '"name":"release"' \
  && fail "the release task should not exist on a branch job"

printf 'branch job finished as %s with %s tasks and no release task\n' \
  "${BRANCH_STATE}" "${BRANCH_TASKS}"
[ "${BRANCH_STATE}" = success ] || fail "the branch job ended as ${BRANCH_STATE}"

printf '\nPASSED\n'
