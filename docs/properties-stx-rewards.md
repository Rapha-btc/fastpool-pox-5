# Properties of `fastpool-stx-rewards-signer-manager`

Every guarantee this contract makes, what enforces it, and where it is checked.

Written to be read against the contract. Design rationale is in
[plan-fastpool-stx-rewards.md](plan-fastpool-stx-rewards.md); operating
instructions are in [deploy-stx-rewards.md](deploy-stx-rewards.md).

## How to read the "checked by" column

| tag | harness | what it can do |
| --- | --- | --- |
| **RV-I** | Rendezvous invariant | re-checked after every call in a random sequence |
| **RV-P** | Rendezvous property | fuzzed inputs, one call |
| **PROP** | `tests/stx-rewards-properties.test.ts` | randomised share vectors, whole-vector arithmetic |
| **UNIT** | `tests/stx-rewards.test.ts` | a specific scenario, driven through pox-5 |
| **FORK** | `tests/mainnet/*.fork.test.ts` | real mainnet state and DEX liquidity |
| **SIM** | `simulations/` | STXER, mainnet fork with writable private state |
| **TYPE** | `clarinet check` | proved at compile time |

A property with no test is marked **untested** and says why.

---

## 1. Authorization

The contract has three principals and one caller class. Nothing else can change
state.

| role | held by | may call |
| --- | --- | --- |
| pox-5 | `SP000…002Q6VF78.pox-5` | `validate-stake!` only |
| admin | `admins` map, deployer seeded | all `set-*`, `update-*`, `withdraw-fees`, `sweep-*`, `register-self` |
| operator | one mutable principal | `swap-rewards`, `swap-rewards-with-proof`, and nothing else |
| anyone | — | `claim-rewards`, `repair-mirror-many`, `pin-shares`, `distribute-rewards[-many]` |

| # | property | enforced by | checked by |
| --- | --- | --- | --- |
| A1 | `validate-stake!` is callable only by pox-5. It writes per-staker shares keyed by its `staker` argument, so a direct caller could mint themselves shares. | `authorize-pox-5`, `ERR_UNAUTHORIZED_CALLER` | UNIT |
| A2 | Admin functions require `contract-caller == tx-sender` **and** admin. The first clause stops an intermediate contract borrowing the authority. | `authorize-admin`, `ERR_UNAUTHORIZED_ADMIN` | RV-P, UNIT |
| A3 | The swap entry points require the same equality **and** `tx-sender == operator`. | `authorize-operator`, `ERR_UNAUTHORIZED_OPERATOR` | UNIT |
| A4 | An admin cannot change **their own** admin flag, in either direction. The guard is on the identity, not on the direction, so it also stops the last admin locking the contract out of admin control. | `(not (is-eq tx-sender admin))` in `update-admin` | untested |
| A5 | Rotating the operator takes effect immediately; the old principal loses the swap entry points and nothing else. | `set-operator` writes one var | UNIT |
| A6 | Claiming, pinning, repairing and distributing are permissionless, so a disappeared operator can delay a swap but never strand funds. | no guard, by design | UNIT |

## 2. Scope: what this manager refuses

| # | property | enforced by | checked by |
| --- | --- | --- | --- |
| S1 | Bond staking is refused. A bond stake fails at pox-5 rather than doing something undefined here. | `ERR_BONDS_NOT_SUPPORTED` | untested — driving a bond needs a bond-period fixture the suite lacks |
| S2 | Staking calldata is refused. Sibling managers use it to register a bitcoin `pox-addr`; a staker who passes one here gets a clean failure instead of quietly receiving STX. | `ERR_CALLDATA_NOT_SUPPORTED` | UNIT |
| S3 | A stake is mirrored for **every** cycle it covers, for any lock length pox-5 accepts — `check-pox-lock-period` allows 1..`MAX_NUM_CYCLES`, which is **96**. `CYCLE_OFFSETS` must therefore be at least 96 entries long: `validate-stake!` slices it to the lock length, so a shorter list makes the slice `none` and turns a perfectly legal stake into `ERR_INVALID_LOCK_PERIOD`. | `CYCLE_OFFSETS` length | UNIT |
| S4 | `ERR_INVALID_LOCK_PERIOD` is unreachable through pox-5, which caps the period before the callback runs. It stays as a defensive guard against the list and the cap drifting apart. | `ERR_INVALID_LOCK_PERIOD` | UNIT |

## 3. The share mirror

The mirror exists because every `contract-call?` into pox-5 is charged its full
~135 KB source as `read_length`. Asking per staker would cap a distribution at a
few hundred stackers per block.

