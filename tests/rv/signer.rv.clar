;; ============================================================================
;; RENDEZVOUS invariant target `signer-manager-vault-stx-rewards` (test-only).
;; Production wiring: the signer is POOL of `.fastpool-swap-vault`; pox-5 is
;; `.mock-pox`. The common block above checks the vault on every call; this
;; block adds the signer's accounting.
;; ============================================================================

(define-map context (string-ascii 100) { called: uint })

(define-constant RV_VAULT .fastpool-swap-vault)

(define-private (rv-kind (name (string-ascii 100)))
  (if (or (is-eq name "rv-sell") (is-eq name "rv-drain")) K_ROUTER
  (if (or (is-eq name "router-swap-split") (is-eq name "rv-split")) K_SPLIT
  (if (or (is-eq name "router-swap-split-dia") (is-eq name "rv-dia")) K_DIA
  (if (or (is-eq name "jing-take") (is-eq name "rv-take")) K_TAKE
  (if (or (is-eq name "finalize-swap-vault") (is-eq name "rv-finalize")) K_FINISH
  (if (or (is-eq name "fund-swap-vault") (is-eq name "rv-fund-vault")) K_FUND
  (if (or (is-eq name "recover-swap-vault") (is-eq name "rv-recover")) K_RECOVER
  (if (is-eq name "rv-close") K_CLOSE
  (if (is-eq name "rv-place") K_PLACE
  (if (or (is-eq name "refloor-vault") (is-eq name "rv-refloor")) K_REFLOOR
  (if (or (is-eq name "rv-bid") (is-eq name "rv-cancel-bid") (is-eq name "rv-settle")) K_MARKET
    K_OTHER))))))))))))

;; --- signer accounting snapshot / transition checks ------------------------

(define-constant RV_CYCLES (list u0 u1 u2 u3 u4 u5 u6 u7))
(define-data-var rv-charged uint u0)   ;; fee sats charged, ever
(define-data-var rv-withdrawn uint u0) ;; fee sats withdrawn, ever
;; last seen settlement figures per cycle (fee and swapped move only in
;; fund-swap-vault, which sets vault-cycle in the same call)
(define-map rv-seen-cycle uint { fee: uint, swapped: uint })

(define-private (rv-sstate)
  {
    sb: (rv-sbtc current-contract),
    sx: (stx-get-balance current-contract),
    vs: (rv-sbtc RV_VAULT),
    earned: (var-get earned-fees),
    unswapped: (var-get unswapped-sats),
    unpaid: (var-get unpaid-stx),
    vcycle: (var-get vault-cycle),
  })
(define-data-var rv-ssnap {
    sb: uint, sx: uint, vs: uint, earned: uint, unswapped: uint, unpaid: uint,
    vcycle: (optional uint),
  } { sb: u0, sx: u0, vs: u0, earned: u0, unswapped: u0, unpaid: u0, vcycle: none })

