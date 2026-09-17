;; title: fastpool-stx-rewards-signer-manager
;; A FAST Pool signer manager for pox-5 that pays stacking rewards in STX.
;;
;; pox-5 pays a pool's rewards in sBTC. This contract claims that pot, swaps it
;; for STX on one or more DEXs, and distributes the STX to its stakers
;; pro-rata. Everyone locked against this contract receives STX at the same
;; execution price; there is no per-staker reward preference. A staker who
;; wants sBTC or L1 bitcoin stakes against a different FAST Pool signer manager
;; instead.
;;
;; A cycle moves through four steps:
;;
;;   1. claim-rewards   (anyone)   pox-5 -> here. Starts a 3-day swap window.
;;   2. pin-shares      (anyone)   freeze the pro-rata denominator.
;;   3. swap-rewards    (operator) sBTC -> STX, once per route leg.
;;   4. distribute-*    (anyone)   pay stakers.
;;
;; If the operator does not swap within the window, whatever is left unswapped
;; is paid out as sBTC instead, with no privileged action required.
;;
;; STX stacking only. Bond stacking and pox-addr calldata are both refused in
;; `validate-stake!`.
;;
;; See docs/plan-fastpool-stx-rewards.md for the full design rationale.

(impl-trait 'ST000000000000000000002AMW42H.pox-5.signer-manager-trait)
(use-trait signer-manager-trait 'ST000000000000000000002AMW42H.pox-5.signer-manager-trait)
(use-trait dex-adapter-trait .dex-traits.dex-adapter-trait)
(use-trait dex-adapter-proof-trait .dex-traits.dex-adapter-proof-trait)
(use-trait price-oracle-trait .dex-traits.price-oracle-trait)

;;; Errors
;;
;; Codes u1001-u1007 are SHARED with `fastpool-max500-signer-manager`: the same
;; number means the same thing in both contracts, so an operator reading a
;; failed transaction does not have to know which manager produced it.
;;
;; Everything this contract needs that max500 has no concept of is numbered from
;; u1020, clear of max500's u1001-u1017, so a number can never mean one thing
;; here and another there.

;; A staker had nothing payable for this cycle.
(define-constant ERR_NO_CLAIMABLE_REWARDS (err u1001))
;; Attempted an admin-only function.
(define-constant ERR_UNAUTHORIZED_ADMIN (err u1002))
;; Staking calldata was provided. max500 uses calldata to register a bitcoin
;; pox-addr for L1 payouts; this contract has no such path, so a staker who
;; passes one gets a clear failure instead of quietly receiving STX.
(define-constant ERR_CALLDATA_NOT_SUPPORTED (err u1003))
;; Fee rate is not a valid basis-point value.
(define-constant ERR_INVALID_FEES_BIPS (err u1005))
;; A pox-5 callback (`validate-stake!`) was invoked by a principal other than
;; the pox-5 contract.
(define-constant ERR_UNAUTHORIZED_CALLER (err u1006))
;; Tried to withdraw more fees than have accrued.
(define-constant ERR_INSUFFICIENT_FEES (err u1007))

;;; Errors specific to this contract

;; Attempted an operator-only function (the swap entry points).
(define-constant ERR_UNAUTHORIZED_OPERATOR (err u1020))
;; Bond staking is not supported by this signer manager.
(define-constant ERR_BONDS_NOT_SUPPORTED (err u1021))
;; pox-5 asked to mirror more cycles than a lock can cover.
(define-constant ERR_INVALID_LOCK_PERIOD (err u1022))
;; `claim-rewards` has not run for this cycle, so there is nothing to settle.
(define-constant ERR_CYCLE_NOT_CLAIMED (err u1023))
;; The local share mirror disagrees with pox-5's signer total, so the pro-rata
;; denominator cannot be trusted. Repairable -- see `repair-mirror-many`.
(define-constant ERR_SHARE_MIRROR_MISMATCH (err u1024))
;; The cycle's shares are already pinned and can no longer be changed.
(define-constant ERR_SHARES_ALREADY_PINNED (err u1025))
;; The 3-day swap window for this cycle has closed.
(define-constant ERR_SWAP_WINDOW_CLOSED (err u1026))
;; Tried to swap more sBTC than this cycle's pot has left.
(define-constant ERR_SWAP_EXCEEDS_POT (err u1027))
;; The swap adapter is not on the admin's allowlist.
(define-constant ERR_ADAPTER_NOT_ALLOWED (err u1028))
;; The oracle passed is not the admin-pinned oracle.
(define-constant ERR_WRONG_ORACLE (err u1029))
;; The price floor is switched on but the oracle could not produce a baseline.
(define-constant ERR_NO_BASELINE (err u1030))
;; `min-stx-out` sits further below the baseline price than
;; `max-slippage-bips` allows.
(define-constant ERR_MIN_OUT_TOO_LOW (err u1031))
;; The swap delivered less STX than `min-stx-out`.
(define-constant ERR_SLIPPAGE (err u1032))
;; There is no sweepable dust.
(define-constant ERR_NO_DUST (err u1033))
;; Highest fee an admin may set, in basis points. Inclusive: `u500` is
;; exactly 5%, and 5% is settable. Same cap as
;; `fastpool-max500-signer-manager` -- a staker moving between the two pools
;; should not find a different ceiling on either side.
(define-constant MAX_FEE_BIPS u500)
(define-constant BIPS_DENOMINATOR u10000)
;; A fee *increase* only becomes snapshottable this many reward cycles after
;; it is queued, so stakers can unstake before it applies to them. Decreases
;; apply immediately. Same rule, and same delay, as max500.
(define-constant FEE_ACTIVATION_DELAY_CYCLES u2)
;; How long the operator has to swap a cycle's pot, measured from the first
;; `claim-rewards` for that cycle. ~3 days at one bitcoin block per 10 minutes;
;; actual wall-clock drifts with real block times, and the contract only ever
;; reasons in burn blocks.
(define-constant SWAP_WINDOW_BURN_BLOCKS u432)
;; A venue that refreshes an on-chain price feed mid-swap pays a fee for it in
;; STX -- Pyth's is 10 micro-STX today. `swap-rewards-with-proof` therefore
;; grants the adapter a tiny STX allowance on top of the sBTC one, or the
;; refresh fails and the whole swap with it.
;;
;; Deliberately loose: at this size the amount is economically irrelevant even
;; if an allowlisted adapter were malicious, while a budget set too tight
;; breaks every swap the day a venue's fee ticks up. It is bounded, which is
;; the property that matters -- the balance-delta accounting simply sees the
;; fee as a cost of the swap.
(define-constant PROOF_FEE_BUDGET u10000)

;; Offsets used to walk the cycles a stake covers, one entry per cycle pox-5
;; will accept: `check-pox-lock-period` allows 1..`MAX_NUM_CYCLES`, which is
;; u96, and pox-5's own `add-staker-to-signer-cycles` folds over a list of the
;; same length.
;;
;; This list MUST be at least as long as pox-5's cap. `validate-stake!` slices
;; it to the lock length, and a short list makes that slice `none` -- which
;; would reject a stake pox-5 was willing to accept. It was 12 entries once, on
;; a comment that wrongly said 12 was the pox-5 cap; 12 is the length of a
;; *bond* term, which this contract does not support at all.
(define-constant CYCLE_OFFSETS (list
  u0 u1 u2 u3 u4 u5 u6 u7 u8 u9 u10 u11 u12 u13 u14 u15 u16 u17 u18 u19 u20
  u21 u22 u23 u24 u25 u26 u27 u28 u29 u30 u31 u32 u33 u34 u35 u36 u37 u38
  u39 u40 u41 u42 u43 u44 u45 u46 u47 u48 u49 u50 u51 u52 u53 u54 u55 u56
  u57 u58 u59 u60 u61 u62 u63 u64 u65 u66 u67 u68 u69 u70 u71 u72 u73 u74
  u75 u76 u77 u78 u79 u80 u81 u82 u83 u84 u85 u86 u87 u88 u89 u90 u91 u92
  u93 u94 u95
))

;; Admins set fees, manage the adapter allowlist and the oracle, withdraw fees,
;; sweep dust, and set the operator. Deployer is seeded as the first admin.
(define-map admins
  principal
  bool
)

(map-set admins tx-sender true)

;; The operator is the single principal allowed to call `swap-rewards`, and
;; nothing else. It is a hot key running a keeper script, so it is a mutable
;; single principal rather than a set: rotating it is one admin call and the
;; old key is dead immediately.
(define-data-var operator principal tx-sender)
;; Allowlisted swap adapters. A trait parameter is not authorization; every
;; adapter is checked against this map by `contract-of`.
(define-map dex-adapters
  principal
  bool
)

;; The baseline price feed, pinned to exactly one principal so that the
;; operator cannot shop for a favourable oracle. Clarity cannot invoke a stored
;; principal directly, so callers pass a trait parameter and the contract
;; asserts it matches.
(define-data-var price-oracle principal tx-sender)
;; How far below the oracle baseline a `min-stx-out` may sit, WHEN the floor is
;; switched on. This is a sanity bound against a compromised operator key, not a
;; pricing bound -- real execution quality comes from the keeper's own fresh DEX
;; quote.
(define-data-var max-slippage-bips uint u2000)
;; Whether the baseline actually blocks a swap. OFF at launch, on purpose.
;;
;; The baseline is a miner-commit price (see contracts/price-oracle-jing.clar),
;; and measurement shows it running well ABOVE market: 3632 uSTX/sat against a
;; Bitflow near-spot of 2883, a ~21% gap. Enforcing a floor derived from a
;; number that high would reject swaps filling at a perfectly good price, so
;; until the gap has been watched for a while the baseline is recorded and not
;; enforced.
;;
;; While it is off, every swap still reads the baseline and prints it next to
;; the price actually achieved, so the gap can be measured from real swaps
;; rather than guessed at. Flip it on with `set-enforce-price-floor` once
;; `max-slippage-bips` is calibrated -- no redeploy needed.
(define-data-var enforce-price-floor bool false)
;;
;; Fees are always taken in sBTC, so the pool keeps BTC-denominated revenue and
;; there is only ever one accumulator to withdraw from. On the swapped portion
;; of a pot the fee is taken in `swap-rewards`, before the DEX sees anything;
;; on a timed-out portion it is taken in `distribute-*`.

;; Fees taken, in basis points, from rewards. This is the rate in force now;
;; `pending-fees-bips` / `pending-fees-cycle` hold a queued change. Read
;; `get-active-fee-bips` rather than either var directly.
(define-data-var fees-bips uint u0)

(define-data-var pending-fees-bips uint u0)
;; The reward cycle at which `pending-fees-bips` becomes the active rate.
(define-data-var pending-fees-cycle uint u0)
;; Amount of earned fees that are held by the contract.
;; When fees are transferred out of the contract, this value
;; must be deducted.
(define-data-var earned-fees uint u0)
;; The rate in force when a cycle was first claimed, so a later fee change
;; never applies retroactively to a cycle already in flight.
(define-map fee-bips-for-cycle
  uint
  uint
)

;;
;; The contract holds two assets, and each gets an explicit liability counter so
;; an admin sweep can never reach staker funds.

;; sBTC pulled in from pox-5 that has neither been swapped nor paid out.
;; Covers both a pot mid-swap and a timed-out pot awaiting sBTC distribution.
(define-data-var unswapped-sats uint u0)
;; Micro-STX received from swaps that has not yet been paid to a staker.
(define-data-var unpaid-stx uint u0)
;;
;; Every `contract-call?` into pox-5 is charged its full ~135KB source as
;; `read_length`, whatever the function does, so asking pox-5 for each
;; staker's share would cap a distribution at a few hundred stakers per
;; block. Instead the shares are mirrored here.
;;
;; pox-5 calls `validate-stake!` on every path that INCREASES a staker's
;; shares, which is enough to maintain the mirror. It never calls back on
;; `unstake`, so the mirror can drift -- but only ever upward, since every
;; unseen change is a decrease. That one-sidedness is what makes a single
;; signer-level equality check against pox-5 sufficient proof of exactness:
;; see `pin-shares`.

(define-map mirrored-shares
  {
    staker: principal,
    reward-cycle: uint,
  }
  uint
)

(define-map mirrored-total-shares
  uint
  uint
)

(define-map cycle-settlement
  uint
  {
    ;; gross sBTC pulled in from pox-5 for this cycle
    pot-sats: uint,
    ;; of `pot-sats`, how much has been committed to a swap (fee included)
    swapped-sats: uint,
    ;; fees taken on the swapped portion
    fee-sats: uint,
    ;; micro-STX received across all swap legs
    stx-out: uint,
    ;; the pinned pro-rata denominator
    total-shares: uint,
    ;; burn height after which the swap window is closed
    deadline: uint,
    pinned: bool,
  }
)

(define-constant EMPTY_SETTLEMENT {
  pot-sats: u0,
  swapped-sats: u0,
  fee-sats: u0,
  stx-out: u0,
  total-shares: u0,
  deadline: u0,
  pinned: false,
})

;;
;; Both are monotone. When more of a pot is claimed or swapped later, the
;; entitlement grows and the next distribution pays exactly the difference, so
;; repeated calls for the same staker are safe and idempotent.

;; Micro-STX already paid to a staker for a cycle.
(define-map staker-stx-paid
  {
    staker: principal,
    reward-cycle: uint,
  }
  uint
)

;; Gross sats already accounted to a staker for a cycle on the timeout path.
(define-map staker-sbtc-accounted
  {
    staker: principal,
    reward-cycle: uint,
  }
  uint
)

;;; pox-5 callbacks

;; Callback from a pox-5 `stake` / `stake-update`. Authorizes the staker and
;; mirrors the shares the stake grants.
;;
;; `is-bond` and `signer-calldata` are both refused rather than ignored: a
;; staker who meant to earn sBTC through a bond, or L1 bitcoin through a
;; pox-addr, gets a clean failure at pox-5 instead of silently receiving STX.
(define-public (validate-stake!
    (staker principal)
    (first-index uint)
    (num-indexes uint)
    (amount-ustx uint)
    (amount-sats uint)
    (is-bond bool)
    (signer-calldata (optional (buff 500)))
  )
  (begin
    (try! (authorize-pox-5))
    (asserts! (not is-bond) ERR_BONDS_NOT_SUPPORTED)
    (asserts! (is-none signer-calldata) ERR_CALLDATA_NOT_SUPPORTED)
    (fold mirror-stake-for-cycle
      (unwrap! (slice? CYCLE_OFFSETS u0 num-indexes) ERR_INVALID_LOCK_PERIOD) {
      staker: staker,
      first-reward-cycle: first-index,
      shares: amount-ustx,
    })
    (print {
      topic: "validate-stake",
      staker: staker,
      first-reward-cycle: first-index,
      num-cycles: num-indexes,
      shares: amount-ustx,
      amount-sats: amount-sats,
    })
    (ok true)
  )
)

;;; Signer rewards

;; Pull a cycle's sBTC out of pox-5 and start its swap window.
;;
;; Permissionless. A cycle can be claimed repeatedly as rewards accrue, so the
;; pot accumulates; only the first claim sets the fee rate and the deadline.
;;
;; There is deliberately no mirror check here. A drifted mirror is a normal
;; event (see `repair-mirror-many`) and must never be able to strand the pot
;; inside pox-5 -- the check lives on `pin-shares`, which is retryable.
;;
;; This contract never calls pox-5's `claim-staker-rewards-for-signer`. pox-5's
;; internal per-staker ledger is left un-zeroed by design; the mirror here is
;; authoritative. Because the pox-5 settlement path is not exposed at all, the
;; two can never be mixed and no double payout is possible.
(define-public (claim-rewards (reward-cycle uint))
  (let (
      (result (try! (contract-call? 'ST000000000000000000002AMW42H.pox-5 claim-rewards (list)
        reward-cycle
      )))
      (earned (get total-rewards result))
      (settlement (get-settlement reward-cycle))
      (first-claim (is-eq (get deadline settlement) u0))
      (deadline (if first-claim
        (+ burn-block-height SWAP_WINDOW_BURN_BLOCKS)
        (get deadline settlement)
      ))
    )
    (var-set unswapped-sats (+ (var-get unswapped-sats) earned))
    (if first-claim
      (map-set fee-bips-for-cycle reward-cycle (get-active-fee-bips))
      true
    )
    (map-set cycle-settlement reward-cycle
      (merge settlement {
        pot-sats: (+ (get pot-sats settlement) earned),
        deadline: deadline,
      })
    )
    (print {
      topic: "claim-rewards",
      reward-cycle: reward-cycle,
      earned: earned,
      pot-sats: (+ (get pot-sats settlement) earned),
      deadline: deadline,
    })
    (ok earned)
  )
)

;;; Share mirror settlement

;; Correct the mirror for stakers whose shares pox-5 has since reduced.
;;
;; pox-5's `unstake` removes a staker from cycles starting at
;; `current-cycle + 1`, and never calls back here. So a staker who locked for
;; cycles 10-15 and unstaked during cycle 12 was removed from 13, 14 and 15
;; while those were still future -- and this contract never saw it. When cycle
;; 13 later ends and is claimed, the mirror for it is high and `pin-shares`
;; will fail. That is expected, not a bug, which is why the repair is
;; permissionless and the check it feeds is a retryable gate.
;;
;; Costs one pox-5 call per staker, so the list is bounded well below the
;; distribution batch size. In practice only stakers who unstaked mid-lock
;; need repairing, and the keeper can identify exactly which ones with
;; read-only calls before spending a transaction.
(define-public (repair-mirror-many
    (stakers (list 100 principal))
    (reward-cycle uint)
  )
  (begin
    (asserts! (not (is-pinned reward-cycle)) ERR_SHARES_ALREADY_PINNED)
    (let (
        (summary (fold fold-repair-mirror stakers {
          reward-cycle: reward-cycle,
          removed: u0,
          added: u0,
        }))
        (total (default-to u0 (map-get? mirrored-total-shares reward-cycle)))
      )
      ;; `total` is the sum of every mirrored share, so it always covers
      ;; `removed` and this cannot underflow.
      (map-set mirrored-total-shares reward-cycle
        (+ (- total (get removed summary)) (get added summary))
      )
      (print {
        topic: "repair-mirror",
        reward-cycle: reward-cycle,
        removed: (get removed summary),
        added: (get added summary),
      })
      (ok {
        removed: (get removed summary),
        added: (get added summary),
      })
    )
  )
)

;; Freeze the pro-rata denominator for a cycle against pox-5's own signer
;; total.
;;
;; Because the mirror can only ever be too high, equality here proves it is
;; exact. This is the single pox-5 call the whole settlement path makes: once
;; pinned, swapping and distributing touch pox-5 not at all.
;;
;; Pinning also closes the cycle to further share changes -- `validate-stake!`
;; skips it and `repair-mirror-many` refuses it -- so nothing can move under a
;; pot whose price is already being determined.
;;
;; Permissionless and idempotent, so `swap-rewards` and `distribute-*` can call
;; it implicitly. It exists as its own entry point mainly so that a mirror
;; mismatch surfaces as an isolated, obvious failure rather than a confusing
;; revert inside a swap.
(define-public (pin-shares (reward-cycle uint))
  (let ((settlement (get-settlement reward-cycle)))
    (asserts! (> (get deadline settlement) u0) ERR_CYCLE_NOT_CLAIMED)
    (if (get pinned settlement)
      (ok (get total-shares settlement))
      (let ((local (default-to u0 (map-get? mirrored-total-shares reward-cycle))))
        (asserts!
          (is-eq local
            (contract-call? 'ST000000000000000000002AMW42H.pox-5
              get-signer-pending-staked-ustx-per-cycle current-contract
              reward-cycle
            ))
          ERR_SHARE_MIRROR_MISMATCH
        )
        (map-set cycle-settlement reward-cycle
          (merge settlement {
            total-shares: local,
            pinned: true,
          })
        )
        (print {
          topic: "pin-shares",
          reward-cycle: reward-cycle,
          total-shares: local,
        })
        (ok local)
      )
    )
  )
)

;;; Swap settlement

;; Swap part or all of a cycle's pot from sBTC to STX on one DEX.
;;
;; Operator only. Everything else in this contract is permissionless; this one
;; call is not, because `min-stx-out` is caller-supplied -- open it up and
;; anyone could set it to 1, sandwich the call and take the pot.
;;
;; Callable repeatedly for the same cycle with different adapters and amounts:
;; the legs accumulate into one settlement record. That is how a large pot gets
;; split across venues to cut price impact, and how a leg that reverts on
;; slippage is retried on its own without disturbing the others.
;;
;; The adapter is treated as untrusted. Three independent guards bound it: the
;; `as-contract?` allowance caps the sBTC that can leave, the STX credited is
;; measured from this contract's own balance delta rather than taken from the
;; adapter's return value, and the adapter must be on the admin's allowlist.
(define-public (swap-rewards
    (reward-cycle uint)
    (adapter <dex-adapter-trait>)
    (oracle <price-oracle-trait>)
    (amount-sats uint)
    (min-stx-out uint)
  )
  (begin
    (asserts! (default-to false (map-get? dex-adapters (contract-of adapter)))
      ERR_ADAPTER_NOT_ALLOWED
    )
    (asserts! (is-eq (contract-of oracle) (var-get price-oracle))
      ERR_WRONG_ORACLE
    )
    (let (
        (pre (try! (swap-precheck reward-cycle amount-sats)))
        (net (get net pre))
      )
      (let (
          ;; Read the baseline for the record. An oracle that cannot price
          ;; right now must not be able to stop a swap while the floor is off,
          ;; so an error becomes `none` here instead of propagating. With the
          ;; floor ON, that `none` is what `ERR_NO_BASELINE` catches -- a floor
          ;; that silently passes when its input is missing would be no floor.
          (baseline (match (contract-call? oracle sats-to-ustx net)
            priced (some priced)
            oracle-error none
          ))
        )
        (try! (enforce-floor min-stx-out baseline))
        ;; Read the balance AFTER the oracle call, so nothing that call might
        ;; do can be mistaken for swap proceeds.
        (let ((stx-before (stx-get-balance current-contract)))
          (try! (as-contract?
            ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
              "sbtc-token" net
            ))
            (try! (contract-call? adapter swap-sbtc-to-stx net min-stx-out))
          ))
          (swap-commit reward-cycle (contract-of adapter) amount-sats
            (get fee pre) net stx-before min-stx-out baseline
          )
        )
      )
    )
  )
)

