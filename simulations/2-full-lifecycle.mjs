#!/usr/bin/env node
//
// Simulation 2 -- claim, swap and distribute, end to end.
//
//   node simulations/2-full-lifecycle.mjs
//
// Deploys the whole suite onto a mainnet fork, wires it the way
// docs/deploy-stx-rewards.md section 5 says to, then runs a cycle through it.
//
// ONE STEP IS SEEDED, NOT EXECUTED, and it is worth being clear about which.
// A simulation is a single point in chain time, so it cannot advance reward
// cycles -- and pox-5 only accrues rewards to a signer across a cycle boundary,
// which a brand-new contract has not lived through. So `claim-rewards` is
// stood in for: the sBTC pot is transferred to the contract by a real sBTC
// holder, and the state that `claim-rewards` and `validate-stake!` would have
// written is set directly. Everything downstream of that -- the swap against
// the live Bitflow pool and the STX distribution -- is the real contract code
// running for real.
//
// The claim path itself is covered against a driven pox-5 in
// tests/stx-rewards.test.ts, which can advance cycles but has no liquidity.
// Between the two, every step is exercised somewhere.
import { Cl } from '@stacks/transactions';
import { SimulationBuilder } from 'stxer';
import {
  DEPLOYER, OPERATOR, SBTC_WHALE, STAKERS, SBTC, source, quoteXyk, btc, stx, report,
} from './_shared.mjs';

const CYCLE = 1000;
const POT_SATS = 1_000_000;        // 0.01 sBTC, as if claim-rewards had pulled it
const FEE_BIPS = 400;              // 4%
const SHARES = [150_000_000_000, 100_000_000_000, 50_000_000_000]; // 150k/100k/50k STX
const TOTAL_SHARES = SHARES.reduce((a, b) => a + b, 0);

const feeSats = Math.floor((POT_SATS * FEE_BIPS) / 10_000);
const netSats = POT_SATS - feeSats;
const quote = await quoteXyk(netSats);
const minOut = (quote * 9900n) / 10000n; // 1% haircut, as the keeper does

console.log(`pot ${btc(POT_SATS)}  fee ${btc(feeSats)} (${FEE_BIPS} bips)  net to DEX ${btc(netSats)}`);
console.log(`live quote ${stx(quote)}  ->  min-stx-out ${stx(minOut)}`);

const MGR = `${DEPLOYER}.fastpool-stx-rewards-signer-manager`;
const ORACLE = `${DEPLOYER}.price-oracle-jing`;
const XYK = `${DEPLOYER}.dex-adapter-bitflow-xyk`;
const DLMM = `${DEPLOYER}.dex-adapter-bitflow-dlmm`;

const ro = (code) => ({ EvalReadonly: [DEPLOYER, '', MGR, code] });
const snapshot = (label) => [
  ro(`(get-swap-status u${CYCLE})`),
  ...STAKERS.map((s) => ro(`(get-staker-rewards '${s} u${CYCLE})`)),
  ro('(get-unpaid-stx)'),
  ro('(get-earned-fees)'),
  ro('(get-unswapped-sats)'),
  { StxBalance: MGR },
];

// What `claim-rewards` and `validate-stake!` would have written, had a cycle
// been able to elapse. Nothing here is reachable from outside the contract --
// these are its own private maps, set through STXER's eval step.
const seed = `(begin
  (map-set cycle-settlement u${CYCLE} {
    pot-sats: u${POT_SATS},
    swapped-sats: u0,
    fee-sats: u0,
    stx-out: u0,
    total-shares: u${TOTAL_SHARES},
    deadline: (+ burn-block-height u432),
    pinned: true
  })
  (var-set unswapped-sats u${POT_SATS})
  (map-set fee-bips-for-cycle u${CYCLE} u${FEE_BIPS})
  ${STAKERS.map((s, i) =>
    `(map-set mirrored-shares { staker: '${s}, reward-cycle: u${CYCLE} } u${SHARES[i]})`).join('\n  ')}
  (map-set mirrored-total-shares u${CYCLE} u${TOTAL_SHARES})
  true)`;

const id = await SimulationBuilder.new()
  // ---------- publish ----------
  .withSender(DEPLOYER)
  .addContractDeploy({ contract_name: 'dex-traits', source_code: source('dex-traits'), fee: 0 })
  .addContractDeploy({
    contract_name: 'fastpool-stx-rewards-signer-manager',
    source_code: source('fastpool-stx-rewards-signer-manager'),
    fee: 0,
  })
  .addContractDeploy({ contract_name: 'price-oracle-jing', source_code: source('price-oracle-jing'), fee: 0 })
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

  // ---------- admin wiring (deploy runbook section 5) ----------
  .addContractCall({ contract_id: MGR, function_name: 'update-fees', function_args: [Cl.uint(FEE_BIPS)], fee: 0 })
  .addContractCall({ contract_id: MGR, function_name: 'set-price-oracle', function_args: [Cl.principal(ORACLE)], fee: 0 })
  .addContractCall({ contract_id: MGR, function_name: 'set-dex-adapter', function_args: [Cl.principal(XYK), Cl.bool(true)], fee: 0 })
  .addContractCall({ contract_id: MGR, function_name: 'set-dex-adapter', function_args: [Cl.principal(DLMM), Cl.bool(true)], fee: 0 })
  .addContractCall({ contract_id: MGR, function_name: 'set-operator', function_args: [Cl.principal(OPERATOR)], fee: 0 })
  .addReads([
    ro('(get-operator)'),
    ro('(get-price-oracle)'),
    ro(`(is-dex-adapter '${XYK})`),
    ro('(get-enforce-price-floor)'),
    { EvalReadonly: [DEPLOYER, '', ORACLE, `(sats-to-ustx u${netSats})`] },
  ])

  // ---------- 1. claim: the pot arrives (stood in for -- see the header) ----------
  .withSender(SBTC_WHALE)
  .addContractCall({
    contract_id: SBTC,
    function_name: 'transfer',
    function_args: [Cl.uint(POT_SATS), Cl.principal(SBTC_WHALE), Cl.principal(MGR), Cl.none()],
    fee: 0,
  })
  .addEvalCode(MGR, seed)
  .addReads(snapshot('after claim'))

  // ---------- 2. swap: real Bitflow, real price ----------
  .withSender(OPERATOR)
  .addContractCall({
    contract_id: MGR,
    function_name: 'swap-rewards',
    function_args: [
      Cl.uint(CYCLE),
      Cl.principal(XYK),
      Cl.principal(ORACLE),
      Cl.uint(POT_SATS),
      Cl.uint(minOut),
    ],
    fee: 0,
  })
  .addReads(snapshot('after swap'))

  // ---------- 3. distribute: permissionless, so anyone sends it ----------
  .withSender(SBTC_WHALE)
  .addContractCall({
    contract_id: MGR,
    function_name: 'distribute-rewards-many',
    function_args: [Cl.list(STAKERS.map((s) => Cl.principal(s))), Cl.uint(CYCLE)],
    fee: 0,
  })
  .addReads([...snapshot('after distribute'), ...STAKERS.map((s) => ({ StxBalance: s }))])
  .run();

report('Simulation 2 -- claim (seeded) -> swap (real) -> distribute (real)', id);
STAKERS.forEach((s, i) =>
  console.log(`  staker ${i + 1}: ${(SHARES[i] / 1e6).toLocaleString()} STX staked  (${((SHARES[i] / TOTAL_SHARES) * 100).toFixed(1)}% of the pool)`));
