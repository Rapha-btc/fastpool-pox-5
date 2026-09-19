# Fastpool swap-vault fork results

All production pool and vault sources were deployed unchanged, using Clarity 6.
The forks use the real PoX-5 claim path, sBTC ledger, Jing v6 market, smart router and AMM state.
Signed BTC/STX Lazer updates came from the public Jing backend; no private Pyth key was needed.

| Case | Passed | Simulation | Raw results |
| --- | --- | --- | --- |
| deployment-guards | 15/15 | [stxer](https://stxer.xyz/simulations/mainnet/10d76e3360be338cfe3cd9a6b24e783e) | [fastpool-deployment-guards.json](fastpool-deployment-guards.json) |
| maker | 32/32 | [stxer](https://stxer.xyz/simulations/mainnet/32e7a8cb71f6cc62bd754306e11724c4) | [fastpool-maker.json](fastpool-maker.json) |
| liquidation | 35/35 | [stxer](https://stxer.xyz/simulations/mainnet/135e16990009bcff068862e8a55f4c5b) | [fastpool-liquidation.json](fastpool-liquidation.json) |

The current trait-based FastPool contracts pass **82/82 checks** across these three forks.
The guard fork verifies exact-source Clarity 6 deployment, the deployed reusable vault trait,
active-vault arguments, authorization, and empty-state guards. The maker lifecycle explicitly
closes the externally filled batch before finalization and verifies `ready-to-finish`.

The lifecycle cases seed crystallized PoX rewards and 1:3 shares with fork-only `Eval` writes,
then exercise pool claiming, vault conversion, return, pro-rata native STX payouts and replay protection.
They do not exercise signer registration, STX lock admission, or reward calculation from new stakes.
The router case uses one-second synthetic Bitcoin blocks to advance the full 288-block
patience window and the one-block cooldown while retaining a real signed update.
The production 80-second freshness checks remain enabled. The maker case needs no block advance.
Existing Jing makers were canceled only inside each fork; the maker case adds real-token depth
behind the vault to satisfy the market's full-fill taker requirement.
These are independent fork snapshots, with zero pool fees in the stxer lifecycle cases;
fee and OG behavior is covered by the separate simnet tests.
