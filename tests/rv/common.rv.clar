;; ============================================================================
;; RENDEZVOUS block (test-only, appended by tests/rv/build.py): swap-vault
;; views, per-call transition checks and vault invariants.
;;
;; build.py instantiates this block twice: inside the solo vault (@V = the
;; vault itself, @P = its pool = the deployer wallet) and inside the signer
;; (@V = .fastpool-swap-vault, @P = the signer). `@(fn ...)` is a call to a
;; vault read-only.
;;
;; RV calls the target's private `update-context` after every SUCCESSFUL
;; public call (failed calls revert, so the state before a call is the
;; snapshot taken after the previous success). The target's update-context
;; runs `rv-vcheck` with the kind of the call that just succeeded and then
;; re-snapshots. A broken rule bumps a named counter; the invariant-v-*
;; functions below require every counter to stay at zero.
;; ============================================================================

(define-constant RV_WALLETS (list
  'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM
  'ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5
  'ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG
  'ST2JHG361ZXG51QTKY2NQCVBPPRRE2KZB1HR05NNC
  'ST2NEB84ASENDXKYGJPQW86YXQCEFEX2ZQPG87ND
  'ST2REHHS5J3CERCRBEPMGH7921Q6PYKAADT7JP2VB
  'ST3AM1A56AK2C1XAFJ4115ZSV26EB49BVQ10MGCS0
  'ST3PF13W7Z0RRM42A8VZRVFQ75SV1K26RXEP8YGKJ
  'ST3NBRSFKX28FQ2ZJ1MAKX58HKHSDGNV5N7R21XCP
  'STNHKEPYEPJ8ET55ZZ0M5A34J0R3N5FM2CMMMAZ6))
(define-constant RV_BPS u10000)
(define-constant RV_FO_DIV u10000000000)
(define-constant RV_SLACK u8)
;; a Jing fill pays the 10 bps maker/taker fee and the taker rebate (<= 70
;; bps) on top of the clearing price; 80 bps is the most a fill at or above
;; the limit can come back under limit * sold
(define-constant RV_FILL_MARGIN_BPS u80)

;; kinds of a successful call (the target maps function names to these)
(define-constant K_OTHER u0)
(define-constant K_ROUTER u1)
(define-constant K_SPLIT u2)
(define-constant K_DIA u3)
(define-constant K_TAKE u4)
(define-constant K_FINISH u5)
(define-constant K_FUND u6)
(define-constant K_RECOVER u7)
(define-constant K_CLOSE u8)
(define-constant K_PLACE u9)
(define-constant K_REFLOOR u10)
(define-constant K_MARKET u11) ;; a wallet's market call (bid, cancel, settle)

(define-map rv-viol (string-ascii 16) uint)
(define-map rv-seen (string-ascii 16) uint)
(define-read-only (rv-viol-of (k (string-ascii 16))) (default-to u0 (map-get? rv-viol k)))
(define-read-only (rv-seen-of (k (string-ascii 16))) (default-to u0 (map-get? rv-seen k)))
(define-private (rv-bad (k (string-ascii 16)))
  (begin (print { rv-violation: k, burn: burn-block-height }) (map-set rv-viol k (+ u1 (rv-viol-of k)))))
(define-private (rv-hit (k (string-ascii 16))) (map-set rv-seen k (+ u1 (rv-seen-of k))))

(define-private (rv-min (a uint) (b uint)) (if (< a b) a b))
(define-private (rv-sbtc (who principal)) (unwrap-panic (contract-call? .mock-ft get-balance who)))
(define-private (rv-mkt-total (who principal))
  (let ((c (contract-call? .v6-market get-current-cycle)))
    (+ (contract-call? .v6-market get-token-x-deposit c who)
       (contract-call? .v6-market get-token-x-parked who)
       (default-to u0 (get amount (contract-call? .v6-market get-token-x-pending-deposit who))))))
;; the vault's own formulas, restated: floor-out, mid * (1 - bps)
(define-private (rv-fo (amount uint) (limit uint)) (/ (* amount limit) RV_FO_DIV))
(define-private (rv-under (mid uint) (bps uint)) (/ (* mid (- RV_BPS bps)) RV_BPS))

(define-private (rv-vstate)
  (let ((clock @(get-clock)) (cfg @(get-config)))
    {
      vs: (rv-sbtc @V),
      vx: (stx-get-balance @V),
      vm: (rv-mkt-total @V),
      ps: (rv-sbtc @P),
      px: (stx-get-balance @P),
      os: (stx-get-balance .mock-lazer-oracle),
      start: (get batch-start clock),
      ready: (get ready-to-finish clock),
      ol: (get limit (contract-call? .v6-market get-token-x-order @V)),
      budget: (get pyth-fee-budget cfg),
    }))

(define-data-var rv-vsnap {
    vs: uint, vx: uint, vm: uint, ps: uint, px: uint, os: uint,
    start: (optional uint), ready: bool, ol: uint, budget: uint,
  } {
    vs: u0, vx: u0, vm: u0, ps: u0, px: u0, os: u0,
    start: none, ready: false, ol: u0, budget: u0,
  })
(define-private (rv-vsnap-take) (var-set rv-vsnap (rv-vstate)))

(define-private (rv-vault-pays (kind uint))
  (or (is-eq kind K_ROUTER) (is-eq kind K_SPLIT) (is-eq kind K_TAKE)
      (is-eq kind K_PLACE) (is-eq kind K_REFLOOR)))

(define-private (rv-vcheck (kind uint))
  (let (
      (s (var-get rv-vsnap))
      (n (rv-vstate))
      (mid (contract-call? .mock-lazer-oracle get-mid))
      (cfg @(get-config))
      (wb (get window-blocks cfg))
      (slip (get slippage-bps cfg))
      ;; the oracle's STX only grows; in a vault-paying call all of it is the vault's fee
      (fee (- (get os n) (get os s)))
      (before (+ (get vs s) (get vm s)))
      (after (+ (get vs n) (get vm n)))
      (sold (if (> before after) (- before after) u0))
      ;; gross STX the vault received in the call (its fees added back)
      (got (if (>= (+ (get vx n) fee) (get vx s)) (- (+ (get vx n) fee) (get vx s)) u0))
      (sale (and (>= kind K_ROUTER) (<= kind K_TAKE)))
      (was-elapsed (match (get start s) st (>= burn-block-height (+ st wb)) false))
      (was-open (match (get start s) st (< burn-block-height (+ st wb)) false))
      (order (contract-call? .v6-market get-token-x-order @V))
    )
    (and sale (rv-hit "sale"))
    ;; 1. the patience phase never sells
    (and sale (not was-elapsed) (rv-bad "patience"))
    ;; 2. never below the floor (on observed balances, not on reports)
    (and (is-eq kind K_ROUTER)
      (not (and (> sold RV_SLACK) (>= got (rv-fo (- sold RV_SLACK) (rv-under mid slip)))))
      (rv-bad "floor"))
    (and (is-eq kind K_SPLIT)
      (< (+ got u1) (rv-fo sold (rv-min (rv-under mid slip) (rv-under mid u60))))
      (rv-bad "floor"))
    (and (is-eq kind K_DIA)
      (match @(get-no-pyth-price) p (< got (rv-fo sold (get limit p))) e false)
      (rv-bad "floor"))
    (and (is-eq kind K_TAKE)
      (< (* (+ got u2) RV_BPS) (* (rv-fo sold (rv-under mid slip)) (- RV_BPS RV_FILL_MARGIN_BPS)))
      (rv-bad "floor"))
    ;; a fill of the resting ask by someone else's settle: at or above its guard
    (and (is-eq kind K_MARKET) (> sold u0)
      (begin (rv-hit "maker-fill") true)
      (< (* (+ (- (get vx n) (rv-min (get vx n) (get vx s))) u2) RV_BPS)
         (* (rv-fo sold (get ol s)) (- RV_BPS RV_FILL_MARGIN_BPS)))
      (rv-bad "floor"))
    ;; 3. STX leaves the vault only as its own Lazer fees, to the pool on finish / recover
    (and (rv-vault-pays kind) (< (+ (get vx n) fee) (get vx s)) (rv-bad "stx-out"))
    (and (not (rv-vault-pays kind)) (not (is-eq kind K_FINISH)) (not (is-eq kind K_RECOVER))
      (< (get vx n) (get vx s)) (rv-bad "stx-out"))
    ;; 4. a vault call spends at most two verifies' worth of the budget
    (and (rv-vault-pays kind) (> fee (* u2 (get budget s))) (rv-bad "fee"))
    ;; 5. finish returns balance - min(balance, budget) to the pool, keeps the rest
    (and (is-eq kind K_FINISH) (begin (rv-hit "finish") true)
      (not (and (get ready s) (not (get ready n)) (is-none (get start n))
        (is-eq (get px n) (+ (get px s) (- (get vx s) (rv-min (get vx s) (get budget s)))))
        (is-eq (get vx n) (rv-min (get vx s) (get budget s)))))
      (rv-bad "finish"))
    ;; 6. funding only opens a batch from idle, and the sats come from the pool
    (and (is-eq kind K_FUND)
      (not (and (is-none (get start s)) (not (get ready s))
        (is-eq (get start n) (some burn-block-height))
        (>= (get ps s) (get ps n))
        (is-eq (get vs n) (+ (get vs s) (- (get ps s) (get ps n))))))
      (rv-bad "fund"))
    ;; 7. emergency recovery sends every sat and uSTX home and clears the clock
    (and (is-eq kind K_RECOVER) (begin (rv-hit "recover") true)
      (not (and (is-eq (get vs n) u0) (is-eq (get vm n) u0) (is-eq (get vx n) u0)
        (is-none (get start n)) (not (get ready n))
        (is-eq (get ps n) (+ (get ps s) (get vs s) (get vm s)))
        (is-eq (get px n) (+ (get px s) (get vx s)))))
      (rv-bad "recover"))
    ;; 8. close-batch leaves an empty vault ready to finish
    (and (is-eq kind K_CLOSE)
      (not (and (get ready n) (is-none (get start n)) (<= (get vs n) u2) (is-eq (get vm n) u0)))
      (rv-bad "close"))
    ;; 9. the clock: never re-armed, ready only on an empty vault, cleared only by finish / recover
    (and (not (is-eq kind K_FUND)) (is-some (get start n)) (not (is-eq (get start n) (get start s)))
      (rv-bad "clock"))
    (and (get ready n) (not (get ready s))
      (not (and (is-none (get start n)) (<= (get vs n) u2) (is-eq (get vm n) u0)))
      (rv-bad "clock"))
    (and (get ready s) (not (get ready n)) (not (is-eq kind K_FINISH)) (not (is-eq kind K_RECOVER))
      (rv-bad "clock"))
    ;; 10. placement: only while open, the whole wallet, a zero-spread peg at ask-of(mid)
    (and (is-eq kind K_PLACE) (begin (rv-hit "place") true)
      (not (and was-open (is-eq (get vs n) u0)
        (is-eq order { limit: (rv-under mid (get leeway-bps cfg)), spread-bps: (some u0) })))
      (rv-bad "place"))
    (and (is-eq kind K_REFLOOR)
      (not (is-eq order { limit: (rv-under mid (if was-open (get leeway-bps cfg) slip)), spread-bps: (some u0) }))
      (rv-bad "refloor"))
    true))

;; ---------------------------------------------------------------------------
;; vault invariants
;; ---------------------------------------------------------------------------

(define-read-only (invariant-v-no-floor-breach) (is-eq (rv-viol-of "floor") u0))
(define-read-only (invariant-v-no-patience-sale) (is-eq (rv-viol-of "patience") u0))
(define-read-only (invariant-v-stx-out-only-to-pool-or-fee) (is-eq (rv-viol-of "stx-out") u0))
(define-read-only (invariant-v-fee-within-budget) (is-eq (rv-viol-of "fee") u0))
(define-read-only (invariant-v-finish-keeps-reserve) (is-eq (rv-viol-of "finish") u0))
(define-read-only (invariant-v-fund-only-from-idle) (is-eq (rv-viol-of "fund") u0))
(define-read-only (invariant-v-recover-sends-all) (is-eq (rv-viol-of "recover") u0))
(define-read-only (invariant-v-close-is-empty) (is-eq (rv-viol-of "close") u0))
(define-read-only (invariant-v-clock-transitions) (is-eq (rv-viol-of "clock") u0))
(define-read-only (invariant-v-place-is-peg) (and (is-eq (rv-viol-of "place") u0) (is-eq (rv-viol-of "refloor") u0)))
;; sBTC leaves a vault only to its pool, the market or the router (mock-ft ghost)
(define-read-only (invariant-v-sbtc-destinations) (is-eq (contract-call? .mock-ft get-bad-vault-transfers) u0))

(define-read-only (invariant-v-batch-xor-ready)
  (let ((c @(get-clock)))
    (not (and (is-some (get batch-start c)) (get ready-to-finish c)))))
(define-read-only (invariant-v-window-exclusive)
  (let ((c @(get-clock)))
    (and (not (and (get window-open c) (get window-elapsed c)))
         (or (is-some (get batch-start c)) (and (not (get window-open c)) (not (get window-elapsed c)))))))
(define-read-only (invariant-v-config-bounded)
  (let ((c @(get-config)))
    (and (<= (get window-blocks c) u288) (< (get window-blocks c) (get recovery-delay-blocks c))
         (<= (get leeway-bps c) u1000) (<= (get slippage-bps c) u1000)
         (<= (get no-pyth-slippage-bps c) u5000) (<= (get dia-band-bps c) u5000)
         (> (get max-chunk-sats c) u0) (<= (get max-chunk-sats c) u100000000)
         (<= (get router-cooldown-blocks c) u144) (<= (get pyth-fee-budget c) u10000000)
         (<= (get last-router-swap c) burn-block-height))))
(define-read-only (invariant-v-clock-not-future)
  (match (get batch-start @(get-clock)) s (<= s burn-block-height) true))
;; whatever rests on the book is a guarded zero-spread peg
(define-read-only (invariant-v-resting-peg)
  (or (is-eq (rv-mkt-total @V) u0)
      (let ((o (contract-call? .v6-market get-token-x-order @V)))
        (and (> (get limit o) u0) (is-eq (get spread-bps o) (some u0))))))
;; every sat is somewhere we can see: the strict ledger's supply equals the
;; holders the harness can move sats between
(define-private (rv-wallet-sbtc (w principal) (acc uint)) (+ acc (rv-sbtc w)))
(define-read-only (invariant-v-sbtc-conservation)
  (is-eq (unwrap-panic (contract-call? .mock-ft get-total-supply))
    (+ (fold rv-wallet-sbtc RV_WALLETS u0)
       (rv-sbtc 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.fastpool-swap-vault-solo)
       (rv-sbtc 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.fastpool-swap-vault)
       (rv-sbtc 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager-vault-stx-rewards)
       (rv-sbtc 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.v6-market)
       (rv-sbtc 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.mock-router)
       (rv-sbtc 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.mock-pox))))

;; ---------------------------------------------------------------------------
;; world wrappers shared by both invariant targets
;; ---------------------------------------------------------------------------

;; Lazer mid in [2.4e13, 4.0e13) (250 to 417 sats per STX)
(define-public (rv-mid (raw uint))
  (contract-call? .mock-lazer-oracle set-mid (+ u24000000000000 (* (mod raw u16000) u1000000000))))
;; router: two times in three just under the mid (89%..100%, where the
;; liquidation floor sits), else 70%..106%; a partial fill two times in three
(define-public (rv-router-knobs (q uint) (f uint))
  (begin
    (try! (contract-call? .mock-router set-quality
      (if (is-eq (mod q u3) u0) (+ u7000 (mod q u3600)) (- u10000 (mod q u1101)))))
    (contract-call? .mock-router set-fill (if (is-eq (mod f u3) u0) u10000 (mod f u10001)))))
(define-public (rv-fund-router (raw uint))
  (stx-transfer? (+ u1000000 (mod raw u1000000000)) tx-sender .mock-router))
(define-public (rv-world (raw uint))
  (begin
    (try! (contract-call? .mock-dia set-stale (is-eq (mod raw u10) u0)))
    (try! (contract-call? .mock-dia set-failed (is-eq (mod raw u12) u0)))
    (try! (contract-call? .mock-native set-failed (is-eq (mod raw u13) u0)))
    (try! (contract-call? .mock-native set-mid (if (is-eq (mod raw u17) u0) u0 (contract-call? .mock-lazer-oracle get-mid))))
    ;; DIA within +-4% of the Lazer mid most of the time, +-15% one call in eight
    (contract-call? .mock-dia set-skew
      (if (is-eq (mod raw u8) u1) (+ u8500 (mod raw u3001)) (+ u9600 (mod raw u801))))))
;; back to a calm world: DIA agrees and is fresh, no Lazer fee, honest router
(define-public (rv-calm)
  (begin
    (try! (contract-call? .mock-dia set-stale false))
    (try! (contract-call? .mock-dia set-failed false))
    (try! (contract-call? .mock-dia set-skew u10000))
    (try! (contract-call? .mock-native set-failed false))
    (try! (contract-call? .mock-lazer-oracle set-fee u0))
    (try! (contract-call? .mock-router set-quality u10000))
    (contract-call? .mock-router set-fill u10000)))
(define-public (rv-oracle-fee (raw uint))
  (contract-call? .mock-lazer-oracle set-fee
    (unwrap-panic (element-at? (list u0 u0 u0 u0 u0 u500 u1000 u250000) (mod raw u8)))))
;; a wallet bid (k = K_MARKET): STX at mid +- 1.5%, fixed or pegged
(define-public (rv-bid (amount uint) (off uint) (peg bool))
  (let ((mid (contract-call? .mock-lazer-oracle get-mid)))
    (contract-call? .v6-market deposit-token-y (+ u1000000 (mod amount u2000000000))
      (/ (* mid (- (+ RV_BPS (mod off u301)) u150)) RV_BPS)
      (if peg (some u0) none) 0x .mock-ft "mock-ft")))
(define-public (rv-cancel-bid)
  (contract-call? .v6-market cancel-token-y-deposit .mock-ft "mock-ft"))
(define-public (rv-settle)
  (contract-call? .v6-market settle-with-refresh 0x .mock-ft "mock-ft" .mock-ft "mock-ft"))
;; the market fixture's operator knobs, reset (see the market's own RV notes)
(define-public (rv-market-reset)
  (begin (unwrap-panic (contract-call? .v6-market rv-unpause)) (contract-call? .v6-market rv-reset-mins)))
;; coverage: a calm world, then the permissionless sale (kind K_ROUTER; the
;; floor check reads the mid and slippage after the call, both unchanged)
(define-public (rv-drain)
  (begin (try! (rv-calm)) @(router-swap 0x)))
