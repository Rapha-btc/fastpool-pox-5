#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ "$(clarinet --version)" == "clarinet 3.23.2" ]] || { echo "Requires Clarinet 3.23.2" >&2; exit 1; }
python3 tests/nov27/build.py
clarinet check --manifest-path tests/nov27/.build/Clarinet.toml > tests/nov27/.build/clarinet-check.log 2>&1 || { cat tests/nov27/.build/clarinet-check.log; exit 1; }
rm -rf tests/nov27/.build/coverage
tests/nov27/node_modules/.bin/vitest run --config tests/nov27/vitest.config.ts --reporter=default --reporter=json --outputFile=tests/nov27/.build/results.json "$@"
python3 tests/nov27/report.py
