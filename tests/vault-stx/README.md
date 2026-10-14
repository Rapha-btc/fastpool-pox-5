# FastPool STX vault Clarinet checks

Run the FastPool-only SDK harness from this repository:

```sh
cd ../jing-contracts-v3
node tests/rv/router-v5-3/build.mjs
cd ../fastpool-pox-5
python3 tests/vault-stx/build-fastpool-fixtures.py
clarinet check --manifest-path tests/vault-stx/.build/fastpool-only/Clarinet.toml
./node_modules/.bin/vitest run tests/vault-stx/fastpool-vault.test.ts --silent -- \
  --manifest-path tests/vault-stx/.build/fastpool-only/Clarinet.toml
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

The source-pinned SDK suite is run with Vitest coverage:

```sh
python3 tests/vault-stx/build-fastpool-fixtures.py
clarinet check --manifest-path tests/vault-stx/.build/fastpool-only/Clarinet.toml
./node_modules/.bin/vitest run tests/vault-stx/fastpool-vault.test.ts --silent -- \
  --manifest-path tests/vault-stx/.build/fastpool-only/Clarinet.toml --coverage \
  --coverage-filename tests/vault-stx/.build/fastpool-only/lcov.info
```

The expanded suite passes **317 assertions**. Coverage is measured on the two
production contracts in the isolated manifest:

| Contract | Tests | Lines | Branches | Functions |
|---|---:|---:|---:|---:|
| `fastpool-swap-vault` | Shared suite | 466/502 (92.8%) | 138/150 (92.0%) | 41/41 (100%) |
| `signer-manager-vault-stx-rewards` | Shared suite | 551/563 (97.9%) | 85/91 (93.4%) | 56/56 (100%) |

Remaining misses are defensive status, balance, payout, and fixture-reachability
arms; every public function is hit. The repository's full `npm test` run also
passes **49 tests** with **1 intentional isolated-harness skip**. Coverage files
are generated under the ignored `.build/fastpool-only` directory.
