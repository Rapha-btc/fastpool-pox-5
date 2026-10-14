# Rendezvous fuzzing: fastpool swap vault + STX-rewards signer

Rendezvous (`@stacks/rendezvous` 1.0.3) invariant and property suites for the
final drafts:

| contract | source | final commit | sha256 (checked by `build.py`) |
|---|---|---|---|
| swap vault | `contracts/fastpool-swap-vault.clar` | b719e87 | `aaebf34b...01fdac` |
| signer manager | `contracts/signer-manager-vault-stx-rewards.clar` | 3f82a93 | `4858dbc6...4a731` |

Both files are unchanged from those commits to HEAD. No production `.clar`,
`Clarinet.toml` or deployment plan is touched: `build.py` reads the sources
and writes rewritten copies into `tests/rv/.build/` (gitignored).

## Run

```bash
pnpm install
pnpm run rv:build      # tests/rv/.build (own Clarinet.toml, Clarity 6, epoch 4.0)
pnpm run rv:vault      # invariant, solo vault, 1500 runs x seeds 20261014, 20261015
pnpm run rv:signer     # invariant, signer + vault, 1500 runs x 2 seeds
pnpm run rv:props      # property, production wiring, 2000 runs x 2 seeds
pnpm run rv:mutants    # harness sanity: three broken builds, each must fail
bash tests/rv/run.sh <vault|signer|props> <runs> <seed>   # one run, summary in results/
```

`run.sh` writes an RV `--config` file (RV then ignores `--runs/--seed`, so
both go in the config). Invariant suites use three senders: the deployer (the
solo vault's pool, the signer's seeded admin), `wallet_1`, `wallet_2`. The
property suite runs as the deployer. Summaries land in `results/`.

## Generated project

| contract | what it is |
|---|---|
| `fastpool-swap-vault-solo` | the vault, `POOL` = the deployer wallet. RV invariant target `vault` |
| `fastpool-swap-vault` | the vault, `POOL` = the generated signer (production wiring) |
| `signer-manager-vault-stx-rewards` | the signer. RV invariant target `signer` |
| `rv-props` | property suite (`props.rv.clar`) |
| `mock-ft` | strict SIP-010 ledger for sBTC (and the wSTX trait identity) |
| `v6-market` + `mock-jing-core`, `mock-jing-ladder`, `mock-lazer-oracle` | the Jing v6 market RV fixture (copied from citycoins-protocol `tests/vault/fixtures` @ 9cd22e2) |
| `mock-router` | ADVERSARIAL router |
| `mock-dia`, `mock-native` | DIA push oracle / RFQ native price |
| `mock-pox`, `mock-signer-trait` | pox-5 surface, honest |
| `juice-swap-vault-trait-v2` | copied from `contracts/` |

### Test-only rewrites (generated copies only)

1. Mainnet principals to local mocks: market v6-3, router v5-3, RFQ native,
   sBTC, wSTX, DIA, pox-5 (and its `signer-manager-trait`), the vault trait;
   allowance asset names `"sbtc-token"` to `"mock-ft"`.
2. Vault `window-blocks` default `u288` to `u24` (both vault copies). RV mines
   at most 100 burn blocks between runs, so a 288-block window rarely elapses.
   The window is still settable inside its cap.
3. Solo vault: `POOL` is the deployer wallet, not the signer. With
   `contract-caller == POOL` the pool-gated entries (`fund`, `finish`,
   `emergency-recover`, the setters and DAO tools) are direct calls of one RV
   sender in three. This is the only way to fuzz the vault alone: a wrapper
   inside the vault that calls the vault back through a pool contract is a
   Clarity `CircularReference`.
4. Signer: `.rv-props` is seeded as a second admin next to the deployer.
5. `v6-market` fixture: the v6-3 compat shims (no update argument on
   `deposit-token-x` / `set-token-x-limit`, the v6-3 pending-escrow getter)
   of citycoins `tests/vault/build.py`. The shims mark the fixture's inner
   verify fee-free. v6-3 never verifies in those two calls, so a Lazer fee
   there would be a fixture artefact.
6. `mock-lazer-oracle`: a settable per-verify `fee`. The fee is charged in STX
   from `tx-sender`, as Pyth Lazer does. The oracle's STX balance is the fee sink.

`build.py --mutant=<floor|finish|fee>` writes a broken copy to
`.build-mutant-<name>/`. See "Harness sanity" below.

### Mocks that matter

- `mock-router` buys `fill-bps` of the offered sats at `quality-bps` of the
  Lazer mid. It ignores the per-leg limit and the per-leg minimums. It honours
  only the overall `min-stx-out` (u3002), the one guarantee the vault may rely
  on. For the permissionless `router-swap` the vault passes `min-stx-out u0`,
  so the vault's own post-trade check is the only guard. Reports are honest.
- `mock-ft` counts every transfer whose sender is a vault and whose recipient
  is not that vault's pool, the market or the router (`bad-vault-transfers`).