| # | property | enforced by | checked by |
| --- | --- | --- | --- |
| M1 | The mirror can only ever be **too high**. pox-5 calls back on every path that increases shares and never on `unstake`, so unseen changes are always decreases. | pox-5's callback contract | — (premise) |
| M2 | Because of M1, equality with pox-5's signer total proves the mirror exact. This is the only pox-5 call the settlement path makes. | `pin-shares`, `ERR_SHARE_MIRROR_MISMATCH` | UNIT |
| M3 | A drifted mirror is repairable and never traps the pot: the check sits on `pin-shares`, not `claim-rewards`. | no assert in `claim-rewards` | UNIT |
| M4 | `repair-mirror-many` only ever writes pox-5's authoritative per-staker value. | reads `get-staker-shares-staked-for-cycle` | UNIT |
| M5 | Once a cycle is pinned, neither `validate-stake!` nor `repair-mirror-many` may change its shares. | `is-pinned` skip; `ERR_SHARES_ALREADY_PINNED` | RV-I, UNIT |
| M6 | Shares are stored **absolutely** per cycle, matching pox-5, so a re-stake overwrites rather than accumulates. | `mirror-stake-for-cycle` | UNIT |

## 4. Per-cycle settlement accounting

| # | property | enforced by | checked by |
| --- | --- | --- | --- |
| C1 | `swapped-sats <= pot-sats`. No sequence of legs can swap more than was claimed. | `ERR_SWAP_EXCEEDS_POT` per leg | RV-I |
| C2 | `fee-sats <= swapped-sats`. Fees come out of the swapped portion. | fee is a bips fraction of `amount-sats` | RV-I |
| C3 | `stx-out > 0` implies `swapped-sats > 0`. STX only ever arrives by swapping. | `swap-commit` is the only writer | RV-I |
| C4 | A cycle with a deadline has a pot, and one without has neither. | `claim-rewards` writes both together | RV-I |
| C5 | An unpinned cycle carries no denominator, and a pinned one has been claimed. | `pin-shares` ordering | RV-I |
| C6 | A pinned denominator never moves again. Every payout divides by it, so a change would re-price entitlements retroactively. | pinned cycles are frozen (M5) | RV-I |
| C7 | `pin-shares` is idempotent — it is called implicitly by both swap and distribute, so it must settle on one answer. | early return when `pinned` | RV-P |
| C8 | A cycle can be claimed repeatedly as rewards accrue; the pot accumulates and the deadline is set once. | `first-claim` branch | UNIT |

## 5. Fees

Fees are always taken **in sBTC**, so the pool keeps BTC-denominated revenue and
there is one accumulator to withdraw from.

| # | property | enforced by | checked by |
| --- | --- | --- | --- |
| F1 | No sequence of calls leaves the active, stored or pending rate above `MAX_FEE_BIPS` (u500 = 5%). | `ERR_INVALID_FEES_BIPS` | RV-I, RV-P |
| F2 | A rate over the cap is refused **whoever asks** — the cap and the authorization gate are independent. | same assert, before any state write | RV-P |
| F3 | A fee **increase** does not reach the active rate for `FEE_ACTIVATION_DELAY_CYCLES` (2). Stakers get time to unstake before it applies to them. | pending/active split | RV-P, UNIT |
| F4 | A fee **decrease** applies immediately. It can only help stakers, so nothing needs protecting. | `(<= new-fees active)` branch | RV-P, UNIT |
| F5 | The rate is snapshotted per cycle at first claim, so a later change never applies retroactively to a cycle in flight. | `fee-bips-for-cycle` | UNIT |
| F6 | A snapshotted rate is within the cap, including for cycles nobody claimed. | F1 plus the snapshot | RV-I |
| F7 | The fee is taken **before the DEX sees anything** — only `amount-sats - fee` reaches the adapter. | `swap-precheck` returns `net` | PROP, UNIT |
| F8 | The STX leg is never charged a fee: stakers split the whole of what came back. | fee already taken at swap | PROP |
| F9 | The sBTC timeout leg is charged at distribution instead, at the cycle's snapshotted rate. | `compute-due` | UNIT |
| F10 | These rules are identical to `fastpool-max500-signer-manager`, so a staker moving between pools finds the same ceiling and the same delay. | shared constants and logic | — (by construction) |

## 6. Swapping