;; The same swap, for a venue that needs an off-chain price attestation handed
;; to it in the transaction.
;;
;; Jing's Juice batch auction is the case this exists for: its taker `swap`
;; settles against a Pyth feed refreshed in the same call, so it takes a VAA
;; that only the keeper can fetch. That payload cannot be squeezed into
;; `dex-adapter-trait`, so it gets its own trait and its own entry point --
;; rather than widening the AMM trait with a buffer every other adapter would
;; ignore.
;;
;; Everything else is identical, deliberately: same operator gate, same
;; allowlist, same `as-contract?` allowance, same balance-delta accounting,
;; same settlement bookkeeping. The `proof` is opaque here and is forwarded
;; without inspection -- it is the venue's input, not this contract's.
(define-public (swap-rewards-with-proof
    (reward-cycle uint)
    (adapter <dex-adapter-proof-trait>)
    (oracle <price-oracle-trait>)
    (amount-sats uint)
    (min-stx-out uint)
    (proof (buff 8192))
  )
  (begin
    (asserts! (default-to false (map-get? dex-adapters (contract-of adapter)))
      ERR_ADAPTER_NOT_ALLOWED
    )
    (asserts! (is-eq (contract-of oracle) (var-get price-oracle))
      ERR_WRONG_ORACLE
    )
    (let (
        (pre (try! (swap-precheck reward-cycle amount-sats)))
        (net (get net pre))
      )
      (let ((baseline (match (contract-call? oracle sats-to-ustx net)
          priced (some priced)
          oracle-error none
        )))
        (try! (enforce-floor min-stx-out baseline))
        (let ((stx-before (stx-get-balance current-contract)))
          (try! (as-contract?
            (
              (with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
              "sbtc-token" net
            )
              ;; For the venue's oracle-refresh fee. See PROOF_FEE_BUDGET.
              (with-stx PROOF_FEE_BUDGET)
            )
            (try! (contract-call? adapter swap-sbtc-to-stx-with-proof net min-stx-out
              proof
            ))
          ))
          (swap-commit reward-cycle (contract-of adapter) amount-sats
            (get fee pre) net stx-before min-stx-out baseline
          )
        )
      )
    )
  )
)