(define-private (rv-scheck (name (string-ascii 100)))
  (let (
      (s (var-get rv-ssnap))
      (n (rv-sstate))
      (c (default-to u0 (get vcycle n)))
      (st (get-settlement c))
      (seen (default-to { fee: u0, swapped: u0 } (map-get? rv-seen-cycle c)))
      (fee-delta (if (and (is-some (get vcycle n)) (> (get fee-sats st) (get fee seen))) (- (get fee-sats st) (get fee seen)) u0))
      (unfunded (if (and (is-some (get vcycle n)) (> (get swapped-sats st) (get swapped seen))) (- (get swapped-sats st) (get swapped seen)) u0))
      (is-fund (or (is-eq name "fund-swap-vault") (is-eq name "rv-fund-vault")))
      (is-dist (or (is-eq name "distribute-rewards") (is-eq name "distribute-rewards-many")
                   (is-eq name "rv-dist") (is-eq name "rv-dist-one")))
      (is-withdraw (or (is-eq name "withdraw-fees") (is-eq name "rv-withdraw")))
    )
    (and (is-some (get vcycle n)) (map-set rv-seen-cycle c { fee: (get fee-sats st), swapped: (get swapped-sats st) }))
    (var-set rv-charged (+ (var-get rv-charged) fee-delta))
    (and (< (get earned n) (get earned s))
      (var-set rv-withdrawn (+ (var-get rv-withdrawn) (- (get earned s) (get earned n)))))
    ;; earned grows only on funding (by exactly the fee charged), shrinks only on withdraw
    (and (> (get earned n) (get earned s)) (not (and is-fund (is-eq (get earned n) (+ (get earned s) fee-delta))))
      (rv-bad "earned"))
    (and (< (get earned n) (get earned s)) (not is-withdraw) (rv-bad "earned"))
    (and (> fee-delta u0) (not is-fund) (rv-bad "earned"))
    ;; funding: fee = floor(unfunded * bips / 1e4) at the cycle's rate, the
    ;; vault gets the rest, the liability drops by the gross
    (and is-fund
      (not (and (> unfunded u0)
        (< (get-fee-bips-for-cycle c) MAX_BIPS)
        (is-eq fee-delta (/ (* unfunded (get-fee-bips-for-cycle c)) MAX_BIPS))
        (is-eq (get vs n) (+ (get vs s) (- unfunded fee-delta)))
        (is-eq (+ (get unswapped n) unfunded) (get unswapped s))
        (is-eq (+ (get sb n) (- unfunded fee-delta)) (get sb s))))
      (rv-bad "fund-acct"))
    ;; STX: every uSTX credited is what arrived, every uSTX paid is what was debited
    (and (> (get sx n) (get sx s)) (not (is-eq (- (get sx n) (get sx s)) (- (get unpaid n) (rv-min (get unpaid n) (get unpaid s)))))
      (not (is-eq name "rv-donate-stx"))
      (rv-bad "stx-acct"))
    (and (< (get sx n) (get sx s))
      (not (or (and is-dist (is-eq (- (get sx s) (get sx n)) (- (get unpaid s) (get unpaid n))))
               (and (is-eq name "sweep-stx-dust") (is-eq (get sx n) (get unpaid n)))))
      (rv-bad "stx-acct"))
    (and (not (is-eq (get unpaid n) (get unpaid s))) (is-eq (get sx n) (get sx s)) (rv-bad "stx-acct"))
    ;; sBTC out of the signer: funding, timeout payouts, fee withdrawals, dust sweeps only
    (and (< (get sb n) (get sb s))
      (not (or is-fund
               (and is-dist (is-eq (- (get sb s) (get sb n))
                  (- (- (get unswapped s) (get unswapped n)) (- (get earned n) (get earned s)))))
               (and is-withdraw (is-eq (- (get sb s) (get sb n)) (- (get earned s) (get earned n))))
               (and (is-eq name "sweep-sbtc-dust") (is-eq (get sb n) (+ (get earned n) (get unswapped n))))))
      (rv-bad "sbtc-acct"))
    true))

(define-private (update-context (function-name (string-ascii 100)) (called uint))
  (begin
    (map-set context function-name { called: called })
    (and (> called u0) (rv-vcheck (rv-kind function-name)) (rv-scheck function-name))
    (rv-vsnap-take)
    (var-set rv-ssnap (rv-sstate))
    (ok true)))

;; --- signer invariants -------------------------------------------------------

(define-read-only (invariant-s-fee-bips-bounded) (< (var-get fees-bips) MAX_BIPS))
(define-read-only (invariant-s-earned-is-charged-minus-withdrawn)
  (and (is-eq (rv-viol-of "earned") u0)
       (<= (var-get rv-withdrawn) (var-get rv-charged))
       (is-eq (var-get earned-fees) (- (var-get rv-charged) (var-get rv-withdrawn)))))
(define-read-only (invariant-s-funding-accounting) (is-eq (rv-viol-of "fund-acct") u0))
(define-read-only (invariant-s-stx-accounting) (is-eq (rv-viol-of "stx-acct") u0))
(define-read-only (invariant-s-sbtc-accounting) (is-eq (rv-viol-of "sbtc-acct") u0))
;; the contract always holds what it owes
(define-read-only (invariant-s-sbtc-covers-obligations)
  (>= (rv-sbtc current-contract) (+ (var-get earned-fees) (var-get unswapped-sats))))