- `mock-pox` pays exactly what it reports. `set-shares` changes shares with no
  callback, like `unstake`. `stake` does the `validate-stake!` callback (used
  by `rv-props`). The signer's `rv-stake` wrapper runs the production
  `mirror-stake-for-cycle` fold itself, because a callback into the signer
  from a call that the signer started is a `CircularReference`.

## How the checks work

RV 1.0.3 calls the target's private `update-context` after every successful
public call. A failed call reverts, so the state before a call is the snapshot
taken after the previous success. `update-context` runs per-call transition
checks for the kind of call that just succeeded, then re-snapshots. A broken
rule bumps a named counter. The invariants require every counter to be zero.
The checks use observed balances, not the values the vault reports.

### Vault (both targets; `common.rv.clar`)

| invariant | rule |
|---|---|
| `invariant-v-no-floor-breach` | router-swap: `sold > 8` and `got >= floor-out(sold - 8, mid * (1 - slippage))`. Split: `got + 1 >= floor-out(sold, min(mid*(1-slip), mid*(1-60bps)))`. DIA split: `got >= floor-out(sold, no-pyth limit)`. jing-take and maker fills of the resting ask (by anyone's settle): `>= floor-out(sold, limit) * (1 - 80 bps)` (fee + max rebate) |
| `invariant-v-no-patience-sale` | every sale starts from an elapsed window |
| `invariant-v-stx-out-only-to-pool-or-fee` | vault STX falls only by its own Lazer fees, or on finish / recover |
| `invariant-v-sbtc-destinations` | sBTC leaves a vault only to its pool, the market or the router (`mock-ft` ghost) |
| `invariant-v-fee-within-budget` | one vault call pays at most `2 * pyth-fee-budget` |
| `invariant-v-finish-keeps-reserve` | finish pays the pool exactly `balance - min(balance, budget)` and keeps `min(balance, budget)`; ready to not ready, no clock |
| `invariant-v-fund-only-from-idle` | fund only from no clock and not ready; the clock starts now; the sats come out of the pool |
| `invariant-v-recover-sends-all` | emergency recovery leaves 0 sBTC, 0 on market, 0 STX; the pool receives exactly that; the clock is cleared |
| `invariant-v-close-is-empty` | close-batch leaves an empty vault (<= 2 dust sats) ready to finish |
| `invariant-v-clock-transitions` | the clock is never re-armed except by fund; ready only on an empty vault; ready cleared only by finish / recover |
| `invariant-v-place-is-peg` | jing-place only while open, the whole wallet, order `{limit: mid*(1-leeway), spread: (some u0)}`; refloor sets the phase floor |
| `invariant-v-batch-xor-ready` | never an open batch and ready-to-finish at once |
| `invariant-v-window-exclusive` | open and elapsed are exclusive; no clock means neither |
| `invariant-v-config-bounded` | every dial inside its cap, window < recovery delay, cooldown stamp not in the future |
| `invariant-v-clock-not-future`, `invariant-v-resting-peg` | as named |
| `invariant-v-sbtc-conservation` | strict-ledger supply == the sum over every holder the harness can move sats to |

### Signer (`signer.rv.clar`)

| invariant | rule |
|---|---|
| `invariant-s-fee-bips-bounded` | `fees-bips < 10000` |
| `invariant-s-earned-is-charged-minus-withdrawn` | ghost: `earned-fees == fees charged - fees withdrawn`; earned grows only on funding, by exactly the fee; it shrinks only on withdraw |
| `invariant-s-funding-accounting` | fund: `fee == floor(unfunded * bips / 1e4)` at the cycle's rate (< 1e4); the vault gets `unfunded - fee`; the liability drops by `unfunded` |
| `invariant-s-stx-accounting` | every uSTX credited equals the `unpaid-stx` increase; distribute debits exactly what it pays; sweep leaves `balance == unpaid` |
| `invariant-s-sbtc-accounting` | sBTC leaves the signer only on fund, timeout payouts (exactly gross - fee), withdraw (exactly the earned decrease), dust sweep (down to the obligations) |
| `invariant-s-sbtc-covers-obligations` | `sbtc balance >= earned-fees + unswapped-sats` |
| `invariant-s-stx-covers-unpaid` | `stx balance >= unpaid-stx` |
| `invariant-s-vault-cycle-matches-vault` | a vault cycle is in flight exactly while the vault has a batch or awaits finish |
| `invariant-s-cycles-bounded` | per tracked cycle (0..7): sum of stacker STX paid <= stx-out; sum of sBTC accounted <= recovered; swapped <= pot; fee-sats <= swapped * 9999 / 1e4; stx-out only on a pinned cycle |

### Properties (`props.rv.clar`, production wiring through the signer)

| test | asserts |
|---|---|
| `test-finish-reserve` | fees exact at fund; finalize returns `bal - min(bal, budget)`; the vault keeps `min(bal, budget)`; signer STX, `unpaid-stx` and `stx-out` all grow by that amount |
| `test-router-floor` | `router-swap` succeeds iff `fee <= budget` and `take > 8` and `out >= floor-out(take - 8, mid*(1-slip))`; on success the exact balances (vault sBTC, vault STX net of the fee, oracle fee); on refusal nothing moves |
| `test-split-floor` | `router-swap-split` succeeds iff the router can meet the oracle min-out; on success `got + 1 >= floor-out(amount, min floor)` |
| `test-dia-floor` | `router-swap-split-dia` with DIA up (any skew, any tolerance) or down (native/2): succeeds iff the router meets `floor-out(amount, limit)`; never under the floor |
| `test-patience` | while the window is open, router-swap / jing-take / split / dia / reclaim all fail u16031; a second funding fails u1050; jing-place rests the whole balance as the zero-spread peg at `mid*(1-leeway)` |
| `test-fee-withdraw` | withdraw only `<= earned-fees` (else u1005), exact debits; the sBTC balance still covers the obligations |
| `test-distribute` | two stakers via pox-5 `stake` / `validate-stake!`: each gets `floor(stx-out * shares / total)`; the sum is <= stx-out; `unpaid-stx` drops by the sum; a repeat pays nothing (u1013); STX still covers unpaid |

A test whose precondition does not hold (the vault is mid-batch with an open
window) returns `(ok false)`. RV counts it as discarded.

## Results (2026-10-14)

Zero falsified invariants, zero failed properties, zero `rv-violation`
prints, zero runtime errors.

| suite | runs x seeds | result | successful state-changing calls (seed 20261014 / 20261015) |
|---|---|---|---|
| `vault` (solo, invariant, 17 invariants) | 1500 x 2 | pass | router-swap 16/27, rv-sell 19/9, rv-drain 35/41, rv-split 6/9, rv-dia 7/15, jing-take + rv-take 2/2, jing-place + rv-place 7/4, jing-refloor 1/1, jing-reclaim 6/3, fund + rv-fund 31/24, finish 23/13, emergency-recover 7/11, rv-bid 220/218 |
| `signer` (invariant, 9 signer + 17 vault invariants) | 1500 x 2 | pass | claim 270/272, pin 158/156, fund-swap-vault 29/28, rv-sell + rv-drain 33/52, rv-split 7/5, rv-dia 10/17, take 2/0, finalize 1/2, recover 23/25, distribute-many 151/137, distribute-one 1/9, stake 2/14, unstake 4/3, withdraw-fees 28/27, update-fees 16/9 |
| `props` (property, 7 tests) | 2000 x 2 | pass | passed (not discarded): finish-reserve 132/117, router-floor 144/120, split-floor 139/133, dia-floor 126/130, patience 115/123, fee-withdraw 277/292, distribute 113/112 |

Branches the property suite reached (prints, seed 20261014 / 20261015):
router-floor accept 66/47, reject on the floor 60/51, reject on the fee
budget 18/22; split-floor accept 29/37, reject 110/96; dia-floor accept via
DIA 21/32 and via native 23/21, reject 82/77; finish with a partial reserve
112/93, everything kept 20/24; fee-withdraw within earned 269/279, over 8/13;
distribute paid 113/112.

The property results were produced before the last change to the
invariant-only `rv-router-knobs` wrapper (quality biased to 89%..100%),
which `rv-props` does not call.

The signer target runs few complete batches (finalize 1-2 per seed: most
batches end in recovery past the 432-block deadline). The property suite
covers the finalize path through the signer more than 100 times per seed.

## Harness sanity (mutants)

Each mutant must make the suites fail. All three are caught. Summaries are in
`results/*-mutant-*.txt`.

| mutant | change | caught by |
|---|---|---|
| `floor` | liquidation floor at 3 x slippage | props `test-router-floor` (err u20) after 5 tests at seed 11; vault target `invariant-v-place-is-peg` (its refloor check) at seed 20261014, not at 20261015 |
| `finish` | finish sends the whole balance | props `test-finish-reserve` (err u4) after 2 tests; vault target `invariant-v-finish-keeps-reserve` at both seeds |
| `fee` | signer books 2 x the fee | props `test-finish-reserve` (err u2) after 2 tests; signer target `invariant-s-earned-is-charged-minus-withdrawn` at both seeds |

The invariant suites are weak on the floor mutant: most of their successful
sales come through a calm, honest router (`rv-drain`), and adversarial sales
that land between the mutant floor and the real floor are rare. The property
suite is the floor's main evidence.

## Gaps

- The Jing book paths (jing-place / jing-take / maker fills by a settle) run
  against the v6 market fixture with wallet bids, and their success counts are
  low (see the tables). The jing-take and maker-fill floor uses an 80 bps
  allowance for fee and rebate. That check is weaker than the exact
  router-path checks. The real v6-3 market, the real router and the AMMs are
  covered only by the stxer fork harnesses in `simulations/`.
- `pin-shares` against the real pox-5 totals, `register-self`, and the
  swap-vault upgrade (`confirm-swap-vault` needs 4032 burn blocks) get only
  shallow coverage.
- The mock router reports honestly. A lying router (wrong `out` / `unsold`)
  is out of scope: the vault trusts the router's report by design.
- RV draws arguments from small naturals and folds them into ranges, not over
  all uint128 values. Finite fuzzing is not a proof.
