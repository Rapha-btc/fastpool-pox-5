# FastPool STX vault Clarinet checks

Run the FastPool-only SDK harness from this repository:

```sh
cd ../jing-contracts-v3
node tests/rv/router-v5-3/build.mjs
cd ../fastpool-pox-5
python3 tests/vault-stx/build-fastpool-fixtures.py
clarinet check --manifest-path tests/vault-stx/.build/fastpool-only/Clarinet.toml
node tests/vault-stx/run-fastpool.mjs
```

| Contract | Source commit | Pinned source SHA-256 |
|---|---|---|
| `fastpool-swap-vault` | `b719e87` | `aaebf34b4f14044459db4857f9d7849355a4113f51f24afc3e00f3b98101fdac` |
| `signer-manager-vault-stx-rewards` | `3f82a93` | `4858dbc67c466cd8e7cd0a13bcff32cf0f8e2bc72830f5ee914f270a07d4a731` |

The fixture builder refuses to run if either FastPool production source has
different bytes from its pinned SHA-256. It copies those sources into an
isolated simnet manifest and rewrites only external principals to local test
fixtures. The Jing v6-3 market build and logger stubs use the current Jing
source interfaces; PoX, router, oracle and wrapped-STX dependencies are
simnet fixtures. The builder and SDK runner do not deploy or publish anything.

The current SDK run passes **85 assertions** covering the FastPool signer and
vault: swap lifecycle, price and stale-feed guards, chunk cooldown, pro-rata
STX rewards, fee snapshot behavior across a late claim, recovery after the
432-block deadline, mixed-asset payouts, fee withdrawal, and vault rotation.
This is a focused behavioral suite; it does not produce line, branch, or
function coverage percentages.