| # | property | enforced by | checked by |
| --- | --- | --- | --- |
| W1 | The most sBTC a swap can move is `net`. The `as-contract?` allowance is a hard cap, whatever the adapter does. | `(with-ft … net)` | TYPE, FORK |
| W2 | Stakers are credited from this contract's **measured STX balance delta**, never from the adapter's return value. A lying adapter cannot inflate what is owed. | `swap-commit` | UNIT, SIM |
| W3 | A swap delivering less than `min-stx-out` reverts the whole transaction, moving nothing. | `ERR_SLIPPAGE` | UNIT, FORK |
| W4 | Only allowlisted adapters may be used. A trait parameter is not authorization. | `contract-of`, `ERR_ADAPTER_NOT_ALLOWED` | UNIT |
| W5 | Only the admin-pinned oracle may be passed, so the operator cannot shop for a flattering baseline — even while the baseline is only informational. | `ERR_WRONG_ORACLE` | UNIT |
| W6 | A swap is refused once the 3-day window has closed. | `ERR_SWAP_WINDOW_CLOSED` | UNIT |
| W7 | Legs accumulate into one settlement record, across venues and across both entry points. This is what makes route splitting possible. | `swap-commit` merges | UNIT |
| W8 | The proof entry point is identical in every respect that matters — same operator gate, allowlist, allowance, accounting — differing only in the payload it forwards. | shared `swap-precheck`/`swap-commit` | UNIT |
| W9 | The `proof` is opaque and forwarded without inspection. It is the venue's input, not this contract's. | passed through | UNIT |
| W10 | The proof path additionally grants a **bounded** `PROOF_FEE_BUDGET` of STX for a venue's oracle-refresh fee. This is the one place STX may leave during a swap, and the balance-delta accounting treats it as a cost of the swap. | `(with-stx PROOF_FEE_BUDGET)` | UNIT |
| W11 | No DEX call happens inside the distribution loop. | separate transactions | — (by construction) |

## 7. The price baseline

| # | property | enforced by | checked by |
| --- | --- | --- | --- |
| B1 | The floor **ships off** (`enforce-price-floor` is `false`). The miner-commit baseline runs above market, so enforcing it would reject honest swaps. | default `false` | UNIT |
| B2 | While off, the baseline is still read and printed beside the achieved price, so the gap can be measured from real swaps. | `swap-commit` print | SIM, FORK |
| B3 | While off, an oracle that cannot price **must not** block a swap. | oracle error becomes `none` | UNIT |
| B4 | While on, a missing baseline raises `ERR_NO_BASELINE`. A floor that silently passes when its input is missing would be no floor. | `enforce-floor` | UNIT |
| B5 | While on, `min-stx-out` more than `max-slippage-bips` under the baseline is refused. | `ERR_MIN_OUT_TOO_LOW` | UNIT |
| B6 | Turning it on needs no redeploy. | admin data var | UNIT |
| B8 | `max-slippage-bips` is bounded below 100%, so the floor can be loosened but never disabled by setting it out of range. | `(< bips BIPS_DENOMINATOR)`, `ERR_INVALID_FEES_BIPS` | untested |
| B7 | The baseline is derived from miner commitments on chain (`get-tenure-info? miner-spend-total`), not fed from off chain. | `price-oracle-jing` | SIM — **not** FORK: a fork serves synthetic tenure data, so a canary test pins that it cannot be measured locally |

## 8. Distribution

With `D` the pinned denominator and `sᵢ` a staker's mirrored shares:

```
stx_entitled(i)  = floor(stx_out × sᵢ / D)
stx_due(i)       = stx_entitled(i) − stx_paid(i)
sbtc_entitled(i) = floor(unswapped × sᵢ / D)      -- 0 while the window is open
```

| # | property | enforced by | checked by |
| --- | --- | --- | --- |
| D1 | **Conservation.** Payouts never exceed what the swap delivered. | floor division | PROP, SIM |
| D2 | **Bounded dust.** `stx_out − Σ payouts < N` for `N` stakers — at most one micro-STX each, from flooring. | floor division | PROP, SIM |
| D3 | **Exact pro-rata.** Each staker receives exactly `floor(stx_out × sᵢ / D)`. | `compute-due` | PROP, SIM |
| D4 | **Monotone in stake.** A larger share never receives less. | pro-rata formula | PROP |
| D5 | **Batching-independent.** One call or many, any order, gives the same totals. | per-staker watermarks | PROP |
| D6 | **Idempotent.** A second distribution pays nothing more. | monotone watermarks | PROP, UNIT |
| D7 | Both watermarks are monotone, so a later claim or swap pays exactly the increment. | `staker-stx-paid`, `staker-sbtc-accounted` | UNIT |
| D8 | Nobody is owed anything from a cycle with no shares — the guard against divide-by-zero becoming a free payout. | `total-shares == 0` branch | RV-I |
| D9 | A staker can never be entitled to more than the cycle took in. | `stx_entitled <= stx_out` | RV-I |
| D10 | A cycle that was never claimed pays nobody, whatever else has happened. | `deadline == 0` | RV-P |
| D11 | Every payout path is permissionless, so a staker never depends on the operator to be paid. | no guard | UNIT |
| D12 | A staker with nothing due is skipped, never an error, so one staker cannot block a batch. | `fold-distribute` | UNIT |
| D13 | `get-staker-rewards` is a pure view: asking twice gives the same answer. | read-only | RV-P |

## 9. The 3-day window and the sBTC fallback