;;; Staker rewards

;; Pay one staker. Permissionless -- anyone may trigger a payout on a
;; staker's behalf.
(define-public (distribute-rewards
    (staker principal)
    (reward-cycle uint)
  )
  (begin
    (try! (pin-shares reward-cycle))
    (let ((due (get-staker-rewards staker reward-cycle)))
      (asserts! (or (> (get stx-due due) u0) (> (get sbtc-gross-due due) u0))
        ERR_NO_CLAIMABLE_REWARDS
      )
      (try! (pay-staker staker reward-cycle due))
      (ok {
        stx: (get stx-due due),
        sbtc: (get sbtc-due due),
      })
    )
  )
)

;; Pay many stakers in one transaction.
;;
;; The settlement figures are read once and carried in the accumulator rather
;; than re-read per staker: nothing in this function changes them. The
;; distribution path makes no pox-5 calls at all, so the binding cost here is
;; the transfers themselves.
(define-public (distribute-rewards-many
    (stakers (list 300 principal))
    (reward-cycle uint)
  )
  (begin
    (try! (pin-shares reward-cycle))
    (let (
        (settlement (get-settlement reward-cycle))
        (summary (try! (fold fold-distribute stakers
          (ok {
            reward-cycle: reward-cycle,
            stx-out: (get stx-out settlement),
            unswapped: (get-unswapped-for-cycle reward-cycle),
            total-shares: (get total-shares settlement),
            fee-bips: (get-fee-bips-for-cycle reward-cycle),
            paid-count: u0,
            total-stx: u0,
            total-sbtc: u0,
          })
        )))
      )
      (print {
        topic: "distribute-rewards-many",
        reward-cycle: reward-cycle,
        paid: (get paid-count summary),
        total-stx: (get total-stx summary),
        total-sbtc: (get total-sbtc summary),
      })
      (ok {
        paid: (get paid-count summary),
        total-stx: (get total-stx summary),
        total-sbtc: (get total-sbtc summary),
      })
    )
  )
)

