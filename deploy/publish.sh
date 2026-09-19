#!/bin/sh
# deploy/publish.sh - build and push the images to Docker Hub
#
# Run by the publish job in .conductor.yml, which restricts it to main and
# to release tags. Safe to run by hand for a dry run.
#
# What gets pushed, from CONDUCTOR_REF:
#
#   refs/heads/main    finwo/conductor:latest        and :<short sha>
#   refs/tags/v1.2.0   finwo/conductor:1.2.0, :1.2   and :latest
#
# A tag publishes :latest as well, so :latest follows releases once there
# are any, and follows main until then.
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

# Turns a ref into the list of tags it should publish.
#
# A version tag also publishes the major.minor series, so v1.2.1 moves
# :1.2 as well. Deliberately no bare major: :1 moving across minor
# releases tends to surprise people more than it helps them.
tags_for_ref() {
    ref=$1
    case "${ref}" in
        refs/heads/main)
            printf 'latest\n%s\n' "${SHORT}"
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
            printf 'latest\n'
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

log "verifying the manifests"
for image in "${CONDUCTOR_IMAGE}" "${WORKER_IMAGE}"; do
    first=$(printf '%s' "${TAGS}" | head -1)
    docker buildx imagetools inspect "${image}:${first}" \
        | grep -i platform \
        || fail "no platforms reported for ${image}:${first}"
done

printf '\nPASSED\n'