(define-read-only (invariant-s-stx-covers-unpaid)
  (>= (stx-get-balance current-contract) (var-get unpaid-stx)))
;; a vault cycle is in flight exactly while the vault has a batch or awaits finish
(define-read-only (invariant-s-vault-cycle-matches-vault)
  (let ((c (contract-call? .fastpool-swap-vault get-clock)))
    (is-eq (is-some (var-get vault-cycle))
      (or (is-some (get batch-start c)) (get ready-to-finish c)))))
;; per tracked cycle: no stacker paid past the pot, fees within the rate cap
(define-private (rv-paid-fold (w principal) (acc { c: uint, stx: uint, sbtc: uint }))
  (merge acc {
    stx: (+ (get stx acc) (default-to u0 (map-get? stacker-stx-paid { stacker: w, reward-cycle: (get c acc) }))),
    sbtc: (+ (get sbtc acc) (default-to u0 (map-get? stacker-sbtc-accounted { stacker: w, reward-cycle: (get c acc) }))),
  }))
(define-private (rv-cycle-ok (c uint) (acc bool))
  (let ((st (get-settlement c))
        (paid (fold rv-paid-fold RV_WALLETS { c: c, stx: u0, sbtc: u0 })))
    (and acc
      (<= (get stx paid) (get stx-out st))
      (<= (get sbtc paid) (get-unswapped-for-cycle c))
      (<= (get swapped-sats st) (get pot-sats st))
      (<= (* (get fee-sats st) MAX_BIPS) (* (get swapped-sats st) (- MAX_BIPS u1)))
      (or (get pinned st) (is-eq (get stx-out st) u0)))))
(define-read-only (invariant-s-cycles-bounded) (fold rv-cycle-ok RV_CYCLES true))

;; --- wrappers ------------------------------------------------------------------

(define-private (rv-wallet (raw uint)) (unwrap-panic (element-at? RV_WALLETS (mod raw u10))))
(define-private (rv-claimed (c uint)) (> (get deadline (get-settlement c)) u0))

;; a pox-5 stake: the mock records the shares, then the production mirror
;; fold runs exactly as validate-stake! would after pox-5's callback (a real
;; callback from inside this call would be a Clarity CircularReference).
;; Only cycles not yet claimed, as pox-5 only stakes into future cycles.
(define-private (rv-pox-set (off uint) (acc { who: principal, first: uint, shares: uint }))
  (begin (unwrap-panic (contract-call? .mock-pox set-shares (get who acc) (+ (get first acc) off) (get shares acc))) acc))
(define-public (rv-stake (who uint) (c uint) (n uint) (amount uint))
  (let ((w (rv-wallet who)) (first (mod c u8)) (num (+ u1 (mod n u3)))
        (shares (+ u1000000 (mod amount u1000000000000)))
        (offs (unwrap-panic (slice? CYCLE_OFFSETS u0 num))))
    (asserts! (not (rv-claimed first)) ERR_SHARES_ALREADY_PINNED)
    (fold rv-pox-set offs { who: w, first: first, shares: shares })
    (fold mirror-stake-for-cycle offs { stacker: w, first-reward-cycle: first, shares: shares })
    (ok true)))
;; pox-5 unstake: future shares drop, no callback (mirror drifts high)
(define-public (rv-unstake (who uint) (c uint))
  (begin
    (asserts! (not (rv-claimed (mod c u8))) ERR_SHARES_ALREADY_PINNED)
    (contract-call? .mock-pox set-shares (rv-wallet who) (mod c u8) u0)))
(define-public (rv-repair (c uint)) (repair-mirror-many RV_WALLETS (mod c u8)))
(define-public (rv-reward (c uint) (amount uint))
  (contract-call? .mock-pox add-rewards (mod c u8) (+ u1000 (mod amount u5000000))))