;;; Admin functions

(define-public (update-admin
    (admin principal)
    (enabled bool)
  )
  (begin
    (try! (authorize-admin))
    (asserts! (not (is-eq tx-sender admin)) ERR_UNAUTHORIZED_ADMIN)
    (print {
      topic: "update-admin",
      admin: admin,
      enabled: enabled,
    })
    (ok (map-set admins admin enabled))
  )
)

(define-public (set-operator (new-operator principal))
  (begin
    (try! (authorize-admin))
    (print {
      topic: "set-operator",
      old: (var-get operator),
      new: new-operator,
    })
    (ok (var-set operator new-operator))
  )
)

;; Update the fees taken from rewards.
;;
;; A *decrease* applies immediately -- it can only benefit stakers. An
;; *increase* is queued and does not become snapshottable until
;; `FEE_ACTIVATION_DELAY_CYCLES` cycles from now, so a staker who dislikes the
;; new rate has time to unstake before any of their rewards are crystallized
;; at it. Because `claim-rewards` snapshots the rate per cycle, a queued
;; increase also cannot reach back into a cycle that has already been pulled.
;;
;; Identical to `update-fees` in `fastpool-max500-signer-manager`.
(define-public (update-fees (new-fees uint))
  (let (
      (active (get-active-fee-bips))
      (cycle (current-cycle))
    )
    (try! (authorize-admin))
    (asserts! (<= new-fees MAX_FEE_BIPS) ERR_INVALID_FEES_BIPS)
    ;; Collapse any already-matured pending rate into the active slot, so
    ;; that queueing a new change never resurrects the pre-pending rate.
    (var-set fees-bips active)
    (if (<= new-fees active)
      (begin
        (var-set fees-bips new-fees)
        (var-set pending-fees-bips new-fees)
        (var-set pending-fees-cycle cycle)
      )
      (begin
        (var-set pending-fees-bips new-fees)
        (var-set pending-fees-cycle (+ cycle FEE_ACTIVATION_DELAY_CYCLES))
      )
    )
    (print {
      topic: "update-fees",
      old-fees: active,
      new-fees: new-fees,
      activation-cycle: (var-get pending-fees-cycle),
    })
    (ok true)
  )
)

(define-public (set-dex-adapter
    (adapter principal)
    (enabled bool)
  )
  (begin
    (try! (authorize-admin))
    (print {
      topic: "set-dex-adapter",
      adapter: adapter,
      enabled: enabled,
    })
    (ok (map-set dex-adapters adapter enabled))
  )
)

(define-public (set-price-oracle (oracle principal))
  (begin
    (try! (authorize-admin))
    (print {
      topic: "set-price-oracle",
      old: (var-get price-oracle),
      new: oracle,
    })
    (ok (var-set price-oracle oracle))
  )
)

;; Turn the baseline floor on or off. See `enforce-price-floor`.
(define-public (set-enforce-price-floor (enabled bool))
  (begin
    (try! (authorize-admin))
    (print {
      topic: "set-enforce-price-floor",
      old: (var-get enforce-price-floor),
      new: enabled,
    })
    (ok (var-set enforce-price-floor enabled))
  )
)

(define-public (set-max-slippage-bips (bips uint))
  (begin
    (try! (authorize-admin))
    (asserts! (< bips BIPS_DENOMINATOR) ERR_INVALID_FEES_BIPS)
    (print {
      topic: "set-max-slippage-bips",
      old: (var-get max-slippage-bips),
      new: bips,
    })
    (ok (var-set max-slippage-bips bips))
  )
)

(define-public (withdraw-fees
    (amount uint)
    (recipient principal)
  )
  (let ((fees (var-get earned-fees)))
    (try! (authorize-admin))
    (asserts! (<= amount fees) ERR_INSUFFICIENT_FEES)
    (var-set earned-fees (- fees amount))
    (try! (as-contract?
      ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token"
        amount
      ))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer amount tx-sender recipient none
      ))
    ))
    (print {
      topic: "withdraw-fees",
      amount-sats: amount,
      recipient: recipient,
    })
    (ok amount)
  )
)

