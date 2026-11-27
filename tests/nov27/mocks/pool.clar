(use-trait vault-interface .vault-trait.swap-vault-trait)
(define-data-var admin principal tx-sender)
(define-data-var active principal tx-sender)
(define-data-var pending (optional principal) none)
(define-public (set-vaults (a principal) (p (optional principal))) (ok (begin (var-set active a) (var-set pending p))))
(define-read-only (get-admin) (var-get admin))
(define-public (set-admin (who principal)) (ok (var-set admin who)))
(define-read-only (is-admin (who principal)) (is-eq who (var-get admin)))
(define-read-only (get-swap-vault) (var-get active))
(define-read-only (get-pending-swap-vault) {vault: (var-get pending)})
(define-public (fund (vault <vault-interface>) (n uint))
 (as-contract? ((with-ft .token "sbtc-token" n)) (try! (contract-call? vault fund n))))
(define-public (router-swap-split (vault <vault-interface>) (n uint) (jing uint) (zest uint) (ticks (list 32 int)) (dlmm uint) (xyk uint) (velar uint) (update (buff 8192)) (fallback (optional uint)))
 (contract-call? vault router-swap-split n jing zest ticks dlmm xyk velar update fallback))
(define-public (router-swap-split-dia (vault <vault-interface>) (n uint) (zest uint) (ticks (list 32 int)) (dlmm uint) (xyk uint) (velar uint) (fallback (optional uint)))
 (contract-call? vault router-swap-split-dia n zest ticks dlmm xyk velar fallback))

(define-public (set-window-blocks (vault <vault-interface>) (n uint)) (contract-call? vault set-window-blocks n))

(define-public (set-leeway-bps (vault <vault-interface>) (n uint)) (contract-call? vault set-leeway-bps n))

(define-public (set-slippage-bps (vault <vault-interface>) (n uint)) (contract-call? vault set-slippage-bps n))

(define-public (set-max-chunk-sats (vault <vault-interface>) (n uint)) (contract-call? vault set-max-chunk-sats n))

(define-public (set-dia-band-bps (vault <vault-interface>) (n uint)) (contract-call? vault set-dia-band-bps n))

(define-public (set-router-cooldown (vault <vault-interface>) (n uint)) (contract-call? vault set-router-cooldown n))

(define-public (set-pyth-fee-budget (vault <vault-interface>) (n uint)) (contract-call? vault set-pyth-fee-budget n))

(define-public (set-maker-spread-bps (vault <vault-interface>) (n uint)) (contract-call? vault set-maker-spread-bps n))

(define-public (set-no-pyth-slippage-bps (vault <vault-interface>) (n uint)) (contract-call? vault set-no-pyth-slippage-bps n))
(define-public (finish (vault <vault-interface>)) (contract-call? vault finish))
(define-public (emergency-recover (vault <vault-interface>)) (contract-call? vault emergency-recover))
(define-public (jing-take (vault <vault-interface>) (n uint) (update (buff 8192))) (contract-call? vault jing-take n update))
(define-public (jing-refloor (vault <vault-interface>) (update (buff 8192))) (contract-call? vault jing-refloor update))