| # | property | enforced by | checked by |
| --- | --- | --- | --- |
| T1 | The window opens at the **first** claim for a cycle and runs `SWAP_WINDOW_BURN_BLOCKS` (432 ≈ 3 days). | `claim-rewards` | UNIT |
| T2 | The sBTC leg is **zero while the window is open**, even with an unswapped remainder. Otherwise a distribution mid-swap would pay away the operator's remaining budget. | `get-unswapped-for-cycle` | UNIT |
| T3 | Once the window closes, the unswapped remainder becomes sBTC-payable with no privileged action required. | same | UNIT |
| T4 | A partially swapped cycle that times out pays **both** legs, in the same proportion for every staker. | both legs computed always | UNIT |
| T5 | There is no branch: every staker gets both legs, and one is almost always zero. | `compute-due` | — (by construction) |

## 10. Solvency and sweeps

These are the properties that make the admin sweeps safe.

| # | property | enforced by | checked by |
| --- | --- | --- | --- |
| L1 | `unpaid-stx <= stx-get-balance(contract)`. Every micro-STX promised is actually there. | swap credits, payout debits | **RV-I** |
| L2 | `earned-fees + unswapped-sats <= sbtc-balance(contract)`. | claim credits, swap and payout debits | **RV-I** |
| L3 | `sweep-sbtc-dust` can only take `balance − earned-fees − unswapped-sats`, which by L2 is never staker money. | subtraction, `ERR_NO_DUST` | UNIT |
| L4 | `sweep-stx-dust` can only take `stx-balance − unpaid-stx`, which by L1 is never staker money. | subtraction, `ERR_NO_DUST` | UNIT |
| L5 | `withdraw-fees` is capped at `earned-fees`. | `ERR_INSUFFICIENT_FEES` | UNIT |
| L6 | **The pro-rata dust is stranded on purpose.** Liability counters shrink only by what was actually paid, so the floored remainder stays inside the liability and no sweep can reach it. Under one micro-STX and one satoshi per staker per cycle — the price of L1/L2 holding unconditionally. | by construction | UNIT |
| L7 | The contract never locks STX (stakers lock their own against it), so `stx-get-balance` needs no adjustment for a locked portion. | pox-5 semantics | — (premise) |

## 11. pox-5 interaction

| # | property | enforced by | checked by |
| --- | --- | --- | --- |
| P1 | The settlement path makes **zero** pox-5 calls once a cycle is pinned. | pinned denominator | UNIT (cost benchmark) |
| P2 | pox-5's per-staker ledger is deliberately never settled; this contract's mirror is authoritative. Because the pox-5 settlement path is not exposed at all, the two can never be mixed and no double payout is possible. | `claim-staker-rewards-for-signer` unused | — (by construction) |
| P3 | A 300-staker batch fits comfortably in a block: `read_count` binds first, at ~26% on the heavier sBTC leg. | measured | UNIT (`bench-distribute-many`) |
| P4 | A maximum-length stake fits in a block, but is not cheap: a 96-cycle lock costs ~3,584 reads (~24% of the block budget), against 476 for 12 cycles. The cost is linear in lock length and is split between this contract's mirror and pox-5's own fold over the same cycles. Roughly four such stakes fit in one block. | measured | UNIT |

## 12. Deployment shape

| # | property | enforced by | checked by |
| --- | --- | --- | --- |
| X1 | The Rendezvous harness is `#[env(simnet)]` and is stripped from the publish source, so it costs nothing in `read_length` on chain — 18% of the source file. | clarinet; `scripts/build-mainnet.mjs` | TYPE (two-pass check), build guard |
| X2 | Production code never depends on a test helper. | `clarinet check` runs with and without the annotated code | TYPE |
| X3 | `build/mainnet/` differs from `contracts/` in exactly two ways: the pox-5 principal, and the removal of annotated code. The build refuses to finish otherwise. | `scripts/build-mainnet.mjs` guards | build guard |

---

## Known gaps

| property | why untested |
| --- | --- |
| S1 (bonds refused) | driving a bond through pox-5 needs a bond-period fixture the suite does not have. The guard is one `asserts!`. |

| A4 (admin cannot change own flag) | trivial, one comparison; no test drives it. |
| B8 (slippage bips bound) | inert while the floor is off, which is how it ships. |
| M1, L7, P2, T5, F10, W11 | premises or structural facts, not runtime behaviour — nothing to execute. |
| B7 on a local fork | a fork serves synthetic burnchain tenure data; the canary test in `tests/mainnet/oracle.fork.test.ts` fails if that ever changes. |

## Running the checks

```bash
pnpm test          # UNIT + PROP           (76 tests)
pnpm test:rv       # RV-I  invariants
pnpm test:rv:prop  # RV-P  properties
pnpm test:fork     # FORK  real mainnet state
clarinet check     # TYPE  both passes
node simulations/1-adapter-swap.mjs    # SIM
```