;; Sweep sBTC that is owed to nobody: the balance less accrued fees and less
;; the pot still awaiting a swap or a timeout payout. Subtracting both
;; liabilities is what makes it impossible for an admin to reach staker funds.
;;
;; What this recovers is sBTC that arrived outside the reward path -- a stray
;; transfer to this contract, say. It deliberately does NOT recover the
;; floor-division remainder of a timeout payout: `unswapped-sats` is reduced by
;; each staker's floored gross, so the remainder stays inside the liability
;; and is never sweepable. That is the conservative side of the trade -- an
;; admin can never reach a staker -- at the cost of stranding under one
;; satoshi per staker per cycle in the contract forever.
(define-public (sweep-sbtc-dust (recipient principal))
  (let (
      (balance (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        get-balance current-contract
      )))
      (reserved (+ (var-get earned-fees) (var-get unswapped-sats)))
      (sweepable (if (>= balance reserved)
        (- balance reserved)
        u0
      ))
    )
    (try! (authorize-admin))
    (asserts! (> sweepable u0) ERR_NO_DUST)
    (try! (as-contract?
      ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token"
        sweepable
      ))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer sweepable tx-sender recipient none
      ))
    ))
    (print {
      topic: "sweep-sbtc-dust",
      amount-sats: sweepable,
      recipient: recipient,
    })
    (ok sweepable)
  )
)

;; Sweep STX that is owed to nobody: the balance less what swaps have credited
;; and distributions have not yet paid out.
;;
;; As with `sweep-sbtc-dust`, this recovers STX that arrived outside the reward
;; path, not the floor-division remainder of a pro-rata split -- `unpaid-stx`
;; is reduced only by what each staker is actually paid, so the remainder
;; stays reserved and unreachable. Under one micro-STX per staker per cycle is
;; stranded that way, which is the price of the guarantee that no admin call
;; can ever touch staker funds.
;;
;; This contract never locks STX (stakers lock their own against it), so
;; `stx-get-balance` needs no adjustment for a locked portion.
(define-public (sweep-stx-dust (recipient principal))
  (let (
      (balance (stx-get-balance current-contract))
      (reserved (var-get unpaid-stx))
      (sweepable (if (>= balance reserved)
        (- balance reserved)
        u0
      ))
    )
    (try! (authorize-admin))
    (asserts! (> sweepable u0) ERR_NO_DUST)
    (try! (as-contract? ((with-stx sweepable))
      (try! (stx-transfer? sweepable tx-sender recipient))
    ))
    (print {
      topic: "sweep-stx-dust",
      amount-ustx: sweepable,
      recipient: recipient,
    })
    (ok sweepable)
  )
)

;; Register this contract with pox-5 under a signer key. The key grant must not
;; have been used yet.
(define-public (register-self
    (signer-manager <signer-manager-trait>)
    (signer-key (buff 33))
    (auth-id uint)
    (signer-sig (buff 65))
  )
  (begin
    (try! (authorize-admin))
    (try! (contract-call? 'ST000000000000000000002AMW42H.pox-5 grant-signer-key
      signer-key current-contract auth-id signer-sig
    ))
    (contract-call? 'ST000000000000000000002AMW42H.pox-5 register-signer
      signer-manager signer-key
    )
  )
)

;;; Private helpers

(define-private (authorize-admin)
  (ok (asserts! (and (is-eq contract-caller tx-sender) (is-admin tx-sender))
    ERR_UNAUTHORIZED_ADMIN
  ))
)

;; The `contract-caller` equality means the operator's authority cannot be
;; borrowed by an intermediate contract.
(define-private (authorize-operator)
  (ok (asserts!
    (and (is-eq contract-caller tx-sender) (is-eq tx-sender (var-get operator)))
    ERR_UNAUTHORIZED_OPERATOR
  ))
)

