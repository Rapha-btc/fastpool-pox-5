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
| `fastpool-swap-vault` | `1b47851` (v6-5 market, v6 router, trait-v3) | `d1998f6bf3ac3c8081dccd0d39b200c79970fcee546eebdd42d588b91139c492` |
| `signer-manager-vault-stx-rewards` | `1b47851` (trait-v3) | `23d98cb6964475cf2deded383ed005fd9cb8fe5be6f53f32f4f61f00f782b38e` |

The fixture builder refuses to run if either FastPool production source has
different bytes from its pinned SHA-256. It copies those sources into an
isolated simnet manifest and rewrites only external principals to local test
fixtures. The vault binds `markets-sbtc-stx-jing-v6-5` and
`swap-router-sbtc-stx-jing-v6`, and both contracts use
`juice-swap-vault-trait-v3` (copied from `contracts/`, real bytes, no shim);
the market fixture is generated directly
from `../jing-contracts-v3/contracts/markets-sbtc-stx-jing-v6-5.clar` and the
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

The expanded suite passes **393 assertions** (rerun 2026-11-19 on `1b47851`). Coverage is measured on the two
production contracts in the isolated manifest:

| Contract | Tests | Lines | Branches | Functions |
|---|---:|---:|---:|---:|
| `fastpool-swap-vault` | Shared suite | 488/524 (93.1%) | 142/154 (92.2%) | 43/43 (100%) |
| `signer-manager-vault-stx-rewards` | Shared suite | 557/569 (97.9%) | 85/91 (93.4%) | 57/57 (100%) |

Remaining misses are defensive status, balance, payout, and fixture-reachability
arms; every public function is hit. The repository's full `npm test` run also
passes **49 tests** with **1 intentional isolated-harness skip**. Coverage files
are generated under the ignored `.build/fastpool-only` directory.
