;; Honest mock of the pox-5 surface the fastpool STX-rewards signer manager
;; uses. Rewards: `add-rewards` mints mock sBTC here for a cycle; the signer's
;; claim-rewards pulls exactly that and reports it as total-rewards (pox-5
;; pays what it reports). Shares: `set-shares` records a staker's shares and
;; the signer total per cycle WITHOUT calling back (pox-5 never calls back on
;; unstake); the signer's RV wrapper mirrors stakes itself through the
;; production fold, because a callback into the signer from a call that the
;; signer itself started is a Clarity CircularReference.
(use-trait signer-trait .mock-signer-trait.signer-manager-trait)
(define-map rewards uint uint)
(define-map shares { staker: principal, cycle: uint } uint)
(define-map totals uint uint)
(define-public (add-rewards (c uint) (amount uint))
  (begin
    (try! (contract-call? .mock-ft mint amount current-contract))
    (ok (map-set rewards c (+ amount (default-to u0 (map-get? rewards c)))))))
(define-public (set-shares (staker principal) (c uint) (amount uint))
  (let ((prev (default-to u0 (map-get? shares { staker: staker, cycle: c })))
        (tot (default-to u0 (map-get? totals c))))
    (map-set shares { staker: staker, cycle: c } amount)
    (map-set totals c (+ (- tot prev) amount))
    (ok true)))
(define-public (claim-rewards (bonds (list 6 uint)) (c uint))
  (let ((amount (default-to u0 (map-get? rewards c))) (who contract-caller))
    (map-delete rewards c)
    (if (> amount u0)
      (try! (as-contract? ((with-ft .mock-ft "mock-ft" amount))
        (try! (contract-call? .mock-ft transfer amount current-contract who none))))
      true)
    (ok { total-rewards: amount })))
(define-read-only (get-pending-rewards (c uint)) (default-to u0 (map-get? rewards c)))
(define-read-only (get-staker-shares-staked-for-cycle (staker principal) (c uint) (bond (optional uint)) (signer principal))
  (default-to u0 (map-get? shares { staker: staker, cycle: c })))
(define-read-only (get-signer-pending-staked-ustx-per-cycle (signer principal) (c uint))
  (default-to u0 (map-get? totals c)))
(define-public (grant-signer-key (key (buff 33)) (signer principal) (auth uint) (sig (buff 65))) (begin (asserts! true (err u0)) (ok true)))
(define-public (register-signer (signer <signer-trait>) (key (buff 33))) (begin (asserts! true (err u0)) (ok true)))

;; a faithful pox-5 stake: shares for `n` cycles from `first`, then the
;; signer's validate-stake! callback (used by the property suite, whose test
;; contract is not on the signer's call stack)
(define-private (set-one (off uint) (acc { who: principal, first: uint, amount: uint }))
  (begin (unwrap-panic (set-shares (get who acc) (+ (get first acc) off) (get amount acc))) acc))
(define-public (stake (pool <signer-trait>) (staker principal) (first uint) (n uint) (amount uint))
  (begin
    (fold set-one (unwrap-panic (slice? (list u0 u1 u2 u3 u4 u5 u6 u7) u0 n)) { who: staker, first: first, amount: amount })
    (contract-call? pool validate-stake! staker first n amount u0 false none)))
