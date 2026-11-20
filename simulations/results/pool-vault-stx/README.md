# Fastpool swap-vault fork results

All production pool and vault sources were deployed unchanged, using Clarity 6.
The forks use the real PoX-5 claim path, sBTC ledger, Jing v6 market, smart router and AMM state.
Signed BTC/STX Lazer updates came from the public Jing backend; no private Pyth key was needed.

| Case | Passed | Simulation | Raw results |
| --- | --- | --- | --- |
| deployment-guards | 33/33 | [stxer](https://stxer.xyz/simulations/mainnet/1fad3855b91485cd761acae804699dd7) | [fastpool-deployment-guards.json](fastpool-deployment-guards.json) |
| maker | 30/30 | [stxer](https://stxer.xyz/simulations/mainnet/f4cc786919c8bc61122bcaba6a646ca8) | [fastpool-maker.json](fastpool-maker.json) |
| liquidation | 45/45 | [stxer](https://stxer.xyz/simulations/mainnet/2ee5a37c2bca56223cc01b7f899ce95e) | [fastpool-liquidation.json](fastpool-liquidation.json) |

The current FastPool contracts pass **108/108 checks** across these three forks (2026-11-19 rerun on live market v6-5 + router v6 + trait-v3;
see `../../README-pool-vault-stx.md` for the full table, incl. a 35/35 guards run that fork-deploys router v6 + trait-v3 from exact repo bytes).
The guard fork verifies exact-source Clarity 6 deployment, the shared vault trait v3, the trait-v3 split shapes (direct and wrapper refusals),
active-vault arguments, authorization, and empty-state guards, and the Pyth fee budget setter
(direct-call refusal, pool admin wrapper, active-vault check, 10 STX bound, `get-config`). The maker lifecycle explicitly
closes the externally filled batch before finalization and verifies `ready-to-finish`.

The lifecycle cases seed crystallized PoX rewards and 1:3 shares with fork-only `Eval` writes,
then exercise pool claiming, vault conversion, return, pro-rata native STX payouts and replay protection.
They do not exercise signer registration, STX lock admission, or reward calculation from new stakes.
The router case sells one 50k chunk by `router-swap`, then 25k by `router-swap-split` and 25k by
`router-swap-split-dia` (zest u0 + empty ticks; a Zest slice > 0 fails `u3002` since Zest pool u3 is absent), after the
admin widens `slippage-bps` to 300 (live DLMM depth inside 1% was ~55k sats). It uses one-second synthetic Bitcoin blocks to advance the full 288-block
patience window and the one-block cooldown while retaining a real signed update.
The production 80-second freshness checks remain enabled. The maker case needs no block advance.
Existing Jing makers were canceled only inside each fork; the maker case adds real-token depth
behind the vault to satisfy the market's full-fill taker requirement.
These are independent fork snapshots, with zero pool fees in the stxer lifecycle cases;
fee and OG behavior is covered by the separate simnet tests.
