#!/bin/bash
# Docker liveness/readiness probe. /ready requires the bridge and at least one
# extension connection; /health remains available as the liveness endpoint.
set -eu
curl --fail --silent --show-error --max-time 8 http://127.0.0.1:8787/ready > /dev/null
