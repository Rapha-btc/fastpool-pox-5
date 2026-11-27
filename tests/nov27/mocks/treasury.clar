(define-public (withdraw-ft (token principal) (n uint) (recipient principal))
 (as-contract? ((with-ft .token "sbtc-token" n)) (try! (contract-call? .token transfer n current-contract recipient none))))
