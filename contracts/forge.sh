#!/usr/bin/env sh
# Runs Foundry (forge/anvil/cast) from the pinned official image; no local install needed.
# Usage: ./forge.sh test | ./forge.sh build | TOOL=cast ./forge.sh ...
set -eu
IMAGE="ghcr.io/foundry-rs/foundry@sha256:043752653d5be351c71709091b3db97c4421c907eb40ea294195e7f532aadf46"
CA_ARGS=""
if [ -f /root/.ccr/ca-bundle.crt ]; then
  CA_ARGS="-v /root/.ccr/ca-bundle.crt:/ca.crt:ro -e SSL_CERT_FILE=/ca.crt -e HTTPS_PROXY -e https_proxy"
fi
# shellcheck disable=SC2086
exec docker run --rm --user 0 --network host -v "$(cd "$(dirname "$0")" && pwd)":/work -w /work \
  $CA_ARGS --entrypoint "${TOOL:-forge}" "$IMAGE" "$@"
