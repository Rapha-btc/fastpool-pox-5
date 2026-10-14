#!/bin/bash
# Run one Rendezvous suite against tests/rv/.build and keep a summary.
# Usage: bash tests/rv/run.sh <vault|signer|props> <runs> <seed> [build-dir] [summary-suffix]
#   vault  = invariant mode on fastpool-swap-vault-solo
#   signer = invariant mode on signer-manager-vault-stx-rewards (+ vault)
#   props  = property mode on rv-props (production wiring)
# Invariant suites use three senders (deployer = pool/admin, wallet_1,
# wallet_2) so the pool-gated paths are reachable; the property suite runs
# as the deployer. A --config file makes RV ignore --runs/--seed flags, so
# both go in the generated config.
set -eu
cd "$(dirname "$0")/../.."
target="$1"; runs="$2"; seed="$3"
case "$target" in
  vault)  contract=fastpool-swap-vault-solo; type=invariant ;;
  signer) contract=signer-manager-vault-stx-rewards; type=invariant ;;
  props)  contract=rv-props; type=test ;;
  *) echo "unknown target $target" >&2; exit 2 ;;
esac
build="${4:-tests/rv/.build}"
[ -f "$build/Clarinet.toml" ] || python3 tests/rv/build.py
cfg="$build/rv-$target-$seed.json"
if [ "$type" = invariant ]; then
  accounts='{ "name": "deployer", "address": "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM" },
    { "name": "wallet_1", "address": "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5" },
    { "name": "wallet_2", "address": "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG" }'
else
  accounts='{ "name": "deployer", "address": "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM" }'
fi
cat > "$cfg" <<JSON
{ "accounts": [ $accounts ], "accounts_mode": "overwrite", "runs": $runs, "seed": $seed }
JSON
mkdir -p tests/rv/results
log="$build/rv-$target-$seed.log"
start=$(date +%s)
set +e
npx rv "$build" "$contract" "$type" --config="$cfg" > "$log" 2>&1
code=$?
set -e
secs=$(( $(date +%s) - start ))
sum="tests/rv/results/$target-seed$seed${5:-}.txt"
{
  echo "target=$contract type=$type runs=$runs seed=$seed exit=$code seconds=$secs"
  echo "rv-violation prints: $(grep -c 'rv-violation' "$log" || true)"
  echo "runtime errors: $(grep -c '(runtime)' "$log" || true)"
  grep -E 'OK, |properties passed|invariants passed|Falsified|failed|Error' "$log" | grep -v '^ *│' | tail -5
  sed -e 's/\x1b\[[0-9;]*m//g' "$log" | sed -n '/EXECUTION STATISTICS/,/LEGEND/p'
  if [ "$type" = test ]; then
    echo "property branch prints:"
    sed -e 's/\x1b\[[0-9;]*m//g' "$log" | grep -o 'rv-prop: "[a-z-]*", rv-z: "[a-z-]*"' | sort | uniq -c
  fi
} > "$sum"
cat "$sum" | head -4
exit $code