;; `validate-stake!` writes per-staker state keyed by its `staker` argument;
;; if anyone could invoke it directly they could mint themselves shares.
(define-private (authorize-pox-5)
  (ok (asserts! (is-eq contract-caller 'ST000000000000000000002AMW42H.pox-5)
    ERR_UNAUTHORIZED_CALLER
  ))
)

;; Record a staker's shares for one cycle, keeping `mirrored-total-shares` in
;; step. pox-5 stores shares as an absolute per-cycle amount, so a re-stake
;; overwrites rather than adds, and the running total moves by the difference.
;;
;; A cycle whose shares are already pinned is skipped: its pot has been priced
;; and divided, so late shares must not dilute it. Skipping rather than failing
;; means a new stake is never blocked by an old settled cycle.
(define-private (mirror-stake-for-cycle
    (offset uint)
    (acc {
      staker: principal,
      first-reward-cycle: uint,
      shares: uint,
    })
  )
  (let ((reward-cycle (+ (get first-reward-cycle acc) offset)))
    (if (is-pinned reward-cycle)
      acc
      (let (
          (staker (get staker acc))
          (shares (get shares acc))
          (previous (default-to u0
            (map-get? mirrored-shares {
              staker: staker,
              reward-cycle: reward-cycle,
            })
          ))
          (total (default-to u0 (map-get? mirrored-total-shares reward-cycle)))
        )
        (map-set mirrored-shares {
          staker: staker,
          reward-cycle: reward-cycle,
        }
          shares
        )
        ;; `total` always includes `previous`, so this cannot underflow.
        (map-set mirrored-total-shares reward-cycle (+ (- total previous) shares))
        acc
      )
    )
  )
)

(define-private (fold-repair-mirror
    (staker principal)
    (acc {
      reward-cycle: uint,
      removed: uint,
      added: uint,
    })
  )
  (let (
      (reward-cycle (get reward-cycle acc))
      (truth (contract-call? 'ST000000000000000000002AMW42H.pox-5
        get-staker-shares-staked-for-cycle staker reward-cycle none
        current-contract
      ))
      (previous (default-to u0
        (map-get? mirrored-shares {
          staker: staker,
          reward-cycle: reward-cycle,
        })
      ))
    )
    (if (is-eq truth previous)
      acc
      (begin
        (map-set mirrored-shares {
          staker: staker,
          reward-cycle: reward-cycle,
        }
          truth
        )
        ;; The drift is always downward in practice; the upward arm exists so
        ;; the running total stays exact whatever pox-5 reports.
        (if (> previous truth)
          (merge acc { removed: (+ (get removed acc) (- previous truth)) })
          (merge acc { added: (+ (get added acc) (- truth previous)) })
        )
      )
    )
  )
)

;; Swap part or all of a cycle's pot from sBTC to STX on one DEX.
;;
;; Operator only. Everything else in this contract is permissionless; this one
;; call is not, because `min-stx-out` is caller-supplied -- open it up and
;; anyone could set it to 1, sandwich the call and take the pot.
;;
;; Callable repeatedly for the same cycle with different adapters and amounts:
;; the legs accumulate into one settlement record. That is how a large pot gets
;; split across venues to cut price impact, and how a leg that reverts on
;; slippage is retried on its own without disturbing the others.
;;
;; The adapter is treated as untrusted. Three independent guards bound it: the
;; `as-contract?` allowance caps the sBTC that can leave, the STX credited is
;; measured from this contract's own balance delta rather than taken from the
;; adapter's return value, and the adapter must be on the admin's allowlist.
(define-private (swap-precheck
    (reward-cycle uint)
    (amount-sats uint)
  )
  (begin
    (try! (authorize-operator))
    ;; Pin before reading the settlement: pinning writes to it.
    (try! (pin-shares reward-cycle))
    (let (
        (settlement (get-settlement reward-cycle))
        (fee (/ (* amount-sats (get-fee-bips-for-cycle reward-cycle)) BIPS_DENOMINATOR))
      )
      (asserts! (<= burn-block-height (get deadline settlement))
        ERR_SWAP_WINDOW_CLOSED
      )
      (asserts! (> amount-sats u0) ERR_SWAP_EXCEEDS_POT)
      (asserts!
        (<= amount-sats
          (- (get pot-sats settlement) (get swapped-sats settlement))
        )
        ERR_SWAP_EXCEEDS_POT
      )
      ;; The fee is taken in sBTC and never reaches the DEX.
      (ok {
        fee: fee,
        net: (- amount-sats fee),
      })
    )
  )
)

;; The baseline floor, when it is switched on. See `enforce-price-floor`.
(define-private (enforce-floor
    (min-stx-out uint)
    (baseline (optional uint))
  )
  (if (var-get enforce-price-floor)
    (begin
      (asserts!
        (>= min-stx-out
          (/
            (* (unwrap! baseline ERR_NO_BASELINE)
              (- BIPS_DENOMINATOR (var-get max-slippage-bips))
            )
            BIPS_DENOMINATOR
          ))
        ERR_MIN_OUT_TOO_LOW
      )
      (ok true)
    )
    (ok true)
  )
)

;; Shared back half of a swap: measure what actually arrived, hold it to
;; `min-stx-out`, and book it. Takes the adapter as a plain principal rather
;; than a trait so that both swap entry points can share it.
(define-private (swap-commit
    (reward-cycle uint)
    (adapter principal)
    (amount-sats uint)
    (fee uint)
    (net uint)
    (stx-before uint)
    (min-stx-out uint)
    (baseline (optional uint))
  )
  (let (
      (stx-after (stx-get-balance current-contract))
      ;; On the plain path no STX allowance was granted, so the balance cannot
      ;; have fallen. On the proof path it can, by at most PROOF_FEE_BUDGET.
      ;; Either way the guard keeps this total-safe, and a fee paid to refresh
      ;; a price feed is correctly netted out of what the swap delivered.
      (stx-out (if (> stx-after stx-before)
        (- stx-after stx-before)
        u0
      ))
      (settlement (get-settlement reward-cycle))
    )
    (asserts! (>= stx-out min-stx-out) ERR_SLIPPAGE)
    (var-set earned-fees (+ (var-get earned-fees) fee))
    (var-set unswapped-sats (- (var-get unswapped-sats) amount-sats))
    (var-set unpaid-stx (+ (var-get unpaid-stx) stx-out))
    (map-set cycle-settlement reward-cycle
      (merge settlement {
        swapped-sats: (+ (get swapped-sats settlement) amount-sats),
        fee-sats: (+ (get fee-sats settlement) fee),
        stx-out: (+ (get stx-out settlement) stx-out),
      })
    )
    (print {
      topic: "swap-rewards",
      reward-cycle: reward-cycle,
      adapter: adapter,
      amount-sats: amount-sats,
      fee-sats: fee,
      net-sats: net,
      min-stx-out: min-stx-out,
      stx-out: stx-out,
      ;; The two numbers side by side are the whole point of keeping the
      ;; baseline while it is not enforced: `stx-out` is what the market
      ;; actually paid for `net-sats`, `baseline-ustx` is what the
      ;; miner-commit price said it was worth. Their ratio, gathered over
      ;; real swaps, is what `max-slippage-bips` should be set from.
      baseline-ustx: baseline,
      floor-enforced: (var-get enforce-price-floor),
    })
    (ok stx-out)
  )
)

;; Both payout legs for one staker.
;;
;; There is no branch: every staker gets both, and one of them is almost
;; always zero. A fully swapped cycle pays only STX; a timed-out cycle pays
;; only sBTC; a partially swapped cycle that then timed out pays both, in the
;; same proportion for everyone.
;;
;; Fees on the STX leg were already taken at swap time, so only the sBTC leg
;; charges one here.
(define-private (compute-due
    (staker principal)
    (reward-cycle uint)
    (stx-out uint)
    (unswapped uint)
    (total-shares uint)
    (fee-bips uint)
  )
  (let (
      (shares (default-to u0
        (map-get? mirrored-shares {
          staker: staker,
          reward-cycle: reward-cycle,
        })
      ))
      (stx-paid (default-to u0
        (map-get? staker-stx-paid {
          staker: staker,
          reward-cycle: reward-cycle,
        })
      ))
      (sbtc-accounted (default-to u0
        (map-get? staker-sbtc-accounted {
          staker: staker,
          reward-cycle: reward-cycle,
        })
      ))
      ;; Floor division; the remainder stays in the contract as dust.
      (stx-entitled (if (is-eq total-shares u0)
        u0
        (/ (* stx-out shares) total-shares)
      ))
      (sbtc-entitled (if (is-eq total-shares u0)
        u0
        (/ (* unswapped shares) total-shares)
      ))
      (sbtc-gross-due (if (> sbtc-entitled sbtc-accounted)
        (- sbtc-entitled sbtc-accounted)
        u0
      ))
      (sbtc-fee (/ (* sbtc-gross-due fee-bips) BIPS_DENOMINATOR))
    )
    {
      shares: shares,
      stx-entitled: stx-entitled,
      stx-paid: stx-paid,
      stx-due: (if (> stx-entitled stx-paid)
        (- stx-entitled stx-paid)
        u0
      ),
      sbtc-entitled: sbtc-entitled,
      sbtc-accounted: sbtc-accounted,
      sbtc-gross-due: sbtc-gross-due,
      sbtc-fee: sbtc-fee,
      sbtc-due: (- sbtc-gross-due sbtc-fee),
    }
  )
)

;; Pay one staker both legs and advance both watermarks.
(define-private (pay-staker
    (staker principal)
    (reward-cycle uint)
    (due {
      shares: uint,
      stx-entitled: uint,
      stx-paid: uint,
      stx-due: uint,
      sbtc-entitled: uint,
      sbtc-accounted: uint,
      sbtc-gross-due: uint,
      sbtc-fee: uint,
      sbtc-due: uint,
    })
  )
  (let (
      (stx-due (get stx-due due))
      (sbtc-due (get sbtc-due due))
    )
    (if (> stx-due u0)
      (begin
        (map-set staker-stx-paid {
          staker: staker,
          reward-cycle: reward-cycle,
        }
          (get stx-entitled due)
        )
        (var-set unpaid-stx (- (var-get unpaid-stx) stx-due))
        (try! (as-contract? ((with-stx stx-due))
          (try! (stx-transfer? stx-due tx-sender staker))
        ))
      )
      true
    )
    (if (> (get sbtc-gross-due due) u0)
      (begin
        (map-set staker-sbtc-accounted {
          staker: staker,
          reward-cycle: reward-cycle,
        }
          (get sbtc-entitled due)
        )
        ;; The whole gross leaves the reserve: the staker's share as sBTC and
        ;; the pool's cut into `earned-fees`.
        (var-set unswapped-sats
          (- (var-get unswapped-sats) (get sbtc-gross-due due))
        )
        (var-set earned-fees (+ (var-get earned-fees) (get sbtc-fee due)))
        (if (> sbtc-due u0)
          (try! (as-contract?
            ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
              "sbtc-token" sbtc-due
            ))
            (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
              transfer sbtc-due tx-sender staker none
            ))
          ))
          true
        )
      )
      true
    )
    (print {
      topic: "distribute-rewards",
      staker: staker,
      reward-cycle: reward-cycle,
      stx: stx-due,
      sbtc: sbtc-due,
      sbtc-fee: (get sbtc-fee due),
    })
    (ok true)
  )
)

(define-private (fold-distribute
    (staker principal)
    (acc (response {
      reward-cycle: uint,
      stx-out: uint,
      unswapped: uint,
      total-shares: uint,
      fee-bips: uint,
      paid-count: uint,
      total-stx: uint,
      total-sbtc: uint,
    }
      uint
    ))
  )
  (let (
      (state (try! acc))
      (reward-cycle (get reward-cycle state))
      (due (compute-due staker reward-cycle (get stx-out state) (get unswapped state)
        (get total-shares state) (get fee-bips state)
      ))
    )
    ;; A staker with nothing payable is skipped, never an error: one staker
    ;; must not be able to block a batch.
    (if (and (is-eq (get stx-due due) u0) (is-eq (get sbtc-gross-due due) u0))
      (ok state)
      (begin
        (try! (pay-staker staker reward-cycle due))
        (ok (merge state {
          paid-count: (+ (get paid-count state) u1),
          total-stx: (+ (get total-stx state) (get stx-due due)),
          total-sbtc: (+ (get total-sbtc state) (get sbtc-due due)),
        }))
      )
    )
  )
)

