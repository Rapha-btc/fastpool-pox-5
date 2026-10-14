;; ============================================================================
;; RENDEZVOUS invariant target `fastpool-swap-vault-solo` (test-only).
;; POOL is the deployer wallet here (build.py), so one RV sender in ten is
;; the pool and may call fund / finish / emergency-recover and every
;; pool-gated tool directly. The production pool wiring (the signer as
;; POOL) is fuzzed by the `signer-manager-vault-stx-rewards` target.
;; ============================================================================

(define-map context (string-ascii 100) { called: uint })

(define-private (rv-kind (name (string-ascii 100)))
  (if (or (is-eq name "router-swap") (is-eq name "rv-sell") (is-eq name "rv-drain")) K_ROUTER
  (if (or (is-eq name "router-swap-split") (is-eq name "rv-split")) K_SPLIT
  (if (or (is-eq name "router-swap-split-dia") (is-eq name "rv-dia")) K_DIA
  (if (or (is-eq name "jing-take") (is-eq name "rv-take")) K_TAKE
  (if (is-eq name "finish") K_FINISH
  (if (or (is-eq name "fund") (is-eq name "rv-fund")) K_FUND
  (if (is-eq name "emergency-recover") K_RECOVER
  (if (is-eq name "close-batch") K_CLOSE
  (if (or (is-eq name "jing-place") (is-eq name "rv-place")) K_PLACE
  (if (or (is-eq name "jing-refloor") (is-eq name "rv-refloor")) K_REFLOOR
  (if (or (is-eq name "rv-bid") (is-eq name "rv-cancel-bid") (is-eq name "rv-settle")) K_MARKET
    K_OTHER))))))))))))

(define-private (update-context (function-name (string-ascii 100)) (called uint))
  (begin
    (map-set context function-name { called: called })
    (and (> called u0) (rv-vcheck (rv-kind function-name)))
    (rv-vsnap-take)
    (ok true)))

;; --- wrappers (folded arguments; every wrapper does one vault action) -----

(define-public (rv-mint-pool (raw uint))
  (contract-call? .mock-ft mint (+ u1000 (mod raw u3000000)) POOL))
(define-public (rv-fund (raw uint))
  (fund (+ u1 (mod raw u3000000))))
;; permissionless sats by plain transfer (dust / griefing)
(define-public (rv-donate (raw uint))
  (contract-call? .mock-ft mint (+ u1 (mod raw u1000)) current-contract))
(define-public (rv-donate-stx (raw uint))
  (stx-transfer? (+ u1 (mod raw u2000000)) tx-sender current-contract))
(define-public (rv-sell) (router-swap 0x))
(define-public (rv-place) (jing-place 0x))
(define-public (rv-refloor) (jing-refloor 0x))
(define-public (rv-take (raw uint)) (jing-take raw 0x))
;; one leg gets the whole chunk
(define-private (rv-legs (amount uint) (pick uint))
  { jing: (if (is-eq pick u0) amount u0), dlmm: (if (is-eq pick u1) amount u0),
    xyk: (if (is-eq pick u2) amount u0), velar: (if (is-eq pick u3) amount u0) })
(define-private (rv-chunk) (rv-min (sbtc-balance) (var-get max-chunk-sats)))
(define-public (rv-split (pick uint))
  (let ((a (rv-chunk)) (l (rv-legs a (mod pick u4))))
    (router-swap-split a (get jing l) (get dlmm l) (get xyk l) (get velar l) 0x)))
(define-public (rv-dia (pick uint))
  (let ((a (rv-chunk)) (l (rv-legs a (+ u1 (mod pick u3)))))
    (router-swap-split-dia a (get dlmm l) (get xyk l) (get velar l))))
;; pool configuration inside the caps (window only while idle)
(define-public (rv-cfg (action uint) (raw uint))
  (let ((a (mod action u8)))
    (if (is-eq a u0) (set-window-blocks (mod raw u40))
    (if (is-eq a u1) (set-leeway-bps (mod raw u1001))
    (if (is-eq a u2) (set-slippage-bps (mod raw u1001))
    (if (is-eq a u3) (set-no-pyth-slippage-bps (mod raw u5001))
    (if (is-eq a u4) (set-max-chunk-sats (+ u1000 (mod raw u2000000)))
    (if (is-eq a u5) (set-dia-band-bps (if (is-eq (mod raw u4) u0) (mod raw u5001) (+ u500 (mod raw u1500))))
    (if (is-eq a u6) (set-router-cooldown (mod raw u4))
      (set-pyth-fee-budget (unwrap-panic (element-at? (list u0 u2000 u600000 (mod raw u10000001)) (mod raw u4)))))))))))))
