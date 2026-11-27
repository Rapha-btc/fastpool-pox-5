# November 26–27 contract regressions

From the repository root, with Clarinet **3.23.2** installed:

```sh
npm ci --prefix tests/nov27
npm --prefix tests/nov27 test
```

The isolated package pins Clarinet SDK **3.23.2** and Vitest **3.2.4**. Each test
creates a fresh simnet in its arrange section; there are no beforeAll/beforeEach
hooks or skipped tests. `run.sh` builds local fixtures, runs `clarinet check`,
and then runs only this directory's test files. Generated files stay under
`.build` (and wallet manifest settings/deployments are ignored).

The full current fastpool-swap-vault is tested against local ledger, oracle,
market, router and pool mocks. Only dependency principals are rebound. The
production v4 trait is retained; pool forwarding goes through the trait so
contract-caller authentication remains intact.

Allowance tests transfer the requested amount, refund 2 × min-x, then pull that
refund again inside the production as-contract? scope. The exact boundary must
succeed and one extra sat must fail atomically. Dust cases include 3/36/71/72 sats,
73-sat rejection, and resting dust reclaimed by close-batch. Split zero-fill tests
(where applicable) verify u16050 and unchanged cooldown, then retry successfully.

These are deterministic unit/integration regressions with mocked external
services, not mainnet liquidity or oracle-signature integration tests. Production
source files, the root manifest and existing deployment plans are left untouched.

## Coverage and seeded fuzzing

See [RESULTS.md](RESULTS.md) for per-file pass counts, baseline/current production
line coverage, function coverage, source hashes and remaining gaps. Coverage
collection uses an afterEach reporting hook only; test setup remains explicit.

The `rendezvous*.test.ts` files use Rendezvous 1.0.3 ABI argument generation and
fast-check shrinking, with seeds 20261126 and 20261127. Default: 500 generated
cases per property. `RV_RUNS=2000 npm --prefix tests/nov27 test` increases the
campaign. They run inside the same pinned Clarinet SDK, independently of older
RV harnesses. `package-lock.json` pins the transitive toolchain as well.

The root Vitest configuration excludes this isolated package; run it with the
explicit command above to avoid mixing SDK/Vitest versions and setup hooks.
