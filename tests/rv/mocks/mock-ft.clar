;; Test-only strict SIP-010 ledger standing in for sBTC (and as the wSTX trait
;; identity the v6 market fixture expects). Explicit mints only, real ledger
;; transfers. Ghost: every transfer whose sender is one of the two RV vault
;; instances is checked against that vault's allowed destinations (its pool,
;; the Jing market, the Jing router). A transfer anywhere else bumps
;; `bad-vault-transfers`, which the vault/signer invariants require to be 0.
(impl-trait .sip-010-trait.sip-010-trait)
(define-fungible-token mock-ft)

(define-constant DEPLOYER 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM)
(define-constant SOLO_VAULT 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.fastpool-swap-vault-solo)
(define-constant INTEG_VAULT 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.fastpool-swap-vault)
(define-constant SIGNER 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager-vault-stx-rewards)
(define-constant MARKET 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.v6-market)
(define-constant ROUTER 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.mock-router)

(define-data-var bad-vault-transfers uint u0)
(define-data-var vault-transfers-out uint u0)
(define-read-only (get-bad-vault-transfers) (var-get bad-vault-transfers))
(define-read-only (get-vault-transfers-out) (var-get vault-transfers-out))

(define-private (allowed (sender principal) (recipient principal))
  (or (is-eq recipient MARKET) (is-eq recipient ROUTER)
      (and (is-eq sender SOLO_VAULT) (is-eq recipient DEPLOYER))
      (and (is-eq sender INTEG_VAULT) (is-eq recipient SIGNER))))

(define-public (transfer (amount uint) (sender principal) (recipient principal)
                        (memo (optional (buff 34))))
  (begin
    (asserts! (or (is-eq tx-sender sender) (is-eq contract-caller sender)) (err u401))
    (if (or (is-eq sender SOLO_VAULT) (is-eq sender INTEG_VAULT))
      (begin
        (var-set vault-transfers-out (+ (var-get vault-transfers-out) u1))
        (if (allowed sender recipient) true
          (var-set bad-vault-transfers (+ (var-get bad-vault-transfers) u1))))
      true)
    (ft-transfer? mock-ft amount sender recipient)))
(define-public (mint (amount uint) (who principal)) (ft-mint? mock-ft amount who))
(define-read-only (get-name) (ok "Mock-FT"))
(define-read-only (get-symbol) (ok "MOCK"))
(define-read-only (get-decimals) (ok u8))
(define-read-only (get-balance (who principal)) (ok (ft-get-balance mock-ft who)))
(define-read-only (get-total-supply) (ok (ft-get-supply mock-ft)))
(define-read-only (get-token-uri) (ok none))
