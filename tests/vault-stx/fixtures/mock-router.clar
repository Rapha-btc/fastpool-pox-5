;; Mock swap-router-sbtc-stx-jing-v6 for the FastPool vault harness (from
;; citycoins-protocol tests/rv/mock-router.clar, v6 shape: zest in
;; amm-amounts / amm-mins + trailing zest-route; zest is one more slice
;; at the mock mid, the route is ignored, the last call is recorded).
;; The real router splits a sale across the Jing book, Bitflow DLMM / XYK
;; and Velar; none of those run in simnet. This mock is one venue that
;; buys sBTC at the mock Lazer mid with the STX it holds (the SUT's
;; rv-fund-router wrapper gives it some): it takes `amount` sats, pays
;; sats * mid / 1e10 micro-STX when it can (and that clears min-out), and
;; otherwise takes nothing and reports everything unsold, the way the real
;; router returns what no venue could fill inside the floor. u3002 is the
;; real router's min-out code.
(use-trait ft-trait .sip-010-trait.sip-010-trait)

(define-constant SCALE u10000000000)

(define-private (sell
    (amount uint)
    (min-out uint)
  )
  (let (
      (mid (contract-call? .mock-lazer-oracle get-mid))
      (out (/ (* amount mid) SCALE))
      (taker tx-sender)
    )
    (if (or (is-eq amount u0) (> out (stx-get-balance current-contract)))
      (ok { out: u0, unsold: amount })
      (begin
        (asserts! (>= out min-out) (err u3002))
        (try! (contract-call? .mock-ft transfer amount taker current-contract none))
        (try! (as-contract? ((with-stx out))
          (try! (stx-transfer? out current-contract taker))))
        (ok { out: out, unsold: u0 })))))

(define-public (smart-swap-sbtc-for-stx
    (amount uint)
    (limit-price uint)
    (update (optional (buff 8192)))
    (mid uint)
    (min-stx-out uint)
  )
  (sell amount min-stx-out))

(define-public (swap-sbtc-for-stx
    (amount uint)
    (jing-amount uint)
    (limit-price uint)
    (update (optional (buff 8192)))
    (fallback (optional uint))
    (amm-amounts { zest: uint, dlmm: uint, xyk: uint, velar: uint })
    (amm-mins { zest: uint, dlmm: uint, xyk: uint, velar: uint })
    (min-stx-out uint)
    (zest-route { ticks: (list 32 int), price: uint })
  )
  (begin
    (var-set last-split (some { amount: amount, jing: jing-amount, amounts: amm-amounts,
      mins: amm-mins, min-out: min-stx-out, route: zest-route }))
    (sell amount min-stx-out)))

;; Test-only: the arguments of the last swap-sbtc-for-stx call, so tests can
;; check what the vault forwarded (zest slice, its floor, the route).
(define-data-var last-split (optional { amount: uint, jing: uint,
  amounts: { zest: uint, dlmm: uint, xyk: uint, velar: uint },
  mins: { zest: uint, dlmm: uint, xyk: uint, velar: uint },
  min-out: uint, route: { ticks: (list 32 int), price: uint } }) none)
(define-read-only (get-last-split) (var-get last-split))
