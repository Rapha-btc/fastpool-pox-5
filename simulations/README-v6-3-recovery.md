# Fastpool: cancel-only recovery against Jing v6-3

Verified 2026-09-23: **665/665 checks green** — recovery matrix **569/569**, existing regression suites **96/96**. No production contract edits; fork transactions only.

## Recovery matrix

Each inventory shape runs in four modes: normal, no oracle update supplied, market paused, and core-v6 paused. The normal mode also omits the update; the separately labelled no-update mode repeats the case explicitly. Signed Lazer data is used only to create or settle fixture orders, never during recovery.

The fixtures create pending escrow by calling `jing-place` with a nonempty opposite book. Resting, parked, pending plus resting, and no market position are tested separately. Every recovery checks exact returned sBTC, zero vault balance, empty pending/live/parked state, and `u1030` on a later settle. Pending refunds must emit the committed core event with reason `cancel` and the exact escrow amount. Paused cases also assert the pause remains set.

The actual pool calls `recover-swap-vault` with the vault trait. Its dynamic call invokes **`emergency-recover()` with no arguments**, checking conformance against the live shared trait. Direct unauthorized calls to the vault are refused. The pool receives the exact recovered total.

| Inventory | Recovery caller | N/M, including setup | Fork |
| --- | --- | ---: | --- |
| pending | pool | 113/113 | [stxer](https://stxer.xyz/simulations/mainnet/dcffa122fe861e84f2027d646235783a) |
| resting | pool | 102/102 | [stxer](https://stxer.xyz/simulations/mainnet/bdaabc36b73a23565d739f33ba51a353) |
| parked | pool | 131/131 | [stxer](https://stxer.xyz/simulations/mainnet/ac8ec18ad72211461efad945884c11e7) |
| pending+resting | pool | 125/125 | [stxer](https://stxer.xyz/simulations/mainnet/b5c2e92dfc22da04fa0d8fa4d3f0caca) |
| none | pool | 98/98 | [stxer](https://stxer.xyz/simulations/mainnet/bfbc6a6c2a26a4d6e50ed71dd1758167) |

[Machine-checked recovery report](results/v6-3-recovery/fastpool.json).

## Existing regression reruns

| Harness / mode | N/M | Fork | Saved evidence |
| --- | ---: | --- | --- |
| fastpool-deployment-guards | 22/22 | [stxer](https://stxer.xyz/simulations/mainnet/ba665690ace97352d1b5a2d1913e3291) | [JSON](results/pool-vault-stx/fastpool-deployment-guards.json) |
| fastpool-liquidation | 39/39 | [stxer](https://stxer.xyz/simulations/mainnet/40a3b9c7d02a7710a3258de8b816ce8a) | [JSON](results/pool-vault-stx/fastpool-liquidation.json) |
| fastpool-maker | 35/35 | [stxer](https://stxer.xyz/simulations/mainnet/56d0c6f8b9add6d59062821ffcf9a7f3) | [JSON](results/pool-vault-stx/fastpool-maker.json) |

The older cross-vault dust diagnostic was also updated and rerun: **68/68**, [stxer](https://stxer.xyz/simulations/mainnet/7f59141b60e936923aab06d61902914f), [JSON](results/dust-vaults/v6-3.json). Including it, this repository records **733/733** checks. It exercises test copies of all three vaults at 1, 500, 1,000 and 2,000 sats. The 1-sat trades return `u3002` and retain the sat; the larger trades fill and leave zero sBTC. `is-empty` intentionally considers up to 2 sats dust. This diagnostic rebinds pool authority to the test sender; CCD016 uses a restricted test-sender DAO gate, a real token donation, and a batch-clock fixture. It is separate from the exact-source pool/DAO integration matrix.

## Fork setup and limits

Every recovery fork deploys the unmodified sibling Jing sources under `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22`: `jing-core-v6` → `jing-ladder-v1` → `markets-sbtc-stx-jing-v6-3` → `swap-router-sbtc-stx-jing-v5-3`. It syncs the ladder seats, verifies the market in core, then initializes it with sBTC/STX traits, minimums 1,000 sats / 1,000,000 µSTX, and feed IDs 1 / 45. Market initialization registers with core. The vault and pool (CCD016: book and vault) are then deployed from this repository.

The primary matrix uses real fork token transfers. PoX earned rewards and mirrored pool shares are seeded in storage; creating locks and signer registration are outside this test. The vault funding clock is aged with an explicit Eval (433 burn blocks for the pools, 288 for CCD016); Fastpool’s settlement deadline is also aged. This tests the recovery gate on elapsed state without expiring the signed update needed for fixture creation. It does not simulate days of independent market activity.

Parking is reached through the public ladder seat-reservation setter and a larger publicly submitted and settled entrant. The primary matrix does not rewrite market balances or order maps. CCD016’s DAO Extensions map enables only the actual vault and a sender-guarded proposal extension; this tests extension authorization and treasury flow, not governance voting.

Legacy regression fixtures retain their stated scope: earned rewards/shares, compressed burn-block intervals, and DAO/DIA fixtures. Juice’s upgrade suite also uses deliberately altered candidate authority and injected tranche/order state. The four legacy CCD016 scripts strip comments only from deployed Jing/vault sources, use canonical dependency names, and retain their simulated DAO implementation. The old oracle-staleness widening has been removed. Source hashes and fixture disclosures are saved with the reports.

Migration adjustments preserve scenario intent: deposit calls use submit’s current ABI; full-side placement/readmit tests explicitly settle; empty reclaim is idempotent. Two-chunk liquidation explicitly caps a chunk, because current `sweep-amount` drains a smaller balance in one call. Maker fills close the batch before finishing. Recovery continuity uses the current 432-block emergency delay. No recovery failure was hidden by changing a contract.

## Run

Requires the sibling `~/projects/jing-contracts-v3` checkout and its installed Node dependencies. `JING_SRC` can override its contracts directory. The Lazer helper uses the public route without `PYTH_API_KEY`. The default node is `http://77.42.3.101/stacks-api`; `STACKS_API_URL` overrides it.

```sh
node simulations/pool-vault-stx-stxer.mjs --recovery
node simulations/pool-vault-stx-stxer.mjs
node simulations/pool-vault-stx-stxer.mjs --maker
node simulations/pool-vault-stx-stxer.mjs --lifecycle
node simulations/dust-vaults-stxer.mjs
```

Vault recovery source base: `ab1de34`; Jing source checkout: `24f3e23`.

## Exact recovery-matrix source hashes

| Contract | SHA-256 |
| --- | --- |
| `jing-core-v6` | `53c9b38a46196f777b3c76f76152c172aa50c220e4e8e449d47cb6cd3fe9ab32` |
| `jing-ladder-v1` | `99a6e9f6db9305ebb29d938e69439c720e497bd38c53ec8b447c8c34c528a902` |
| `markets-sbtc-stx-jing-v6-3` | `04b0a7df781aec46124d40d3c73c68169aeed919fed155ec5bf12153bb0bfb85` |
| `swap-router-sbtc-stx-jing-v5-3` | `dfc8165bb846c1e6bb2a95f1e3ac87d3a22bce0e5f2a8f6618a499c8a03f8cae` |
| `fastpool-swap-vault` | `2f6d90f4fb14cff92cc4891bd2ab1f90f09156901a786299006e81534b536225` |
| `signer-manager-vault-stx-rewards` | `91db429775c07f36308699f5678ab044e51e195b4e3b8f59feffb97f0c10d89c` |
