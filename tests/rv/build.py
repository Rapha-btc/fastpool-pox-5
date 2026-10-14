#!/usr/bin/env python3
"""Build the Rendezvous project for the fastpool swap vault + STX-rewards signer.

Reads the CURRENT production sources (never edits them), applies test-only
rewrites to generated copies, appends the RV blocks, and writes a
self-contained Clarinet project to tests/rv/.build (gitignored).

Generated contracts:
  fastpool-swap-vault-solo          vault, POOL rewritten to the deployer wallet
                                    (RV target `vault`, one sender in ten is the pool)
  fastpool-swap-vault               vault, POOL = the generated signer (production wiring)
  signer-manager-vault-stx-rewards  signer, pox-5 -> mock-pox (RV target `signer`)
Every rewrite is listed in tests/rv/README.md.
"""
from pathlib import Path
import hashlib, json, re, shutil, sys

here = Path(__file__).resolve().parent
root = here.parents[1]
# --mutant=<name> builds a deliberately broken copy into .build-mutant-<name>
# (harness sanity: each mutant must be caught by the suites, see README)
MUTANT = next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--mutant=')), None)
out = here / ('.build' if MUTANT is None else f'.build-mutant-{MUTANT}')
if out.exists():
    shutil.rmtree(out)
(out / 'contracts').mkdir(parents=True)
(out / 'settings').mkdir()

DEPLOYER = "'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM"

# mainnet dependencies -> local mocks (-v6-3 / -v5-3 ids before their prefixes)
REPL = [
    ("'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.juice-swap-vault-trait-v2.swap-vault-trait", '.juice-swap-vault-trait-v2.swap-vault-trait'),
    ("'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6-3", '.v6-market'),
    ("'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.swap-router-sbtc-stx-jing-v5-3", '.mock-router'),
    ("'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.rfq-sbtc-stx-jing-v2-3", '.mock-native'),
    ("'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token", '.mock-ft'),
    ("'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2", '.mock-ft'),
    ("'SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle", '.mock-dia'),
    ("'SP000000000000000000002Q6VF78.pox-5.signer-manager-trait", '.mock-signer-trait.signer-manager-trait'),
    ("'SP000000000000000000002Q6VF78.pox-5", '.mock-pox'),
    ('"sbtc-token"', '"mock-ft"'),
]


def rewrite(s):
    for a, b in REPL:
        s = s.replace(a, b)
    return s


def sub1(s, old, new):
    assert s.count(old) == 1, (old, s.count(old))
    return s.replace(old, new)


files = {}
# ---- mocks ---------------------------------------------------------------
for p in sorted((here / 'mocks').glob('*.clar')):
    files[p.stem] = p.read_text()

# v6 market fixture (CityCoins tests/vault/fixtures, itself the jing v6 RV
# fuzz build). Same compat shims as citycoins tests/vault/build.py: the vault
# calls the deployed v6-3 signatures (no update argument) and reads the v6-3
# pending-escrow getter. The shims also mark the inner verify fee-free: v6-3
# deposit-token-x / set-token-x-limit take no update and never verify, so a
# Lazer fee charged there would be a fixture artefact, not vault behaviour.
m = files['v6-market']
if '(define-read-only (get-token-x-pending-deposit' not in m:
    m += ('\n(define-map token-x-pending-deposits principal {amount: uint, limit: uint, spread-bps: (optional uint), submitted-at: uint})\n'
          '(define-read-only (get-token-x-pending-deposit (depositor principal)) (map-get? token-x-pending-deposits depositor))\n')
for fn, sig, args in [
    ('deposit-token-x', '(amount uint) (limit-price uint) (spread-bps (optional uint)) (t <ft-trait>) (asset-name (string-ascii 128))', 'amount limit-price spread-bps 0x t asset-name'),
    ('set-token-x-limit', '(limit-price uint) (spread-bps (optional uint))', 'limit-price spread-bps 0x'),
]:
    m = sub1(m, f'(define-public ({fn}\n', f'(define-public ({fn}-fixture-v6\n')
    m = sub1(m, f'  ({fn} ', f'  ({fn}-fixture-v6 ')
    m += (f'(define-public ({fn} {sig})\n'
          f'  (begin (unwrap-panic (contract-call? .mock-lazer-oracle set-free true))\n'
          f'    (let ((r (try! ({fn}-fixture-v6 {args}))))\n'
          f'      (unwrap-panic (contract-call? .mock-lazer-oracle set-free false)) (ok r))))\n')
files['v6-market'] = m

