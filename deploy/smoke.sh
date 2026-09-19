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
docker build -q -f "${ROOT}/deploy/Dockerfile" -t conductor:smoke "${ROOT}" >/dev/null
docker build -q -f "${ROOT}/deploy/Dockerfile.worker" -t conductor-worker:smoke "${ROOT}" >/dev/null

log "preparing a repository"
mkdir -p "${WORK}/repo"
cat > "${WORK}/repo/.conductor.yml" <<'PIPELINE'
version: 1
visibility: public
defaults:
  image: alpine:3
jobs:
  build:
    script:
      - echo "run $CONDUCTOR_RUN_NUMBER of $CONDUCTOR_PROJECT"
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
    ports: ["${PORT}:8080"]
    environment:
      CONDUCTOR_PUBLIC_URL: http://conductor:8080
      CONDUCTOR_SESSION_SECRET: smoke-session-secret
      CONDUCTOR_ADMIN_PASSWORD: smoke-admin-password
    volumes:
      - smoke-data:/data
      - ${WORK}/repo:/repo:ro
  worker:
    image: conductor-worker:smoke
    depends_on: [conductor]
    environment:
      CONDUCTOR_URL: http://conductor:8080
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
compose up -d conductor >/dev/null 2>&1

i=0
while [ "${i}" -lt 60 ]; do
  curl -fsS -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  i=$((i + 1))
  sleep 1
done
[ "${i}" -lt 60 ] || fail "the conductor did not become healthy"
curl -fsS "http://127.0.0.1:${PORT}/health"
printf '\n'

log "registering the project and a worker"
compose exec -T conductor node src/admin-cli.js project:add demo /repo --secret "${SECRET}" >/dev/null
SMOKE_TOKEN=$(compose exec -T conductor node src/admin-cli.js token:add smoke-worker | awk '/token:/{print $2}')
[ -n "${SMOKE_TOKEN}" ] || fail "no worker token was issued"
export SMOKE_TOKEN

log "starting the worker"
compose up -d worker >/dev/null 2>&1

log "triggering a run"
BODY=$(printf '{"sha":"%s","ref":"refs/heads/main"}' "${SHA}")
SIG=$(printf '%s' "${BODY}" | openssl dgst -sha256 -hmac "${SECRET}" | sed 's/^.*[= ]//')
RESPONSE=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/api/trigger/demo" \
  -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: sha256=${SIG}" \
  -d "${BODY}")
printf '%s\n' "${RESPONSE}"

RUN=$(printf '%s' "${RESPONSE}" | sed 's/.*"run_id":"\([^"]*\)".*/\1/')
[ -n "${RUN}" ] || fail "no run was created"

log "waiting for the run to finish"
STATE_NOW=
i=0
while [ "${i}" -lt 90 ]; do
  STATE_NOW=$(curl -fsS "http://127.0.0.1:${PORT}/api/runs/${RUN}" | sed 's/.*"state":"\([^"]*\)".*/\1/')
  case "${STATE_NOW}" in
    success|failed|cancelled) break ;;
  esac
  i=$((i + 1))
  sleep 1
done

printf 'run %s finished as %s after %ss\n' "${RUN}" "${STATE_NOW}" "${i}"
[ "${STATE_NOW}" = success ] || {
  compose logs worker | tail -30
  fail "the run ended as ${STATE_NOW}"
}

log "checking the log and the artifact"
JOB="${RUN}:build"
ENCODED=$(printf '%s' "${JOB}" | sed 's/:/%3A/g')

LOG=$(curl -fsS "http://127.0.0.1:${PORT}/api/jobs/${ENCODED}/log")
printf '%s\n' "${LOG}"
printf '%s' "${LOG}" | grep -q 'run 1 of demo' || fail "the job environment did not reach the script"

ARTIFACT=$(curl -fsS "http://127.0.0.1:${PORT}/api/jobs/${ENCODED}" \
  | sed 's/.*"artifacts":\[{"id":"\([^"]*\)".*/\1/')
[ -n "${ARTIFACT}" ] || fail "no artifact was recorded"

CONTENT=$(curl -fsSL "http://127.0.0.1:${PORT}/api/artifacts/${ARTIFACT}")
printf 'artifact contents: %s\n' "${CONTENT}"
[ "${CONTENT}" = packaged ] || fail "the artifact did not round trip"

log "checking the interface"
curl -fsS "http://127.0.0.1:${PORT}/" | grep -q 'conductor' || fail "the interface did not render"

# The release job is restricted to main. A push to anything else must not
# produce it at all, rather than produce it and skip it, since a skipped
# job fails the run.
log "checking that a branch push leaves the restricted job out"
BRANCH_BODY=$(printf '{"sha":"%s","ref":"refs/heads/feature"}' "${SHA}")
BRANCH_SIG=$(printf '%s' "${BRANCH_BODY}" | openssl dgst -sha256 -hmac "${SECRET}" | sed 's/^.*[= ]//')
BRANCH=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/api/trigger/demo" \
  -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: sha256=${BRANCH_SIG}" \
  -d "${BRANCH_BODY}")
printf '%s\n' "${BRANCH}"

printf '%s' "${BRANCH}" | grep -q '"jobs":2' \
  || fail "expected 2 jobs on a branch, got: ${BRANCH}"

BRANCH_RUN=$(printf '%s' "${BRANCH}" | sed 's/.*"run_id":"\([^"]*\)".*/\1/')
i=0
while [ "${i}" -lt 90 ]; do
  BRANCH_STATE=$(curl -fsS "http://127.0.0.1:${PORT}/api/runs/${BRANCH_RUN}" | sed 's/.*"state":"\([^"]*\)".*/\1/')
  case "${BRANCH_STATE}" in
    success|failed|cancelled) break ;;
  esac
  i=$((i + 1))
  sleep 1
done

curl -fsS "http://127.0.0.1:${PORT}/api/runs/${BRANCH_RUN}" | grep -q '"release"' \
  && fail "the release job should not exist on a branch run"

printf 'branch run finished as %s without the release job\n' "${BRANCH_STATE}"
[ "${BRANCH_STATE}" = success ] || fail "the branch run ended as ${BRANCH_STATE}"

printf '\nPASSED\n'
