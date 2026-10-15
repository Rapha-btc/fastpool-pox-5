# FastPool STX vault Clarinet checks

Run the FastPool-only SDK harness from this repository:

```sh
python3 tests/vault-stx/build-fastpool-fixtures.py
clarinet check --manifest-path tests/vault-stx/.build/fastpool-only/Clarinet.toml
./node_modules/.bin/vitest run tests/vault-stx/fastpool-vault.test.ts --silent -- \
  --manifest-path tests/vault-stx/.build/fastpool-only/Clarinet.toml
```

| Contract | Source commit | Pinned source SHA-256 |
|---|---|---|
| `fastpool-swap-vault` | `aa07e9c` | `cf99c70254fd30cf5ae852e92488402a477ae3b3d2674980e2da7228ff5d0c53` |
| `signer-manager-vault-stx-rewards` | `aa07e9c` | `fa3d94741b4c9eeeaf7cd2c39513439a51a6247056155a19a584df2b76a7020c` |

The fixture builder refuses to run if either FastPool production source has
different bytes from its pinned SHA-256. It copies those sources into an
isolated simnet manifest and rewrites only external principals to local test
fixtures. The vault binds `markets-sbtc-stx-jing-v6-4` and
`swap-router-sbtc-stx-jing-v5-5`; the market fixture is generated directly
from `../jing-contracts-v3/contracts/markets-sbtc-stx-jing-v6-4.clar` and the
logger stubs from `jing-core-v6`; PoX, router, oracle and wrapped-STX dependencies are
simnet fixtures. The builder and SDK runner do not deploy or publish anything.

The source-pinned SDK suite is run with Vitest coverage:

```sh
python3 tests/vault-stx/build-fastpool-fixtures.py
clarinet check --manifest-path tests/vault-stx/.build/fastpool-only/Clarinet.toml
./node_modules/.bin/vitest run tests/vault-stx/fastpool-vault.test.ts --silent -- \
  --manifest-path tests/vault-stx/.build/fastpool-only/Clarinet.toml --coverage \
  --coverage-filename tests/vault-stx/.build/fastpool-only/lcov.info
```

The expanded suite passes **329 assertions**. Coverage is measured on the two
production contracts in the isolated manifest:

| Contract | Tests | Lines | Branches | Functions |
|---|---:|---:|---:|---:|
| `fastpool-swap-vault` | Shared suite | 466/502 (92.8%) | 138/150 (92.0%) | 41/41 (100%) |
| `signer-manager-vault-stx-rewards` | Shared suite | 551/563 (97.9%) | 85/91 (93.4%) | 56/56 (100%) |

Remaining misses are defensive status, balance, payout, and fixture-reachability
arms; every public function is hit. The repository's full `npm test` run also
passes **49 tests** with **1 intentional isolated-harness skip**. Coverage files
are generated under the ignored `.build/fastpool-only` directory.
