# Two-phase pool vault stxer simulations

> Current results: [2026-11-19 rerun on market v6-5 + router v6 + trait-v3](#rerun-on-market-v6-5--router-v6--trait-v3-2026-11-19) (end of this file). Earlier 2026-09-23 v6-3 recovery and regression results: [cancel-only recovery verification](README-v6-3-recovery.md). The notes below describe the earlier verification; linked JSON artifacts now contain the current reruns.

Run from either repository root:

```sh
node simulations/pool-vault-stx-stxer.mjs
node simulations/pool-vault-stx-stxer.mjs --maker
node simulations/pool-vault-stx-stxer.mjs --lifecycle
```

The default checks exact-source deployment, authorization, empty/pending states and phase gates.
`--maker` sells a funded reward batch on the real Jing book during patience.
`--lifecycle` rests, advances 288 burn blocks, reclaims, sells through the real smart router
in two chunks, checks the one-block cooldown, finalizes and distributes native STX.
Both funded cases check exact 1:3 payouts and payout replay safety.

Current FastPool results pass **82/82 checks**:

- deployment and guards: **15/15**
- real Jing maker-fill lifecycle: **32/32**
- real router liquidation lifecycle: **35/35**

The FastPool runner deploys `signer-manager-vault-stx-rewards` under its production name,
passes `.fastpool-swap-vault` through `juice-swap-vault-trait-v2` (fork-deployed before the vault and pool), and checks the
`close-batch` / `ready-to-finish` transition before maker proceeds are finalized.

Juice's entry point lives in `stacking-juice/stx-juice/simulations`; FastPool's is here.
The shared runner is `_pool-vault-stxer.mjs` in this repo. It uses this repo's installed
`stxer` and Stacks dependencies if available, otherwise the installed Juice dependencies.
The signed oracle-update helper lives in sibling `jing-contracts-v3/simulations/_lazer.js`.
It automatically uses the public backend when `PYTH_API_KEY` is absent.
Set `STACKS_API_URL` or `STXER_API_URL` to override the API endpoints.

Each runner writes machine-checked reports to `simulations/results/pool-vault-stx` in its own repo;
the README there links to the successful fork runs and describes the fixtures.
Pool/vault production source is unchanged. Funded tests seed accrued PoX rewards and shares
in fork storage; they do not test creating new STX locks or signer registration.
The router case compresses synthetic Bitcoin intervals to one second, keeping all production
signature and 80-second freshness checks enabled. The simulated two-day interval therefore
tests burn-height gates and cooldown, rather than real elapsed wall time or days of market changes.

All token transfers, order cancellations and storage fixtures affect the stxer fork only.
No mainnet transactions are broadcast, and no private keys are required.

## Rerun on market v6-5 + router v6 + trait-v3 (2026-11-19)

Vault `d1998f6b…` and signer `23d98cb6…` (commit `1b47851`) bind live
`markets-sbtc-stx-jing-v6-5`, `swap-router-sbtc-stx-jing-v6` and
`juice-swap-vault-trait-v3`. Router v6 (block 9525511, tx `e2abd694…`) and
trait-v3 (block 9525513, tx `f10540d2…`) went live on mainnet during this rerun,
deployed comment-stripped and re-wrapped. `_jing-v6-3.mjs` now proves the live
code equals the repo bytes modulo comments and whitespace (router
`8325e0c5…` pinned, jing-contracts-v3 `4593bbb`) and uses the live contracts at
or past their publish height; below it, it fork-deploys the exact repo bytes as
`SPV9K21…` (router Clarity 5, trait Clarity 6) before the vault and signer.
Every run below forked at the tip (9525518-9525587), so it ran on the live
contracts; the exact-byte deploy path was checked separately with
`FORK_BLOCK=9525505` (guards **35/35**, [c068010c](https://stxer.xyz/simulations/mainnet/c068010c1493b8546f6d3b604409c561)).

Zest pool u3 does not exist on mainnet, so router v6 skips Zest. The splits
pass `zest u0` + an empty tick list, and the liquidation lifecycle checks once
per split that a Zest slice > 0 fails the total min-out with `u3002`.

What changed in the harnesses (no contract edits):
- trait-v3 split shapes: `router-swap-split (amount jing zest zest-ticks dlmm xyk velar update)`
  and `router-swap-split-dia (amount zest zest-ticks dlmm xyk velar)`. The guards add direct and
  wrapper refusals for both. The liquidation lifecycle now sells 50k by `router-swap`, then 25k by
  `router-swap-split` and 25k by `router-swap-split-dia` through the pool wrappers (plus `u16040`
  zest-counted mismatch, both `u3002` Zest-slice checks, and the shared cooldown).
- Live DLMM depth within 1% of the signed mid was ~55k sats at the tip, so the liquidation
  lifecycle has the admin set `slippage-bps u300` through `set-vault-slippage-bps` before selling.
- Funded holders: sBTC `SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2`, STX
  `SP1Z92MPDQEWZXW36VX71Q25HKF5K2EPCJ304F275` (`SM2RRFN4…` and `SP9BP4PN…` are empty at the tip).
- Market v6-5 operator and core-v6 / ladder-v1 owner is the multisig
  `SM1N7VX04M1TT23KD7YHVD6H6413QV2ZNJFTWVF9P`: pause, ladder reservation and
  `set-min-token-x-deposit` fork steps are sent as it.
- The live v6-5 Y book is non-empty, so a vault placement goes pending: the
  recovery matrix (resting shapes) and vault-fixes #7 settle it as the keeper, as the lifecycle already did.
- maker-spread-live: the v6-4 spread-0 rung does not rest on v6-5; the nearest live ask is
  `jing-buy-stx-10-v2` at mid + 10 bp, so the vault at mid + 1 bp is checked as the best ask and the
  Y bid at the mid is seeded directly (the buy-0 taker step is gone).
- dust-vaults: an accepted trade may leave the router's 1-sat rounding rest (`unsold u1`);
  the check now expects the balance to equal the reported `unsold`, empty iff `<= 2`.
- dust-* scripts fall back to the jing-contracts-v3 `stxer` install.

| sim | N/M | stxer |
|---|---:|---|
| pool-vault guards | 33/33 | [1fad3855](https://stxer.xyz/simulations/mainnet/1fad3855b91485cd761acae804699dd7) |
| pool-vault guards, `FORK_BLOCK=9525505` (repo-byte router v6 + trait-v3 deploys) | 35/35 | [c068010c](https://stxer.xyz/simulations/mainnet/c068010c1493b8546f6d3b604409c561) |
| pool-vault maker (`--maker`) | 30/30 | [f4cc7869](https://stxer.xyz/simulations/mainnet/f4cc786919c8bc61122bcaba6a646ca8) |
| pool-vault liquidation (`--lifecycle`, router-swap + both trait-v3 splits) | 45/45 | [2ee5a37c](https://stxer.xyz/simulations/mainnet/2ee5a37c2bca56223cc01b7f899ce95e) |
| recovery matrix (`--recovery`): pending | 110/110 | [5a6196a5](https://stxer.xyz/simulations/mainnet/5a6196a5aff412c8819823b3e5ca325b) |
| recovery matrix: resting | 99/99 | [f2f5fc66](https://stxer.xyz/simulations/mainnet/f2f5fc663ed612d3f734552819c0464c) |
| recovery matrix: parked | 128/128 | [8a4c8c2a](https://stxer.xyz/simulations/mainnet/8a4c8c2acbbe6d472981fee814ddd4f9) |
| recovery matrix: pending+resting | 122/122 | [8d965471](https://stxer.xyz/simulations/mainnet/8d96547157490973eb14bd55fb8e894b) |
| recovery matrix: none | 91/91 | [641bc6d2](https://stxer.xyz/simulations/mainnet/641bc6d26c8ca80db8bea973c044dcaf) |
| vault-fixes L-1 | 47/47 | [35c48a4a](https://stxer.xyz/simulations/mainnet/35c48a4a3fb342afa1151a5553efda35) |
| vault-fixes L-2 + #6 | 38/38 | [ed41cc86](https://stxer.xyz/simulations/mainnet/ed41cc864d112215b13d2971a5bff161) |
| vault-fixes #7 | 78/78 | [b0fd4faa](https://stxer.xyz/simulations/mainnet/b0fd4faab92eb68e83cdec4fe844911f) |
| vault-fixes Pyth fee budget (new split shape) | 72/72 | [6d088dc1](https://stxer.xyz/simulations/mainnet/6d088dc17d821386d595995af4295338) |
| maker-spread-live | 53/53 | [6354484c](https://stxer.xyz/simulations/mainnet/6354484c0a579535e44ad0c99b6e7d81) |
| dust-1sat (router v6 ladder + emptiness test) | 15/15 | [163819a2](https://stxer.xyz/simulations/mainnet/163819a2cca1f326359d88be33bbe0bd) |
| dust-vaults (FastPool, Juice v1, ccd016 v2) | 61/61 | [6a762618](https://stxer.xyz/simulations/mainnet/6a7626189d388b3da979238141fbdc6f) |

Total **1,022/1,022** on the live stack (recovery 550, vault-fixes 235), plus the
35/35 exact-byte guards run. dust-router (diagnostic, no pass/fail) also reran on router v6:
smallest sale 3 sats, pass 2 [6233fd59](https://stxer.xyz/simulations/mainnet/6233fd59ca0aaccd2502e2958753f690).
