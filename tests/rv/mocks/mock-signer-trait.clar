;; pox-5's signer-manager-trait, local (the vendored boot pox-5 is not loaded
;; in this RV project; the signer's impl-trait is rewritten here).
(define-trait signer-manager-trait ((validate-stake! (principal uint uint uint uint bool (optional (buff 500))) (response bool uint))))
