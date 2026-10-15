#!/usr/bin/env python3
"""Build an isolated Clarinet SDK harness from the deployed FastPool bytes."""

from hashlib import sha256
from pathlib import Path
import re
import shutil


HERE = Path(__file__).resolve().parent
REPOS = HERE.parents[2]
OUT = HERE / ".build" / "fastpool-only"
CITYCOINS = REPOS / "citycoins-protocol"
JUICE = REPOS / "juicestx"
FASTPOOL = REPOS / "fastpool-pox-5"

EXPECTED = {
    "fastpool-swap-vault.clar": "cf99c70254fd30cf5ae852e92488402a477ae3b3d2674980e2da7228ff5d0c53",
    "signer-manager-vault-stx-rewards.clar": "fa3d94741b4c9eeeaf7cd2c39513439a51a6247056155a19a584df2b76a7020c",
}


def copy(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise SystemExit(f"Missing fixture source: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def source_bytes(name: str) -> str:
    source = FASTPOOL / "contracts" / name
    raw = source.read_bytes()
    actual = sha256(raw).hexdigest()
    expected = EXPECTED[name]
    if actual != expected:
        raise SystemExit(f"Unexpected {name} bytes: {actual}; expected {expected}")
    return raw.decode("utf-8")


def transformed_contract(name: str, deployment_name: str) -> None:
    text = source_bytes(name)
    replacements = {
        "'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6-4": ".v6-market",
        "'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.swap-router-sbtc-stx-jing-v5-5": ".mock-router",
        "'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.juice-swap-vault-trait-v2.swap-vault-trait": ".juice-swap-vault-trait.swap-vault-trait",
        ".signer-manager-vault-stx-rewards": ".fastpool-stx-vault-signer",
        "'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token": ".mock-ft",
        "'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2": ".mock-native",
        "'SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle": ".mock-dia",
        "'SP000000000000000000002Q6VF78.pox-5": ".mock-pox",
        "'ST000000000000000000002AMW42H.pox-5": ".mock-pox",
        "'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.rfq-sbtc-stx-jing-v2-3": ".mock-native",
        '"sbtc-token"': '"mock-ft"',
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    (OUT / "contracts" / f"{deployment_name}.clar").write_text(text)


def write_mock_pox() -> None:
    # Small deterministic PoX-5 stand-in. It exercises the signer's real
    # callback and settlement code while avoiding a mainnet PoX dependency.
    text = """(use-trait signer-trait .mock-signer-trait.signer-manager-trait)
(define-trait signer-manager-trait ((validate-stake! (principal uint uint uint uint bool (optional (buff 500))) (response bool uint))))
(define-data-var cycle uint u150)
(define-data-var dist uint u300)
(define-data-var reward uint u1000000)
(define-map shares { staker: principal, cycle: uint, signer: principal } uint)
(define-map totals { cycle: uint, signer: principal } uint)
(define-public (seed (staker principal) (c uint) (signer principal) (amount uint))
  (begin
    (map-set shares { staker: staker, cycle: c, signer: signer } amount)
    (map-set totals { cycle: c, signer: signer }
      (+ amount (default-to u0 (map-get? totals { cycle: c, signer: signer }))))
    (begin (asserts! true (err u0)) (ok true))))
(define-public (next-dist) (ok (var-set dist (+ (var-get dist) u1))))
(define-public (claim-rewards (bonds (list 6 uint)) (c uint))
  (begin (asserts! true (err u0))
    (if (> (var-get reward) u0)
      (try! (contract-call? .mock-ft mint (var-get reward) contract-caller))
      true)
    (ok { total-rewards: (var-get reward) })))
(define-read-only (current-distribution-cycle) (var-get dist))
(define-read-only (current-pox-reward-cycle) (var-get cycle))
(define-read-only (get-signer-shares-staked-for-cycle (signer principal) (c uint) (bond (optional uint)))
  (default-to u0 (map-get? totals { cycle: c, signer: signer })))
(define-read-only (get-staker-shares-staked-for-cycle (staker principal) (c uint) (bond (optional uint)) (signer principal))
  (default-to u0 (map-get? shares { staker: staker, cycle: c, signer: signer })))
(define-read-only (get-signer-pending-staked-ustx-per-cycle (signer principal) (c uint))
  (get-signer-shares-staked-for-cycle signer c none))
(define-read-only (get-signer-unclaimed-rewards-for-cycle (signer principal) (c uint) (bond (optional uint))) u0)
(define-read-only (get-earned-staker-rewards (signer principal) (c uint) (bond (optional uint)) (staker principal)) u0)
(define-public (claim-staker-rewards-for-signer (staker principal) (c uint) (bond (optional uint)))
  (begin (asserts! true (err u0)) (ok { earned: u0 })))
(define-public (grant-signer-key (key (buff 33)) (signer principal) (auth uint) (sig (buff 65)))
  (begin (asserts! true (err u0)) (ok true)))
(define-public (register-signer (signer <signer-trait>) (key (buff 33)))
  (begin (asserts! true (err u0)) (ok true)))
(define-public (stake-test (pool <signer-trait>) (staker principal) (c uint) (amount uint))
  (begin
    (try! (seed staker c (contract-of pool) amount))
    (contract-call? pool validate-stake! staker c u1 amount u0 false none)))
(define-public (callback-test (pool <signer-trait>) (staker principal) (c uint)
    (num-indexes uint) (amount uint) (is-bond bool)
    (signer-calldata (optional (buff 500))))
  (contract-call? pool validate-stake! staker c num-indexes amount u0
    is-bond signer-calldata))
(define-public (set-cycle (c uint)) (ok (var-set cycle c)))
(define-public (set-reward (amount uint))
  (begin (asserts! true (err u0)) (ok (var-set reward amount))))
(define-public (set-share (staker principal) (c uint) (signer principal) (amount uint))
  (begin
    (asserts! true (err u0))
    (ok (map-set shares { staker: staker, cycle: c, signer: signer } amount))))
(define-public (set-total (c uint) (signer principal) (amount uint))
  (begin
    (asserts! true (err u0))
    (ok (map-set totals { cycle: c, signer: signer } amount))))
"""
    (OUT / "contracts" / "mock-pox.clar").write_text(text)


def write_market_fixture() -> None:
    # The CityCoins test market predates get-token-x-pending-deposit, which
    # the deployed FastPool vault calls from its read-only status checks.
    # Generate the market straight from the Jing markets-sbtc-stx-jing-v6-4
    # source the vault binds, with the same three dependency substitutions
    # Jing's own RV build uses (trait + Lazer oracle/decoder).
    source = REPOS / "jing-contracts-v3" / "contracts" / "markets-sbtc-stx-jing-v6-4.clar"
    if not source.is_file():
        raise SystemExit(f"Missing Jing market source: {source}")
    text = source.read_text()
    replacements = {
        "'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait": ".sip-010-trait.sip-010-trait",
        "'SPMV5HDZ4EMB8XY7HAYT3XW0DF7DZ4E8XEG2J1T8.pyth-lazer-oracle": ".mock-lazer-oracle",
        "'SPMV5HDZ4EMB8XY7HAYT3XW0DF7DZ4E8XEG2J1T8.pyth-lazer-decoder-v1": ".mock-lazer-oracle",
        ".jing-ladder-v1": ".mock-jing-ladder",
        ".jing-core-v6": ".mock-jing-core",
        "(define-data-var token-x principal SAINT)": "(define-data-var token-x principal .mock-ft)",
        "(define-data-var token-y principal SAINT)": "(define-data-var token-y principal .mock-native)",
        "(define-data-var initialized bool false)": "(define-data-var initialized bool true)",
        "(define-data-var feed-id-x uint u0)": "(define-data-var feed-id-x uint u1)",
        "(define-data-var feed-id-y uint u0)": "(define-data-var feed-id-y uint u45)",
    }
    for old, new in replacements.items():
        if old not in text:
            raise SystemExit(f"Jing market v6-4 source lacks {old!r}")
        text = text.replace(old, new)
    if re.search(r"'S[PM][0-9A-Z]{20,}\.", text):
        raise SystemExit("Jing market fixture has an unsubstituted mainnet principal")
    (OUT / "contracts" / "v6-market.clar").write_text(text)


def write_native_fixture() -> None:
    source = OUT / "contracts" / "mock-ft.clar"
    text = source.read_text().replace("mock-ft", "mock-native")
    text += """
(define-data-var native-mid uint u32000000000000)
(define-data-var native-failed bool false)
(define-public (set-mid (m uint)) (ok (var-set native-mid m)))
(define-public (set-failed (b bool)) (ok (var-set native-failed b)))
(define-read-only (get-native-price)
  (begin (asserts! (not (var-get native-failed)) (err u900)) (ok (var-get native-mid))))
"""
    (OUT / "contracts" / "mock-native.clar").write_text(text)


def write_lazer_fixture() -> None:
    source = OUT / "contracts" / "mock-lazer-oracle.clar"
    text = source.read_text()
    text = text.replace(
        "(define-data-var mid uint u32000000000000)",
        "(define-data-var mid uint u32000000000000)\n(define-data-var fee uint u0)",
    )
    text = text.replace(
        "(define-public (verify-price-feeds (update (buff 8192)) (decoder principal) (max-age (optional uint)))\n  (decode-lazer-payload update)\n)",
        """(define-public (set-fee (amount uint))
  (ok (var-set fee amount))
)

(define-public (verify-price-feeds (update (buff 8192)) (decoder principal) (max-age (optional uint)))
  (begin
    (if (> (var-get fee) u0)
      (try! (stx-transfer? (var-get fee) tx-sender current-contract))
      true
    )
    (decode-lazer-payload update)
  )
)""",
    )
    if "(define-data-var fee uint u0)" not in text or "(define-public (set-fee" not in text:
        raise SystemExit("Could not extend the current Jing Lazer fixture with fee charging")
    source.write_text(text)


def write_core_fixture(market_text: str) -> None:
    # The v6 market calls the current core logger API. Generate no-op logger
    # stubs with exact signatures from core source so this harness cannot
    # silently compile against the older v5 mock ABI.
    source = REPOS / "jing-contracts-v3" / "contracts" / "jing-core-v6.clar"
    source_text = source.read_text()
    names = sorted(set(re.findall(
        r"contract-call\?\s+\.mock-jing-core\s+([a-zA-Z0-9!?-]+)", market_text
    )))
    definitions = ["(define-read-only (get-contract-owner) tx-sender)"]
    for name in names:
        if name == "get-contract-owner":
            continue
        start = source_text.find(f"(define-public ({name}")
        if start < 0:
            raise SystemExit(f"Jing core source lacks market logger {name}")
        depth = 0
        in_string = False
        in_comment = False
        signature_end = None
        nested = False
        for offset, char in enumerate(source_text[start:], start):
            if in_comment:
                if char == "\n":
                    in_comment = False
                continue
            if in_string:
                if char == '"':
                    in_string = False
                continue
            if char == ";":
                in_comment = True
            elif char == '"':
                in_string = True
            elif char == "(":
                depth += 1
                nested = nested or depth == 2
            elif char == ")":
                depth -= 1
                if nested and depth == 1:
                    signature_end = offset + 1
                    break
        if signature_end is None:
            raise SystemExit(f"Could not parse Jing core signature for {name}")
        signature = source_text[start:signature_end]
        definitions.append(signature + "\n  (begin (asserts! true (err u0)) (ok true)))")
    (OUT / "contracts" / "mock-jing-core.clar").write_text("\n\n".join(definitions) + "\n")


def main() -> None:
    contracts = OUT / "contracts"
    contracts.mkdir(parents=True, exist_ok=True)
    (OUT / "settings").mkdir(parents=True, exist_ok=True)

    JING_RV = REPOS / "jing-contracts-v3" / "tests" / "rv"
    copy(JING_RV / "sip-010-trait.clar", contracts / "sip-010-trait.clar")
    for name in ["mock-lazer-oracle", "mock-jing-ladder"]:
        copy(JING_RV / f"{name}.clar", contracts / f"{name}.clar")
    write_lazer_fixture()
    copy(CITYCOINS / "tests" / "vault" / "fixtures" / "mock-ft.clar",
         contracts / "mock-ft.clar")
    write_native_fixture()
    write_market_fixture()
    write_core_fixture((contracts / "v6-market.clar").read_text())
    for name in ["mock-router", "mock-dia"]:
        copy(CITYCOINS / "tests" / "rv" / f"{name}.clar", contracts / f"{name}.clar")
    copy(JUICE / "contracts" / "pox-5" / "juice-swap-vault-trait-v2.clar",
         contracts / "juice-swap-vault-trait.clar")

    (contracts / "mock-signer-trait.clar").write_text(
        "(define-trait signer-manager-trait ((validate-stake! "
        "(principal uint uint uint uint bool (optional (buff 500))) (response bool uint))))\n"
    )
    write_mock_pox()
    transformed_contract("signer-manager-vault-stx-rewards.clar", "fastpool-stx-vault-signer")
    transformed_contract("fastpool-swap-vault.clar", "fastpool-swap-vault")
    transformed_contract("fastpool-swap-vault.clar", "fastpool-swap-vault-next")

    names = [
        "sip-010-trait", "mock-ft", "mock-jing-core", "mock-lazer-oracle",
        "mock-jing-ladder", "v6-market", "mock-router", "mock-dia",
        "mock-native", "mock-signer-trait", "mock-pox", "juice-swap-vault-trait",
        "fastpool-stx-vault-signer", "fastpool-swap-vault", "fastpool-swap-vault-next",
    ]
    manifest = (
        '[project]\nname = "fastpool-vault-sdk"\ntelemetry = false\n'
        'cache_dir = "./.cache"\n[repl.analysis]\npasses = []\n'
    )
    for name in names:
        manifest += (
            f'\n[contracts.{name}]\npath = "contracts/{name}.clar"\n'
            'clarity_version = 6\nepoch = "4.0"\n'
        )
    (OUT / "Clarinet.toml").write_text(manifest)
    copy(FASTPOOL / "settings" / "Devnet.toml", OUT / "settings" / "Devnet.toml")

    print(f"Built isolated FastPool SDK fixtures at {OUT}")
    for name, digest in EXPECTED.items():
        print(f"{name}: sha256 {digest}")


if __name__ == "__main__":
    main()