;;; Read-only views

(define-read-only (is-admin (caller principal))
  (default-to false (map-get? admins caller))
)

(define-read-only (is-dex-adapter (adapter principal))
  (default-to false (map-get? dex-adapters adapter))
)

(define-read-only (current-cycle)
  (contract-call? 'ST000000000000000000002AMW42H.pox-5 current-pox-reward-cycle)
)

;; The fee rate a `claim-rewards` call would snapshot right now: the pending
;; rate once its activation cycle is reached, otherwise the previous one.
(define-read-only (get-active-fee-bips)
  (if (>= (current-cycle) (var-get pending-fees-cycle))
    (var-get pending-fees-bips)
    (var-get fees-bips)
  )
)

;; The queued rate change, for stakers deciding whether to unstake.
(define-read-only (get-pending-fees)
  {
    pending-bips: (var-get pending-fees-bips),
    activation-cycle: (var-get pending-fees-cycle),
    active-bips: (get-active-fee-bips),
  }
)

(define-read-only (get-fee-bips-for-cycle (reward-cycle uint))
  (default-to (get-active-fee-bips) (map-get? fee-bips-for-cycle reward-cycle))
)

(define-read-only (get-earned-fees)
  (var-get earned-fees)
)

(define-read-only (get-operator)
  (var-get operator)
)

(define-read-only (get-price-oracle)
  (var-get price-oracle)
)

(define-read-only (get-max-slippage-bips)
  (var-get max-slippage-bips)
)

(define-read-only (get-enforce-price-floor)
  (var-get enforce-price-floor)
)

(define-read-only (get-settlement (reward-cycle uint))
  (default-to EMPTY_SETTLEMENT (map-get? cycle-settlement reward-cycle))
)

(define-read-only (is-pinned (reward-cycle uint))
  (get pinned (get-settlement reward-cycle))
)

(define-read-only (get-swap-status (reward-cycle uint))
  (let ((settlement (get-settlement reward-cycle)))
    (merge settlement {
      remaining-sats: (- (get pot-sats settlement) (get swapped-sats settlement)),
      window-open: (and
        (> (get deadline settlement) u0)
        (<= burn-block-height (get deadline settlement))
      ),
    })
  )
)

;; What is left of a cycle's pot in sBTC, once the swap window has closed.
;; Zero while the window is still open, so a distribution mid-swap can never
;; pay away sBTC the operator is still entitled to convert.
(define-read-only (get-unswapped-for-cycle (reward-cycle uint))
  (let ((settlement (get-settlement reward-cycle)))
    (if (and
        (> (get deadline settlement) u0)
        (> burn-block-height (get deadline settlement))
      )
      (- (get pot-sats settlement) (get swapped-sats settlement))
      u0
    )
  )
)

;; The mirror against pox-5's own signer total, for the keeper to check before
;; spending a `pin-shares` transaction.
(define-read-only (check-mirror (reward-cycle uint))
  (let (
      (local (default-to u0 (map-get? mirrored-total-shares reward-cycle)))
      (remote (contract-call? 'ST000000000000000000002AMW42H.pox-5
        get-signer-pending-staked-ustx-per-cycle current-contract reward-cycle
      ))
    )
    {
      local: local,
      pox-5: remote,
      matches: (is-eq local remote),
    }
  )
)

(define-read-only (get-mirrored-shares
    (staker principal)
    (reward-cycle uint)
  )
  (default-to u0
    (map-get? mirrored-shares {
      staker: staker,
      reward-cycle: reward-cycle,
    })
  )
)

(define-read-only (get-mirrored-total-shares (reward-cycle uint))
  (default-to u0 (map-get? mirrored-total-shares reward-cycle))
)

;; Read-only view of what a staker is owed for a cycle. Everything reads zero
;; until the cycle's shares are pinned, which is honest: nothing is payable
;; before the denominator is known.
(define-read-only (get-staker-rewards
    (staker principal)
    (reward-cycle uint)
  )
  (let ((settlement (get-settlement reward-cycle)))
    (compute-due staker reward-cycle (get stx-out settlement)
      (get-unswapped-for-cycle reward-cycle) (get total-shares settlement)
      (get-fee-bips-for-cycle reward-cycle)
    )
  )
)

(define-read-only (get-unswapped-sats)
  (var-get unswapped-sats)
)

(define-read-only (get-unpaid-stx)
  (var-get unpaid-stx)
)

;;; ---------------------------------------------------------------------------
;;; Rendezvous harness -- simnet only
;;; ---------------------------------------------------------------------------
;;
;;   pnpm test:rv            # invariants
;;   pnpm test:rv:prop       # property tests
;;
;; Every definition below carries `#[env(simnet)]`, which clarinet strips from
;; the publish source for any other network. So this costs nothing on chain --
;; and that matters here, because a contract's own source is charged as
;; `read_length` on every call into it.
;;
;; `clarinet check` validates twice, with and without this code, so production
;; code accidentally depending on a test helper is a build error rather than a
;; surprise at deploy time.
;;
;; It lives IN the contract rather than beside it because that is what lets an
;; invariant read private maps and data-vars directly -- the contract does not
;; have to expose its internals just to be testable.
;;
;; Rendezvous drives random sequences of public calls between checks, so an
;; invariant has to hold after ANY reachable state, not just the happy path.

;; --- Rendezvous boilerplate: call counts, so an invariant can condition on
;; --- which functions have run.
;; #[env(simnet)]
(define-map context
  (string-ascii 100)
  { called: uint }
)

;; #[env(simnet)]
(define-private (update-context
    (function-name (string-ascii 100))
    (called uint)
  )
  (ok (map-set context function-name { called: called }))
)

;; #[env(simnet)]
(define-private (calls (function-name (string-ascii 100)))
  (default-to u0 (get called (map-get? context function-name)))
)

;; Cycles the cycle-scoped invariants sweep. Rendezvous feeds arbitrary uints to
;; `claim-rewards` and friends, so a fixed window would miss most of them --
;; these are the low values the generator actually reaches often, plus 0, which
;; is the one every off-by-one lands on.
;; #[env(simnet)]
(define-constant PROBE_CYCLES (list u0 u1 u2 u3 u4 u5 u100 u1000))

;;; ---------------------------------------------------------------------------
;;; Solvency: the contract must always be able to pay what it says it owes
;;; ---------------------------------------------------------------------------

;; Every micro-STX the contract has promised a staker must actually be there.
;; If this ever fails, a distribution has credited more than a swap delivered.
;; #[env(simnet)]
(define-read-only (invariant-stx-liability-is-covered)
  (<= (var-get unpaid-stx) (stx-get-balance current-contract))
)

;; Same for sBTC: accrued fees plus the un-swapped pot can never exceed the
;; balance. This is the property that makes `sweep-sbtc-dust` safe -- it sweeps
;; the difference, so a negative difference would mean sweeping staker funds.
;; #[env(simnet)]
(define-read-only (invariant-sbtc-liability-is-covered)
  (<= (+ (var-get earned-fees) (var-get unswapped-sats))
    (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      get-balance current-contract
    ))
  )
)

;;; ---------------------------------------------------------------------------
;;; Fees
;;; ---------------------------------------------------------------------------

;; The cap is the pool's promise to stakers, and `update-fees` is the only way
;; in. No sequence of calls may leave the active rate above it.
;; #[env(simnet)]
(define-read-only (invariant-fee-never-exceeds-cap)
  (and
    (<= (get-active-fee-bips) MAX_FEE_BIPS)
    (<= (var-get fees-bips) MAX_FEE_BIPS)
    (<= (var-get pending-fees-bips) MAX_FEE_BIPS)
  )
)

