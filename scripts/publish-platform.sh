#!/usr/bin/env bash
# Builds omnivoice-tts for THIS host, stages its platform package and publishes
# it to GitHub Packages. Also publishes the main package when its current
# version isn't on the registry yet (so whichever platform pushes first does it;
# the others then add their platform package under the same version).
#
# Run by the pre-push hook (scripts/hooks/pre-push) on pushes to main, and by
# `bun run publish:platform` on demand. Each machine only ever builds and
# publishes its own platform, which is what lets bespoke or embedded hosts
# take part: add `<platform>-<arch>` to optionalDependencies in
# packages/minion-hci-stack/package.json and push from that machine.
#
# Publishing needs NPM_PUBLISH_TOKEN (a short-lived token with write:packages);
# it is read from the environment or from ./.env.local. .npmrc uses the generic
# NODE_AUTH_TOKEN (the read:packages token for installs); this script overwrites
# it with the publish token for its own run only.
#
# Usage: publish-platform.sh [-n|--no-publish]
#   -n, --no-publish  build and stage (and `npm pack` into build/) only
set -uo pipefail
cd "$(dirname "$0")/.."

warn() { echo "[publish] $*" >&2; }
log() { echo "[publish] $*"; }

if [ ! -f "./.env.local" ]; then
	printf '# Required for publishing: a short-lived GitHub token with write:packages\nNPM_PUBLISH_TOKEN=\n' >./.env.local
	warn "created ./.env.local, fill in NPM_PUBLISH_TOKEN"
fi

set -a
# shellcheck disable=SC1090
source <(grep -v '^#' ./.env.local | grep -v '^$')
set +a

NO_PUBLISH=0
for arg in "$@"; do
	case "$arg" in
	-n | --no-publish) NO_PUBLISH=1 ;;
	*)
		warn "unknown argument: ${arg} (usage: publish-platform.sh [-n|--no-publish])"
		exit 2
		;;
	esac
done

for tool in bun npm; do
	command -v "$tool" >/dev/null 2>&1 || {
		warn "${tool} not found on PATH, skipping"
		exit 0
	}
done

MAIN_DIR=packages/minion-hci-stack
NAME="$(bun -e "console.log(require('./$MAIN_DIR/package.json').name)")"
VERSION="$(bun -e "console.log(require('./$MAIN_DIR/package.json').version)")"
KEY="$(bun -e "console.log(process.platform + '-' + process.arch)")"
PLATFORM_DIR="packages/platform/${KEY}"

if [ "$NO_PUBLISH" = "0" ] && [ -z "${NPM_PUBLISH_TOKEN:-}" ]; then
	warn "NPM_PUBLISH_TOKEN is not set (env or .env.local), skipping publish"
	exit 0
fi

NPMRC="$PWD/.npmrc"
# .npmrc authenticates with NODE_AUTH_TOKEN (the read token on dev machines);
# publishing overrides it with the publish token.
export NODE_AUTH_TOKEN="${NPM_PUBLISH_TOKEN:-}"

published() { npm view "$1@${VERSION}" version --userconfig "$NPMRC" >/dev/null 2>&1; }

if [ "$NO_PUBLISH" = "0" ] && published "${NAME}-${KEY}"; then
	log "${NAME}-${KEY}@${VERSION} is already published, nothing to do"
else
	log "building omnivoice-tts for ${KEY}..."
	if ! bun scripts/stage-platform-packages.ts; then
		warn "build/staging failed, skipping publish"
		exit 0
	fi
	if [ "$NO_PUBLISH" = "1" ]; then
		mkdir -p build
		(cd "$PLATFORM_DIR" && npm pack --pack-destination ../../../build >/dev/null) && log "packed ${PLATFORM_DIR} into build/"
		exit 0
	fi
	log "publishing ${NAME}-${KEY}@${VERSION}"
	(cd "$PLATFORM_DIR" && npm publish --userconfig "$NPMRC") || {
		warn "failed to publish ${NAME}-${KEY}"
		exit 0
	}
fi

if published "$NAME"; then
	log "${NAME}@${VERSION} is already published"
else
	log "publishing ${NAME}@${VERSION}"
	(cd "$MAIN_DIR" && npm publish --userconfig "$NPMRC") || warn "failed to publish ${NAME}"
fi

exit 0
