#!/usr/bin/env node
//
// Simulation 3 -- the miner-commit price baseline, next to what the market
// actually pays.
//
//   node simulations/3-price-baseline.mjs
//
// `price-oracle-jing` reads a price derived from what miners pay to win a
// tenure, via Jing's RFQ contract. It is the floor that would bound a
// compromised operator key -- and it ships DISABLED, because measurement said
// it runs well above market and would reject honest swaps.
//
// This puts the two numbers side by side at several sizes, on live state, so
// the gap can be checked rather than taken on trust. It is the measurement the
// deploy runbook asks for before `set-enforce-price-floor true`.
import { SimulationBuilder } from 'stxer';
import {
  DEPLOYER, SBTC, WSTX, XYK_HELPER, XYK_POOL, source, quoteXyk, btc, stx, report,
} from './_shared.mjs';

const SIZES = [100_000, 1_000_000, 5_000_000, 10_000_000]; // 0.001 .. 0.1 sBTC

const ORACLE = `${DEPLOYER}.price-oracle-jing`;
const xykQuote = (sats) => `(contract-call? '${XYK_HELPER} get-quote-a u${sats} none
   { a: '${SBTC}, b: '${WSTX} } { a: '${XYK_POOL} })`;

const id = await SimulationBuilder.new()
  .withSender(DEPLOYER)
  .addContractDeploy({ contract_name: 'dex-traits', source_code: source('dex-traits'), fee: 0 })
  .addContractDeploy({ contract_name: 'price-oracle-jing', source_code: source('price-oracle-jing'), fee: 0 })
  .addReads([
    // The raw feed and the coinbase it assumes.
    { EvalReadonly: [DEPLOYER, '', ORACLE, '(get-native-price)'] },
    { EvalReadonly: [DEPLOYER, '', ORACLE, '(get-coinbase-ustx)'] },
    // Baseline vs market, at each size. Baseline is linear in size (it is a
    // price, with no depth in it); the market quote is not, which is exactly
    // why the floor cannot double as a slippage bound.
    ...SIZES.flatMap((sats) => [
      { EvalReadonly: [DEPLOYER, '', ORACLE, `(sats-to-ustx u${sats})`] },
      { EvalReadonly: [DEPLOYER, '', ORACLE, xykQuote(sats)] },
    ]),
  ])
  .run();

report('Simulation 3 -- miner-commit baseline vs live market price', id);
console.log('  reads, in pairs: baseline then live XYK quote, for');
for (const s of SIZES) console.log(`    ${btc(s)}`);

// The same comparison locally, so the numbers are in the console too.
console.log('\n  local cross-check (live reads, not the simulation):');
for (const sats of SIZES) {
  const q = await quoteXyk(sats);
  console.log(`    ${btc(sats).padStart(12)}  market ${stx(q).padStart(14)}  (${(Number(q) / sats).toFixed(1)} uSTX/sat)`);
}
