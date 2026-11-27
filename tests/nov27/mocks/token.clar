(define-fungible-token sbtc-token)
(define-public (mint (n uint) (who principal)) (ft-mint? sbtc-token n who))
(define-public (transfer (n uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
 (begin (asserts! (is-eq tx-sender sender) (err u4)) (ft-transfer? sbtc-token n sender recipient)))
(define-read-only (get-balance (who principal)) (ok (ft-get-balance sbtc-token who)))

;; External-ledger fault injection for bounded fuzz cases; never patches vault state.
(define-public (reset-balance (who principal) (n uint))
 (let ((old (ft-get-balance sbtc-token who)))
 (if (> old u0) (try! (ft-burn? sbtc-token old who)) true)
 (if (> n u0) (ft-mint? sbtc-token n who) (ok true))))