o = files['mock-lazer-oracle']
o = sub1(o, '(define-data-var fee uint u0)', '(define-data-var fee uint u0)\n(define-data-var free bool false)\n'
         '(define-public (set-free (b bool)) (begin (asserts! true (err u0)) (ok (var-set free b))))')
o = sub1(o, '(and (> (var-get fee) u0)', '(and (> (var-get fee) u0) (not (var-get free))')
files['mock-lazer-oracle'] = o

files['juice-swap-vault-trait-v2'] = (root / 'contracts/juice-swap-vault-trait-v2.clar').read_text()

# ---- production sources ------------------------------------------------------
src = {
    'vault': root / 'contracts/fastpool-swap-vault.clar',
    'signer': root / 'contracts/signer-manager-vault-stx-rewards.clar',
}
text = {k: p.read_text() for k, p in src.items()}
hashes = {k: hashlib.sha256(v.encode()).hexdigest() for k, v in text.items()}

vault = rewrite(text['vault'])
# coverage: a 288-block patience window rarely elapses inside a sweep (RV
# mines at most 100 burn blocks between runs); 24 does. Still settable.
vault = sub1(vault, '(define-data-var window-blocks uint u288)', '(define-data-var window-blocks uint u24)')

# the solo copy: the pool is the deployer wallet, so `contract-caller ==
# POOL` holds for direct calls (and wrappers) by the deployer, and fund's
# `transfer amount POOL current-contract` is a plain wallet transfer.
solo = sub1(vault, '(define-constant POOL .signer-manager-vault-stx-rewards)', f'(define-constant POOL {DEPLOYER})')

# the integrated copy keeps POOL = the generated signer
integ = vault

signer = rewrite(text['signer'])
# property suite: the test contract `.rv-props` is seeded as a second admin
# next to the deployer (it drives admin entries from inside as-contract?,
# where contract-caller == tx-sender == rv-props, as authorize-admin wants).
signer = sub1(signer, "(map-set admins tx-sender true)",
              "(map-set admins tx-sender true)\n(map-set admins 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.rv-props true) ;; RV test-only")

common = (here / 'common.rv.clar').read_text()


def vault_view(block, solo_mode):
    """@(fn args) = a vault read; @V = the vault principal; @P = its pool."""
    if solo_mode:
        block = re.sub(r'@\(', '(', block)
        block = block.replace('@V', 'current-contract').replace('@P', 'POOL')
    else:
        block = re.sub(r'@\(', '(contract-call? .fastpool-swap-vault ', block)
        block = block.replace('@V', '.fastpool-swap-vault').replace('@P', 'current-contract')
    return block


solo += '\n\n' + vault_view(common, True) + '\n' + (here / 'vault.rv.clar').read_text()
signer += '\n\n' + vault_view(common, False) + '\n' + (here / 'signer.rv.clar').read_text()

MUTANTS = {
    # the liquidation floor at three times the configured slippage
    'floor': ('vault', '(/ (* mid (- BPS_PRECISION (var-get slippage-bps))) BPS_PRECISION)',
              '(/ (* mid (- BPS_PRECISION (* u3 (var-get slippage-bps)))) BPS_PRECISION)'),
    # finish sends the whole balance, reserve ignored
    'finish': ('vault', '(amount (if (> balance reserve)\n        (- balance reserve)\n        u0\n      ))',
               '(amount balance)'),
    # the signer books twice the fee it charges
    'fee': ('signer', '(var-set earned-fees (+ (var-get earned-fees) fee))',
            '(var-set earned-fees (+ (var-get earned-fees) (* u2 fee)))'),
}
if MUTANT is not None:
    which, old, new = MUTANTS[MUTANT]
    if which == 'vault':
        solo, integ = sub1(solo, old, new), sub1(integ, old, new)
    else:
        signer = sub1(signer, old, new)
files['fastpool-swap-vault-solo'] = solo
files['fastpool-swap-vault'] = integ
files['signer-manager-vault-stx-rewards'] = signer
files['rv-props'] = (here / 'props.rv.clar').read_text()

for n, s in files.items():
    (out / 'contracts' / f'{n}.clar').write_text(s)

manifest = '[project]\nname = "fastpool-rv"\ntelemetry = false\ncache_dir = "./.cache"\n[repl.analysis]\npasses = []\n'
for n in files:
    manifest += f'\n[contracts.{n}]\npath = "contracts/{n}.clar"\nclarity_version = 6\nepoch = "4.0"\n'
(out / 'Clarinet.toml').write_text(manifest)
shutil.copy(root / 'settings/Devnet.toml', out / 'settings/Devnet.toml')
(out / 'source-hashes.json').write_text(json.dumps(hashes, indent=2) + '\n')
print('Built', out, json.dumps(hashes))