(define-public (rv-claim (c uint)) (claim-rewards (mod c u8)))
(define-public (rv-pin (c uint)) (pin-shares (mod c u8)))
(define-public (rv-fund-vault (c uint)) (fund-swap-vault (mod c u8) .fastpool-swap-vault))
(define-public (rv-finalize) (finalize-swap-vault .fastpool-swap-vault))
(define-public (rv-recover) (recover-swap-vault .fastpool-swap-vault))
(define-public (rv-dist (c uint)) (distribute-rewards-many RV_WALLETS (mod c u8)))
(define-public (rv-dist-one (who uint) (c uint)) (distribute-rewards (rv-wallet who) (mod c u8)))
(define-public (rv-withdraw (raw uint))
  (withdraw-fees (rv-min (+ u1 raw) (var-get earned-fees)) tx-sender))
(define-public (rv-fees (raw uint)) (update-fees (mod raw u3000)))
;; the vault's permissionless entries (anyone; here the signer is only the conduit)
(define-public (rv-sell) (contract-call? .fastpool-swap-vault router-swap 0x))
(define-public (rv-place) (contract-call? .fastpool-swap-vault jing-place 0x))
(define-public (rv-reclaim) (contract-call? .fastpool-swap-vault jing-reclaim))
(define-public (rv-close) (contract-call? .fastpool-swap-vault close-batch))
;; plain donations to the vault (permissionless)
(define-public (rv-donate (raw uint))
  (contract-call? .mock-ft mint (+ u1 (mod raw u1000)) .fastpool-swap-vault))
(define-public (rv-donate-stx (raw uint))
  (stx-transfer? (+ u1 (mod raw u2000000)) tx-sender .fastpool-swap-vault))
;; admin tools through the signer (deployer = seeded admin)
(define-private (rv-vchunk)
  (rv-min (rv-sbtc .fastpool-swap-vault) (get max-chunk-sats (contract-call? .fastpool-swap-vault get-config))))
(define-private (rv-legs (amount uint) (pick uint))
  { jing: (if (is-eq pick u0) amount u0), dlmm: (if (is-eq pick u1) amount u0),
    xyk: (if (is-eq pick u2) amount u0), velar: (if (is-eq pick u3) amount u0) })
(define-public (rv-take (raw uint)) (jing-take raw 0x .fastpool-swap-vault))
(define-public (rv-split (pick uint))
  (let ((a (rv-vchunk)) (l (rv-legs a (mod pick u4))))
    (router-swap-split a (get jing l) (get dlmm l) (get xyk l) (get velar l) 0x .fastpool-swap-vault)))
(define-public (rv-dia (pick uint))
  (let ((a (rv-vchunk)) (l (rv-legs a (+ u1 (mod pick u3)))))
    (router-swap-split-dia a (get dlmm l) (get xyk l) (get velar l) .fastpool-swap-vault)))
(define-public (rv-refloor) (refloor-vault 0x .fastpool-swap-vault))
(define-public (rv-vcfg (action uint) (raw uint))
  (let ((a (mod action u8)) (v .fastpool-swap-vault))
    (if (is-eq a u0) (set-vault-window-blocks (mod raw u40) v)
    (if (is-eq a u1) (set-vault-leeway-bps (mod raw u1001) v)
    (if (is-eq a u2) (set-vault-slippage-bps (mod raw u1001) v)
    (if (is-eq a u3) (set-vault-no-pyth-slippage-bps (mod raw u5001) v)
    (if (is-eq a u4) (set-vault-max-chunk-sats (+ u1000 (mod raw u2000000)) v)
    (if (is-eq a u5) (set-vault-dia-band-bps (if (is-eq (mod raw u4) u0) (mod raw u5001) (+ u500 (mod raw u1500))) v)
    (if (is-eq a u6) (set-vault-router-cooldown (mod raw u4) v)
      (set-vault-pyth-fee-budget (unwrap-panic (element-at? (list u0 u2000 u600000 (mod raw u10000001)) (mod raw u4))) v))))))))))
