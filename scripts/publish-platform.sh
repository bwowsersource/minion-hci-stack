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
# Publishing needs a short-lived token with write:packages. It is taken from
# NPM_PUBLISH_TOKEN if set, otherwise you are prompted to paste it (no echo).
# .npmrc uses the generic NODE_AUTH_TOKEN (the read:packages token for
# installs); this script overwrites it with the publish token for its own run.
#
# Where node-llama-cpp has no GPU prebuilt for this host (e.g. linux-arm64) a Vulkan
# build of it is compiled too and shipped in the platform package (build-llama.ts).
# An existing build/omnivoice (and build/llama) is reused rather than rebuilt.
#
# Usage: publish-platform.sh [-n|--no-publish] [-f|--force] [-v|--verbose]
#   -n, --no-publish  build and stage (and `npm pack` into build/) only
#   -f, --force       rebuild omnivoice-tts and node-llama-cpp even if build/ has them
#   -v, --verbose     run npm publish with --loglevel verbose
# While a publish runs, a heartbeat line is printed every 15s (npm itself shows
# no upload progress), followed by npm's exit code and the elapsed time.
set -uo pipefail
cd "$(dirname "$0")/.."

warn() { echo "[publish] $*" >&2; }
log() { echo "[publish] $*"; }

NO_PUBLISH=0
FORCE=0
NPM_FLAGS=()
for arg in "$@"; do
	case "$arg" in
	-n | --no-publish) NO_PUBLISH=1 ;;
	-f | --force) FORCE=1 ;;
	-v | --verbose) NPM_FLAGS=(--loglevel verbose) ;;
	*)
		warn "unknown argument: ${arg} (usage: publish-platform.sh [-n|--no-publish] [-f|--force] [-v|--verbose])"
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
	# stdin belongs to git when run from the pre-push hook, so ask the terminal
	if [ -r /dev/tty ] && [ -w /dev/tty ]; then
		printf '[publish] paste NPM_PUBLISH_TOKEN (write:packages, input hidden): ' >/dev/tty
		read -rs NPM_PUBLISH_TOKEN </dev/tty
		echo >/dev/tty
	fi
	if [ -z "${NPM_PUBLISH_TOKEN:-}" ]; then
		warn "no publish token given (set NPM_PUBLISH_TOKEN or run from a terminal), skipping publish"
		exit 0
	fi
fi

NPMRC="$PWD/.npmrc"
# .npmrc authenticates with NODE_AUTH_TOKEN (the read token on dev machines);
# publishing overrides it with the publish token.
export NODE_AUTH_TOKEN="${NPM_PUBLISH_TOKEN:-}"

# npm prints nothing while it uploads, so report liveness and the outcome
npm_publish() {
	local dir="$1" label="$2" start="$SECONDS" hb rc
	(while sleep 15; do log "${label}: still publishing ($((SECONDS - start))s elapsed)"; done) &
	hb=$!
	(cd "$dir" && npm publish --userconfig "$NPMRC" ${NPM_FLAGS[@]+"${NPM_FLAGS[@]}"})
	rc=$?
	kill "$hb" 2>/dev/null
	wait "$hb" 2>/dev/null
	log "${label}: npm publish exited ${rc} after $((SECONDS - start))s"
	return "$rc"
}

published() { npm view "$1@${VERSION}" version --userconfig "$NPMRC" >/dev/null 2>&1; }

STAGE_ARGS=()
if [ "$FORCE" = "0" ] && [ -d build/omnivoice ]; then
	log "reusing existing build/omnivoice (use --force to rebuild)"
	STAGE_ARGS=(--no-build)
fi
# ${arr[@]+...} keeps an empty array safe under `set -u` on bash < 4.4

if [ "$NO_PUBLISH" = "0" ] && published "${NAME}-${KEY}"; then
	log "${NAME}-${KEY}@${VERSION} is already published, nothing to do"
else
	log "staging omnivoice-tts for ${KEY}..."
	if ! bun scripts/stage-platform-packages.ts ${STAGE_ARGS[@]+"${STAGE_ARGS[@]}"}; then
		warn "build/staging failed, skipping publish"
		exit 0
	fi
	if [ "$NO_PUBLISH" = "1" ]; then
		mkdir -p build
		(cd "$PLATFORM_DIR" && npm pack --pack-destination ../../../build >/dev/null) && log "packed ${PLATFORM_DIR} into build/"
		exit 0
	fi
	log "publishing ${NAME}-${KEY}@${VERSION}"
	npm_publish "$PLATFORM_DIR" "${NAME}-${KEY}" || {
		warn "failed to publish ${NAME}-${KEY}"
		exit 0
	}
fi

if published "$NAME"; then
	log "${NAME}@${VERSION} is already published"
else
	log "publishing ${NAME}@${VERSION}"
	npm_publish "$MAIN_DIR" "$NAME" || warn "failed to publish ${NAME}"
fi

exit 0
