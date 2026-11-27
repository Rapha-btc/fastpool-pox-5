;; juice-swap-vault-trait-v4: trait-v3 with a `fallback` venue on both split
;; sales (router swap-router-sbtc-stx-jing-v6). router-swap-split takes
;; (amount jing zest zest-ticks dlmm xyk velar update fallback),
;; router-swap-split-dia takes (amount zest zest-ticks dlmm xyk velar fallback);
;; `fallback` (optional uint) goes to the router as is: the Jing residual and
;; the Zest shortfall re-sell there (typically (some u1) = DLMM), none keeps
;; them unsold. Everything else is identical to trait-v3. Used by
;; fastpool-swap-vault and signer-manager-vault-stx-rewards.
(define-trait swap-vault-trait (
  (fund
    (uint)
    (response uint uint)
  )
  (finish
    ()
    (response uint uint)
  )
  (emergency-recover
    ()
    (
      response       {
      stx: uint,
      sbtc: uint,
    }
      uint
    )
  )
  (get-upgrade-status
    ()
    (
      response       {
      pool: principal,
      empty: bool,
      sbtc-balance: uint,
      stx-balance: uint,
      batch-start: (optional uint),
      jing-resting: uint,
      jing-parked: uint,
    }
      uint
    )
  )
  (jing-refloor
    ((buff 8192))
    (response uint uint)
  )
  (set-window-blocks
    (uint)
    (response bool uint)
  )
  (set-leeway-bps
    (uint)
    (response bool uint)
  )
  (set-slippage-bps
    (uint)
    (response bool uint)
  )
  (set-max-chunk-sats
    (uint)
    (response bool uint)
  )
  (set-dia-band-bps
    (uint)
    (response bool uint)
  )
  (set-router-cooldown
    (uint)
    (response bool uint)
  )
  (set-no-pyth-slippage-bps
    (uint)
    (response bool uint)
  )
  (set-pyth-fee-budget
    (uint)
    (response bool uint)
  )
  (set-maker-spread-bps
    (uint)
    (response bool uint)
  )
  (jing-take
    (uint (buff 8192))
    (
      response       {
      notification: (string-ascii 32),
      payload: {
        amount: uint,
        limit-price: uint,
        out: uint,
      },
    }
      uint
    )
  )
  (router-swap-split
    (uint uint uint (list 32 int) uint uint uint (buff 8192) (optional uint))
    (
      response       {
      notification: (string-ascii 32),
      payload: {
        amount: uint,
        jing: uint,
        zest: uint,
        dlmm: uint,
        xyk: uint,
        velar: uint,
        limit-price: uint,
        velar-limit: uint,
        mid: uint,
        out: uint,
        unsold: uint,
      },
    }
      uint
    )
  )
  (router-swap-split-dia
    (uint uint (list 32 int) uint uint uint (optional uint))
    (
      response       {
      notification: (string-ascii 32),
      payload: {
        amount: uint,
        zest: uint,
        dlmm: uint,
        xyk: uint,
        velar: uint,
        mid: uint,
        limit-price: uint,
        price-source: (string-ascii 6),
        dia-error: (optional uint),
        out: uint,
        unsold: uint,
      },
    }
      uint
    )
  )
))