;; A rate snapshotted for a cycle is what stakers are charged for it, so it is
;; bound by the same cap -- including for cycles nobody has claimed.
;; #[env(simnet)]
(define-read-only (invariant-snapshotted-fees-within-cap)
  (fold check-cycle-fee PROBE_CYCLES true)
)

;; #[env(simnet)]
(define-private (check-cycle-fee
    (reward-cycle uint)
    (acc bool)
  )
  (and acc (<= (get-fee-bips-for-cycle reward-cycle) MAX_FEE_BIPS))
)

;;; ---------------------------------------------------------------------------
;;; Per-cycle settlement accounting
;;; ---------------------------------------------------------------------------

;; #[env(simnet)]
(define-read-only (invariant-cycle-accounting-is-consistent)
  (fold check-cycle PROBE_CYCLES true)
)

;; #[env(simnet)]
(define-private (check-cycle
    (reward-cycle uint)
    (acc bool)
  )
  (let ((s (get-settlement reward-cycle)))
    (and
      acc
      ;; Never swap more of a pot than was claimed into it. `swap-rewards`
      ;; enforces this per leg; this says the legs cannot add up past it either.
      (<= (get swapped-sats s) (get pot-sats s))
      ;; Fees are taken out of the swapped portion, so they cannot exceed it.
      (<= (get fee-sats s) (get swapped-sats s))
      ;; STX only ever arrives by swapping, so proceeds without a swap would
      ;; mean STX was credited to a cycle that never sold anything.
      (or (is-eq (get stx-out s) u0) (> (get swapped-sats s) u0))
      ;; A cycle that has never been claimed has no deadline, and one that has
      ;; been claimed has both a deadline and a pot.
      (or (is-eq (get deadline s) u0) (> (get pot-sats s) u0))
    )
  )
)

;; Pinning freezes the denominator. Once pinned it must never move again --
;; every payout for the cycle divides by it, so a change would re-price
;; entitlements retroactively.
;; #[env(simnet)]
(define-read-only (invariant-pinned-denominator-is-frozen)
  (fold check-pin PROBE_CYCLES true)
)

;; #[env(simnet)]
(define-private (check-pin
    (reward-cycle uint)
    (acc bool)
  )
  (let ((s (get-settlement reward-cycle)))
    (and
      acc
      ;; An unpinned cycle must not carry a denominator.
      (or (get pinned s) (is-eq (get total-shares s) u0))
      ;; A cycle can only be pinned after it has been claimed.
      (or (not (get pinned s)) (> (get deadline s) u0))
    )
  )
)

;;; ---------------------------------------------------------------------------
;;; Entitlements
;;; ---------------------------------------------------------------------------

;; Nobody can be owed anything from a cycle with no shares in it. This is the
;; guard against a divide-by-zero turning into a free payout.
;; #[env(simnet)]
(define-read-only (invariant-no-dues-without-shares)
  (fold check-no-dues PROBE_CYCLES true)
)

;; #[env(simnet)]
(define-private (check-no-dues
    (reward-cycle uint)
    (acc bool)
  )
  (let (
      (s (get-settlement reward-cycle))
      (due (get-staker-rewards tx-sender reward-cycle))
    )
    (and
      acc
      (or
        (> (get total-shares s) u0)
        (and (is-eq (get stx-due due) u0) (is-eq (get sbtc-due due) u0))
      )
      ;; A staker can never be paid more than the cycle took in.
      (<= (get stx-entitled due) (get stx-out s))
    )
  )
)

;;; ---------------------------------------------------------------------------
;;; Property tests
;;; ---------------------------------------------------------------------------

;; Rendezvous calls from arbitrary senders, and every `update-fees` property
;; below has to reckon with that: the cap and the authorization gate are two
;; separate rules, and a test that conflates them fails for the wrong reason.
;; Returning `(ok false)` discards the run instead.
;; #[env(simnet)]
(define-private (admin-only)
  (and (is-eq contract-caller tx-sender) (is-admin tx-sender))
)

;; A rate over the cap is refused no matter WHO asks -- this half needs no
;; precondition, and is the half that actually protects stakers.
;; #[env(simnet)]
(define-private (test-update-fees-rejects-above-cap (new-fees uint))
  (begin
    (asserts! (or (<= new-fees MAX_FEE_BIPS) (is-err (update-fees new-fees)))
      (err u9001)
    )
    (ok true)
  )
)

;; ...and an admin asking for a rate within the cap always gets it.
;; #[env(simnet)]
(define-private (test-update-fees-accepts-up-to-cap (new-fees uint))
  (if (not (admin-only))
    (ok false)
    (begin
      (asserts! (or (> new-fees MAX_FEE_BIPS) (is-ok (update-fees new-fees)))
        (err u9008)
      )
      (ok true)
    )
  )
)

;; A fee INCREASE must not reach the active rate in the same cycle it is
;; queued: that delay is what gives a staker time to unstake.
;; #[env(simnet)]
(define-private (test-fee-increase-is-not-immediate (new-fees uint))
  (if (or (not (admin-only)) (> new-fees MAX_FEE_BIPS))
    (ok false)
    (let ((before (get-active-fee-bips)))
      (asserts!
        (or
          (<= new-fees before)
          (and
            (is-ok (update-fees new-fees))
            (is-eq (get-active-fee-bips) before)
          )
        )
        (err u9002)
      )
      (ok true)
    )
  )
)

;; A fee DECREASE applies at once -- it can only ever help stakers, so there is
;; nothing to protect them from.
;; #[env(simnet)]
(define-private (test-fee-decrease-is-immediate (new-fees uint))
  (if (or (not (admin-only)) (> new-fees MAX_FEE_BIPS))
    (ok false)
    (let ((before (get-active-fee-bips)))
      (asserts!
        (or
          (> new-fees before)
          (and
            (is-ok (update-fees new-fees))
            (is-eq (get-active-fee-bips) new-fees)
          )
        )
        (err u9003)
      )
      (ok true)
    )
  )
)

;; Pinning is idempotent: the runbook has `swap-rewards` and `distribute-*` call
;; it implicitly, so it gets invoked repeatedly and must settle on one answer.
;; #[env(simnet)]
(define-private (test-pin-shares-is-idempotent (reward-cycle uint))
  (let ((first (pin-shares reward-cycle)))
    (asserts! (is-eq (is-ok first) (is-ok (pin-shares reward-cycle))) (err u9004))
    (asserts! (or (is-err first) (is-eq first (pin-shares reward-cycle)))
      (err u9005)
    )
    (ok true)
  )
)

;; A cycle that was never claimed owes nobody anything, whatever else has
;; happened. This is the one that would catch a distribution reading a
;; default-initialised settlement as if it were real.
;; #[env(simnet)]
(define-private (test-unclaimed-cycle-pays-nothing
    (staker principal)
    (reward-cycle uint)
  )
  (let ((s (get-settlement reward-cycle)))
    (asserts!
      (or
        (> (get deadline s) u0)
        (is-err (distribute-rewards staker reward-cycle))
      )
      (err u9006)
    )
    (ok true)
  )
)

;; Entitlement rises with the size of the pot and never with anything else:
;; for a fixed cycle, asking twice without a swap in between gives the same
;; answer. Guards against a read-only view with a side effect in it.
;; #[env(simnet)]
(define-private (test-staker-rewards-is-stable
    (staker principal)
    (reward-cycle uint)
  )
  (begin
    (asserts!
      (is-eq (get stx-due (get-staker-rewards staker reward-cycle))
        (get stx-due (get-staker-rewards staker reward-cycle))
      )
      (err u9007)
    )
    (ok true)
  )
)
