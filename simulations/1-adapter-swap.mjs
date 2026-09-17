#!/usr/bin/env node
//
// Simulation 1 -- the DEX adapters, against real Bitflow liquidity.
//
//   node simulations/1-adapter-swap.mjs
//
// This is the runtime check that neither `clarinet check` nor the simnet tests
// can give. `clarinet check` proves the adapters' arguments type-check against
// the real mainnet router ABIs, but simnet has no liquidity, so the mock stands
// in and the real call is never *executed*. Here it is: a real sBTC holder
// swaps through each adapter against the live pools, on a mainnet fork.
//
// What to look for in the result: the sBTC leaving the caller, the STX arriving,
// and the two venues quoting different prices for the same size -- which is the
// whole argument for carrying both adapters and splitting a pot between them.
import { Cl } from '@stacks/transactions';
import { SimulationBuilder } from 'stxer';
import {
  DEPLOYER, SBTC_WHALE, SBTC, source, quoteXyk, btc, stx, report,
} from './_shared.mjs';

// Small enough that neither pool is moved much: see the depth table in
// docs/deploy-stx-rewards.md section 7.
const AMOUNT_SATS = 1_000_000; // 0.01 sBTC
const SLIPPAGE_BIPS = 100n; // 1%

const quote = await quoteXyk(AMOUNT_SATS);
const minOut = (quote * (10000n - SLIPPAGE_BIPS)) / 10000n;
console.log(`live XYK quote for ${btc(AMOUNT_SATS)}: ${stx(quote)}`);
console.log(`min-stx-out at ${SLIPPAGE_BIPS} bips: ${stx(minOut)}`);

const XYK = `${DEPLOYER}.dex-adapter-bitflow-xyk`;
const DLMM = `${DEPLOYER}.dex-adapter-bitflow-dlmm`;
const bal = (who) => [
  { StxBalance: who },
  { EvalReadonly: [DEPLOYER, '', SBTC, `(get-balance '${who})`] },
];

const id = await SimulationBuilder.new()
  .withSender(DEPLOYER)
  .addContractDeploy({ contract_name: 'dex-traits', source_code: source('dex-traits'), fee: 0 })
  .addContractDeploy({
    contract_name: 'dex-adapter-bitflow-xyk',
    source_code: source('dex-adapter-bitflow-xyk'),
    fee: 0,
  })
  .addContractDeploy({
    contract_name: 'dex-adapter-bitflow-dlmm',
    source_code: source('dex-adapter-bitflow-dlmm'),
    fee: 0,
  })

  // --- before ---
  .addReads(bal(SBTC_WHALE))

  // --- constant-product pool ---
  .withSender(SBTC_WHALE)
  .addContractCall({
    contract_id: XYK,
    function_name: 'swap-sbtc-to-stx',
    function_args: [Cl.uint(AMOUNT_SATS), Cl.uint(minOut)],
    fee: 0,
  })
  .addReads(bal(SBTC_WHALE))

  // --- concentrated-liquidity pool, same size, same min-out ---
  .addContractCall({
    contract_id: DLMM,
    function_name: 'swap-sbtc-to-stx',
    function_args: [Cl.uint(AMOUNT_SATS), Cl.uint(minOut)],
    fee: 0,
  })
  .addReads(bal(SBTC_WHALE))
  .run();

report('Simulation 1 -- adapters against real Bitflow liquidity', id);
console.log(`  ${btc(AMOUNT_SATS)} through each of the two venues, from ${SBTC_WHALE}`);
