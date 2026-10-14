;; ADVERSARIAL mock of swap-router-sbtc-stx-jing-v5-3 for RV fuzzing of the
;; fastpool swap vault. None of the real venues run in simnet. This mock
;; buys up to `fill-bps` of the offered sats at `quality-bps` of the mock
;; Lazer mid, paying from the STX it holds (wrappers fund it). It ignores the
;; per-leg limit price and per-leg minimums (a worst-case venue set) and
;; honours ONLY the overall `min-stx-out` (the real router's u3002), which
;; is the one guarantee the vault may rely on for the split entries. For the
;; permissionless smart-swap the vault passes min-stx-out u0, so the vault's
;; own post-trade floor check is the only guard. Reports are honest: `out`
;; is what it pays, `unsold` is what it did not take.
(define-constant SCALE u10000000000)
(define-data-var quality-bps uint u10000)
(define-data-var fill-bps uint u10000)
(define-data-var sales uint u0)
(define-public (set-quality (q uint)) (begin (asserts! true (err u0)) (ok (var-set quality-bps q))))
(define-public (set-fill (f uint)) (begin (asserts! true (err u0)) (ok (var-set fill-bps f))))
(define-read-only (get-knobs) { quality: (var-get quality-bps), fill: (var-get fill-bps), sales: (var-get sales) })

(define-private (sell (amount uint) (min-out uint))
  (let (
      (mid (contract-call? .mock-lazer-oracle get-mid))
      (take (/ (* amount (var-get fill-bps)) u10000))
      (out (/ (* (/ (* take mid) SCALE) (var-get quality-bps)) u10000))
      (taker tx-sender)
    )
    (if (or (is-eq take u0) (is-eq out u0) (> out (stx-get-balance current-contract)))
      (begin (asserts! (is-eq min-out u0) (err u3002)) (ok { out: u0, unsold: amount }))
      (begin
        (asserts! (>= out min-out) (err u3002))
        (try! (contract-call? .mock-ft transfer take taker current-contract none))
        (try! (as-contract? ((with-stx out))
          (try! (stx-transfer? out current-contract taker))))
        (var-set sales (+ (var-get sales) u1))
        (ok { out: out, unsold: (- amount take) })))))

(define-public (smart-swap-sbtc-for-stx (amount uint) (limit-price uint)
    (update (optional (buff 8192))) (mid uint) (min-stx-out uint))
  (sell amount min-stx-out))

(define-public (swap-sbtc-for-stx (amount uint) (jing-amount uint) (limit-price uint)
    (update (optional (buff 8192))) (fallback (optional uint))
    (amm-amounts { dlmm: uint, xyk: uint, velar: uint })
    (amm-mins { dlmm: uint, xyk: uint, velar: uint })
    (min-stx-out uint))
  (sell amount min-stx-out))
