#!/bin/sh
set -eu
# No ports, credentials or host directories. The overmount is container-local.
docker build -f scripts/fixtures/Dockerfile.codex-proc -t botons-codex-proc-smoke .
docker run --rm --privileged botons-codex-proc-smoke
