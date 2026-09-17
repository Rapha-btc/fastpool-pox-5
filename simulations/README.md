# STXER simulations

These run the STX-rewards suite against a **mainnet fork**, so they cover
exactly what the simnet tests cannot: the real Bitflow pools with real
liquidity, the real Jing RFQ contract behind the price oracle, and the real
pox-5.

There is also a **local** fork, `pnpm test:fork`, which covers much of the same
ground without submitting anything. Prefer it where it works; see the table.

| | simnet (`tests/`) | local fork (`pnpm test:fork`) | STXER (here) |
| --- | --- | --- | --- |
| real DEX liquidity | no -- mock adapter | **yes** | **yes** |
| real balances / contract state | no | **yes** | **yes** |
| burnchain tenure data | no | **no** -- synthetic | **yes** |
| can advance reward cycles | **yes** | no | no |
| write into a contract's private state | no | no | **yes** (eval step) |
| runs in CI, no submission | **yes** | **yes** | no |

Three consequences worth knowing:

- **The adapters are best checked locally.** `tests/mainnet/adapters.fork.test.ts`
  is the same coverage as simulation 1 and runs in CI.
- **The price baseline can only be measured on STXER.** A local fork does not
  serve `get-tenure-info? miner-spend-total`, which is what
  `price-oracle-jing` is built on -- it returns simnet's synthetic 2,000-sat
  tenure spend, so the oracle reads ~500,000 uSTX/sat against a real ~3,414.
  `tests/mainnet/oracle.fork.test.ts` carries a canary that fails if clarinet
  ever starts forking that data.
- **The full lifecycle can only be run on STXER.** Seeding what `claim-rewards`
  would have written needs a write into the contract's own private maps, which
  is STXER's eval step. clarinet has no local equivalent.

Nothing here is sufficient alone. Together every step is exercised somewhere.

## Running them

```bash
node scripts/build-mainnet.mjs        # REQUIRED -- see below
node simulations/1-adapter-swap.mjs
node simulations/2-full-lifecycle.mjs
node simulations/3-price-baseline.mjs
node simulations/summarize.mjs <id>   # decode a result
EVENTS=1 node simulations/summarize.mjs <id>   # ...with asset transfers
```

`build/mainnet/` is required because `contracts/` carries the **testnet** pox-5
principal, which will not resolve against a mainnet fork. `_shared.mjs` refuses
to run if that build is older than `contracts/` -- a stale build is the worst
failure mode here, because the simulation still succeeds and the URL still looks
fine while exercising the wrong code. That check exists because it happened.

Senders are impersonated, which is how these get funded without a faucet:
`SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2` is a real mainnet sBTC holder.

## 1. `1-adapter-swap.mjs` -- the adapters, for real

The runtime check nothing else gives. `clarinet check` proves the adapters'
arguments type-check against the real router ABIs, but simnet has no liquidity,
so the real call is never *executed*. Here a real sBTC holder swaps 0.01 sBTC
through each adapter against the live pools.

## 2. `2-full-lifecycle.mjs` -- claim, swap, distribute

Deploys the suite, wires it per `docs/deploy-stx-rewards.md` section 5, and runs
a cycle through it.

**One step is seeded, not executed.** A simulation cannot advance reward cycles,
and pox-5 only accrues rewards across a cycle boundary, which a brand-new
contract has not lived through. So `claim-rewards` is stood in for: a real sBTC
holder transfers the pot in, and the state `claim-rewards` and `validate-stake!`
would have written is set directly through STXER's eval step. Everything
downstream -- the swap and the distribution -- is the real contract code.

The claim path itself is covered against a driven pox-5 in
`tests/stx-rewards.test.ts`.

## 3. `3-price-baseline.mjs` -- the floor vs the market

Puts the miner-commit baseline next to live market quotes at four sizes. The
baseline is linear in size (it is a price, with no depth in it); the market
quote is not. That is why the floor cannot double as a slippage bound, and why
`enforce-price-floor` ships off. This is the measurement the runbook asks for
before turning it on.
