#!/bin/sh
# deploy/publish.sh - build and push the images to Docker Hub
#
# Run by the publish job in .conductor.yml, which restricts it to main and
# to release tags. Safe to run by hand for a dry run.
#
# What gets pushed, from CONDUCTOR_REF:
#
#   refs/heads/main    finwo/conductor:main   and :latest
#   refs/heads/topic   finwo/conductor:topic
#   refs/tags/v1.2.0   finwo/conductor:1.2.0  and :1.2
#
# A branch publishes its own name. main carries :latest on top of that,
# and nothing else ever moves it, so :latest is always what main is.
#
# Needs REGISTRY_USERNAME and REGISTRY_TOKEN as project variables. They are
# masked in the log by the conductor, but this still keeps them off the
# command line, where they would show up in a process list.
#
#   DRY_RUN=1  build for the host architecture only, and push nothing

set -eu

: "${CONDUCTOR_REF:?CONDUCTOR_REF is not set}"
: "${CONDUCTOR_SHA:?CONDUCTOR_SHA is not set}"

DRY_RUN="${DRY_RUN:-0}"
CONDUCTOR_IMAGE="${CONDUCTOR_IMAGE:-finwo/conductor}"
WORKER_IMAGE="${WORKER_IMAGE:-finwo/conductor-worker}"

# riscv64 has no node image and no static docker CLI, which is why both
# Dockerfiles are built on Alpine. Everything here is available there.
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64,linux/riscv64}"

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SHORT=$(printf '%s' "${CONDUCTOR_SHA}" | cut -c1-12)

log() { printf '\n== %s\n' "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

# A docker tag is [A-Za-z0-9_][A-Za-z0-9._-]*, so a branch such as
# feature/x cannot be used as it stands.
docker_tag() {
    tag=$(printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '-' | cut -c1-128)
    case "${tag}" in
        [!A-Za-z0-9_]*) tag="x${tag}" ;;
    esac
    printf '%s\n' "${tag}"
}

# What a branch publishes on top of its own name. Give another branch an
# alias, a pre-release series for instance, by adding a line here.
branch_aliases() {
    case "$1" in
        main) printf 'latest\n' ;;
    esac
}

