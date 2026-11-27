;; Refund/re-pull models the router reselling Jing's refund. Real FT movements
;; deliberately exercise Clarity's aggregate as-contract? allowance accounting.
(define-data-var extra uint u0)
(define-data-var refuse bool false)
(define-public (configure (n uint) (no-sale bool)) (ok (begin (var-set extra n) (var-set refuse no-sale))))
(define-private (sell (amount uint))
 (let ((who tx-sender) (refund (var-get extra)))
 (if (var-get refuse) (ok {out: u0, unsold: amount})
 (begin
 (try! (contract-call? .token transfer amount who current-contract none))
 (if (> refund u0)
  (begin
   (try! (as-contract? ((with-ft .token "sbtc-token" refund)) (try! (contract-call? .token transfer refund current-contract who none))))
   (try! (contract-call? .token transfer refund who current-contract none))) true)
 (try! (as-contract? ((with-stx amount)) (try! (stx-transfer? amount current-contract who))))
 (ok {out: amount, unsold: u0})))))
(define-public (smart-swap-sbtc-for-stx (n uint) (limit uint) (update (optional (buff 8192))) (mid uint) (min-out uint)) (sell n))
(define-public (swap-sbtc-for-stx (n uint) (jing uint) (limit uint) (update (optional (buff 8192))) (fallback (optional uint))
 (amounts {zest: uint, dlmm: uint, xyk: uint, velar: uint}) (mins {zest: uint, dlmm: uint, xyk: uint, velar: uint})
 (min-out uint) (route {ticks: (list 32 int), price: uint})) (sell n))