# Turns a ref into the list of tags it should publish.
#
# A version tag also publishes the major.minor series, so v1.2.1 moves
# :1.2 as well. Deliberately no bare major: :1 moving across minor
# releases tends to surprise people more than it helps them.
tags_for_ref() {
    ref=$1
    case "${ref}" in
        refs/heads/*)
            branch=${ref#refs/heads/}
            docker_tag "${branch}"
            branch_aliases "${branch}"
            ;;
        refs/tags/v*)
            version=${ref#refs/tags/v}
            case "${version}" in
                *[!0-9.]*)
                    fail "tag ${ref} is not a plain version, refusing to guess what to publish"
                    ;;
            esac
            printf '%s\n' "${version}"
            # v1.2.3 -> 1.2, but v1.2 stays as it is.
            series=$(printf '%s' "${version}" | cut -d. -f1-2)
            [ "${series}" = "${version}" ] || printf '%s\n' "${series}"
            ;;
        *)
            fail "ref ${ref} does not publish anything; the only: rule in .conductor.yml should have prevented this"
            ;;
    esac
}

TAGS=$(tags_for_ref "${CONDUCTOR_REF}")

log "publishing from ${CONDUCTOR_REF} at ${SHORT}"
printf 'tags:\n'
printf '  %s\n' ${TAGS}
printf 'platforms: %s\n' "${PLATFORMS}"

# Collects --tag arguments for one image.
tag_args() {
    image=$1
    for tag in ${TAGS}; do
        printf -- '--tag\n%s:%s\n' "${image}" "${tag}"
    done
}

if [ "${DRY_RUN}" = 1 ]; then
    log "dry run: building for this architecture only, pushing nothing"
    for spec in "deploy/Dockerfile ${CONDUCTOR_IMAGE}" "deploy/Dockerfile.worker ${WORKER_IMAGE}"; do
        # shellcheck disable=SC2086
        set -- ${spec}
        dockerfile=$1
        image=$2
        printf '\n-- %s\n' "${image}"
        docker build -f "${ROOT}/${dockerfile}" -t "${image}:dry-run" "${ROOT}" >/dev/null
        printf 'would push:\n'
        for tag in ${TAGS}; do printf '  %s:%s\n' "${image}" "${tag}"; done
    done
    printf '\nPASSED (dry run)\n'
    exit 0
fi

# In CI the credentials come from project variables. Run by hand on a
# machine where somebody has already signed in, there is nothing to
# supply, and demanding a token again would be busywork.
if [ -n "${REGISTRY_TOKEN:-}" ]; then
    : "${REGISTRY_USERNAME:?REGISTRY_USERNAME is set without REGISTRY_TOKEN}"
    SIGN_IN=1
elif docker system info 2>/dev/null | grep -q '^ *Username:'; then
    SIGN_IN=0
    log "using the existing docker login for $(docker system info 2>/dev/null | sed -n 's/^ *Username: *//p')"
else
    fail "not signed in to a registry, and REGISTRY_TOKEN is not set.
  Either export REGISTRY_USERNAME and REGISTRY_TOKEN, or run:
    docker login -u <user>"
fi

log "registering emulators"
# arm64 and riscv64 are emulated unless the worker is that architecture.
# Without this, buildx cannot run the foreign binaries a build needs.
#
# This reports success even when it achieved nothing: if the host has no
# binfmt_misc mounted, the registrations go into the container's own mount
# namespace and vanish with it. The check further down is what actually
# decides whether emulation works, rather than this command's exit code.
docker run --privileged --rm tonistiigi/binfmt:qemu-v9.2.2 --install all >/dev/null

# Whether the builder can really produce every platform we are asking for.
builder_covers() {
    available=$(docker buildx inspect "$1" 2>/dev/null | sed -n 's/^Platforms:[[:space:]]*//p')
    for want in $(printf '%s' "${PLATFORMS}" | tr ',' ' '); do
        # Commas around the list so linux/arm does not match linux/arm64.
        printf ',%s,' "${available}" | tr -d ' ' | grep -q ",${want}," || return 1
    done
    return 0
}

# Platform coverage is necessary but not sufficient: with the emulators
# registered even the default builder claims every architecture, and then
# refuses the build because the docker driver cannot produce more than one
# platform at a time. The driver is the part that decides.
builder_usable() {
    docker buildx inspect "$1" 2>/dev/null | grep -q '^Driver:[[:space:]]*docker-container' \
        && builder_covers "$1"
}

log "preparing the builder"
# A builder bootstrapped before the emulators were registered does not pick
# them up afterwards, so one that cannot do the job is replaced rather than
# reused.
if docker buildx inspect conductor-publish >/dev/null 2>&1 && ! builder_usable conductor-publish; then
    log "the existing builder cannot do this, replacing it"
    docker buildx rm conductor-publish >/dev/null 2>&1 || true
fi

docker buildx inspect conductor-publish >/dev/null 2>&1 \
    || docker buildx create --name conductor-publish --driver docker-container --bootstrap >/dev/null
docker buildx use conductor-publish

builder_usable conductor-publish || fail "the builder cannot produce ${PLATFORMS}.
  It reports: $(docker buildx inspect conductor-publish 2>/dev/null | sed -n 's/^Platforms:[[:space:]]*//p')
  Emulation is registered through binfmt_misc, which has to be mounted on
  the host running the docker daemon:
    sudo mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc
  Without it the installer above succeeds and registers nothing, and the
  build fails later with 'exec format error'."

if [ "${SIGN_IN}" = 1 ]; then
    log "signing in"
    printf '%s' "${REGISTRY_TOKEN}" | docker login --username "${REGISTRY_USERNAME}" --password-stdin >/dev/null

    # Whatever happens next, do not leave the credentials behind on a
    # worker that is shared with other people's jobs. Only when this
    # script created the session: logging out of one somebody else
    # established would be rude, and on a workstation, baffling.
    cleanup() { docker logout >/dev/null 2>&1 || true; }
    trap cleanup EXIT
fi

log "building and pushing ${CONDUCTOR_IMAGE}"
# shellcheck disable=SC2046
docker buildx build \
    --platform "${PLATFORMS}" \
    --file "${ROOT}/deploy/Dockerfile" \
    $(tag_args "${CONDUCTOR_IMAGE}" | tr '\n' ' ') \
    --push \
    "${ROOT}"

log "building and pushing ${WORKER_IMAGE}"
# shellcheck disable=SC2046
docker buildx build \
    --platform "${PLATFORMS}" \
    --file "${ROOT}/deploy/Dockerfile.worker" \
    $(tag_args "${WORKER_IMAGE}" | tr '\n' ' ') \
    --push \
    "${ROOT}"

# Pushing an image does not touch the repository page, so the readme is
# sent separately or Docker Hub shows nothing at all. Kept next to the
# Dockerfiles so it is reviewed with them rather than edited in a web
# form and forgotten.
#
# Needs an API token rather than the registry session, so this is skipped
# when the script is run against an existing docker login. The release
# itself is done by then, and a stale readme is not worth failing it for.
sync_readme() {
    image=$1
    file=$2
    summary=$3
    repo=${image#*/}
    namespace=${image%%/*}

    [ -f "${file}" ] || { log "no readme at ${file}, skipping"; return 0; }

    if [ -z "${REGISTRY_TOKEN:-}" ]; then
        log "no REGISTRY_TOKEN, leaving the ${image} readme alone"
        return 0
    fi

    if ! command -v curl >/dev/null 2>&1; then
        log "curl is missing, leaving the ${image} readme alone"
        return 0
    fi

    api=$(curl -fsS -X POST https://hub.docker.com/v2/auth/token \
        -H 'Content-Type: application/json' \
        -d "{\"identifier\":\"${REGISTRY_USERNAME}\",\"secret\":\"${REGISTRY_TOKEN}\"}" \
        | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')

    [ -n "${api}" ] || { log "could not get a hub api token, leaving the readme alone"; return 0; }

    # The body is json, so the markdown has to be escaped rather than
    # pasted: it is full of quotes, backslashes and newlines. The summary
    # comes through the environment so awk does the escaping, not the shell.
    payload=$(SUMMARY="${summary}" awk '
        function esc(s) {
            gsub(/\\/, "\\\\", s)
            gsub(/"/, "\\\"", s)
            gsub(/\t/, "\\t", s)
            return s
        }
        BEGIN {
            printf "{"
            # Sending an empty one would clear what is already there.
            summary = esc(ENVIRON["SUMMARY"])
            if (summary != "") printf "\"description\":\"%s\",", summary
            printf "\"full_description\":\""
        }
        { printf "%s\\n", esc($0) }
        END { printf "\"}" }
    ' "${file}")

    if printf '%s' "${payload}" | curl -fsS -X PATCH \
        "https://hub.docker.com/v2/repositories/${namespace}/${repo}/" \
        -H 'Content-Type: application/json' \
        -H "Authorization: Bearer ${api}" \
        --data-binary @- >/dev/null
    then
        log "updated the ${image} readme"
    else
        log "could not update the ${image} readme"
    fi
}

log "updating the repository pages"

# The short description under the image name. Taken from package.json so it
# is not maintained in a web form as well as here. Left alone if it cannot
# be read, rather than failing a release that has already been pushed.
PKG_SUMMARY=$(sed -n 's/.*"description"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' "${ROOT}/package.json" | head -n 1)
[ -n "${PKG_SUMMARY}" ] || log "no description in package.json, leaving the short descriptions alone"

sync_readme "${CONDUCTOR_IMAGE}" "${ROOT}/deploy/hub/conductor.md" "${PKG_SUMMARY}"
sync_readme "${WORKER_IMAGE}" "${ROOT}/deploy/hub/conductor-worker.md" "Worker for conductor: pulls tasks and runs each in its own container"

log "verifying the manifests"
for image in "${CONDUCTOR_IMAGE}" "${WORKER_IMAGE}"; do
    first=$(printf '%s' "${TAGS}" | head -1)
    docker buildx imagetools inspect "${image}:${first}" \
        | grep -i platform \
        || fail "no platforms reported for ${image}:${first}"
done

printf '\nPASSED\n'
