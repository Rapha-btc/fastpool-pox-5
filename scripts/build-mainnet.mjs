#!/usr/bin/env node
//
// Emit mainnet-ready sources for the STX-rewards suite, plus a Clarinet
// deployment plan that publishes them.
//
//   node scripts/build-mainnet.mjs                       # -> build/mainnet/*.clar + deployments/stx-rewards.mainnet-plan.yaml
//   DEPLOYER=SP... node scripts/build-mainnet.mjs
//   clarinet deployments apply -p deployments/stx-rewards.mainnet-plan.yaml
//
// WHY THIS EXISTS
//
// The contracts in contracts/ are written against the TESTNET pox-5 principal,
// `ST000000000000000000002AMW42H.pox-5`, because that is the address the
// vendored boot copy and the simnet tests use. On mainnet the very same boot
// contract lives at `SP000000000000000000002Q6VF78.pox-5`. Publishing the
// testnet-addressed source to mainnet fails analysis: the trait it implements
// would not resolve.
//
// The sBTC and DEX principals need no rewriting -- they are already the mainnet
// ones, which is exactly why `clarinet check` can type-check the adapters
// against the real routers.
//
// It also strips `#[env(simnet)]` code -- the Rendezvous harness living inside
// the signer manager. Clarinet strips that itself at publish time, so this is
// not what keeps it off mainnet; it is so that build/mainnet IS the production
// artifact. The STXER simulations and the mainnet-fork tests deploy these files
// directly rather than through `clarinet deployments apply`, and they should be
// exercising the shape that actually ships.
//
// A reviewer diffing build/mainnet against contracts/ should therefore see
// exactly two kinds of change: the pox-5 principal, and the removal of
// annotated test code.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const TESTNET_POX5 = 'ST000000000000000000002AMW42H';
const MAINNET_POX5 = 'SP000000000000000000002Q6VF78';

// Jing's Juice market is not on mainnet yet, so it cannot be a Clarinet
// `requirement`; it is vendored under vendor/ instead, and the adapter refers
// to it with same-deployer sugar so it resolves against that local copy. For a
// mainnet build that reference has to become the real principal.
//
// CONFIRM THIS ADDRESS BEFORE APPLYING. It is taken from JING-MARKET in the
// authors' own vault-sbtc-stx-v2.clar, which is the expected v3 deployment --
// but the contracts were not yet published when the adapter was written.
//
// The adapter itself lives in contracts/pending/ and is NOT in this suite yet;
// the rewrite below is here so that promoting it is one line, not a redesign.
const JING_MARKET_LOCAL = '.markets-sbtc-stx-jing-v2';
const JING_MARKET_MAINNET =
  "'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v2";

// Publish order matters: `dex-traits` defines the traits the others use, and
// the signer manager must exist before an adapter is allowlisted against it.
// `mock-dex-adapter` is absent on purpose -- it is a test fixture.
const SUITE = [
  ['dex-traits', 'contracts/dex-traits.clar'],
  ['fastpool-stx-rewards-signer-manager', 'contracts/signer-manager-stx-rewards.clar'],
  ['price-oracle-jing', 'contracts/price-oracle-jing.clar'],
  ['dex-adapter-bitflow-dlmm', 'contracts/dex-adapter-bitflow-dlmm.clar'],
  ['dex-adapter-bitflow-xyk', 'contracts/dex-adapter-bitflow-xyk.clar'],
];

const deployer = process.env.DEPLOYER ?? 'SPMPMA1V6P430M8C91QS1G9XJ95S59JS1TZFZ4Q4';
const outDir = 'build/mainnet';
mkdirSync(outDir, { recursive: true });

/**
 * Drop every top-level form annotated `;; #[env(simnet)]`.
 *
 * The annotation applies to the expression that follows it, so this walks
 * forward from the marker balancing parens -- counting only real code, not
 * parens inside comments or strings.
 */
function stripSimnetCode(src) {
  const lines = src.split('\n');
  const out = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*;;\s*#\[env\(simnet\)\]\s*$/.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    // Skip the annotation, then the whole form it annotates.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    let depth = 0;
    let started = false;
    for (; j < lines.length; j++) {
      let inString = false;
      for (let k = 0; k < lines[j].length; k++) {
        const c = lines[j][k];
        if (inString) {
          if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === ';') break;
        else if (c === '(') {
          depth++;
          started = true;
        } else if (c === ')') depth--;
      }
      if (started && depth === 0) break;
    }
    removed++;
    i = j;
    // Also drop the comment block that introduced it.
    while (out.length && /^\s*;;/.test(out[out.length - 1])) out.pop();
    while (out.length && out[out.length - 1].trim() === '') out.pop();
  }
  // Whatever the removals leave behind at the end of the file is orphaned
  // commentary for code that is no longer there -- and comments are bytes, which
  // this contract pays for as `read_length` on every call.
  while (out.length && (out[out.length - 1].trim() === '' || /^\s*;;/.test(out[out.length - 1]))) {
    out.pop();
  }
  return { source: `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`, removed };
}

const rewritten = [];
for (const [name, path] of SUITE) {
  const src = readFileSync(path, 'utf8');
  const stripped = stripSimnetCode(src);
  let out = stripped.source.split(TESTNET_POX5).join(MAINNET_POX5);
  const hits = stripped.source.split(TESTNET_POX5).length - 1;
  const jingHits = out.split(JING_MARKET_LOCAL).length - 1;
  out = out.split(JING_MARKET_LOCAL).join(JING_MARKET_MAINNET);
  writeFileSync(`${outDir}/${name}.clar`, out);
  rewritten.push({ name, path, out: `${outDir}/${name}.clar`, hits });
  const extra = jingHits ? `, ${jingHits} jing-market ref(s)` : '';
  const simnet = stripped.removed ? `, ${stripped.removed} #[env(simnet)] form(s) stripped` : '';
  console.log(`${name.padEnd(36)} ${String(hits).padStart(3)} pox-5 principal(s)${extra}${simnet}`);
}

// Sanity: nothing may still point at the testnet boot address.
for (const r of rewritten) {
  const body = readFileSync(r.out, 'utf8');
  if (body.includes(TESTNET_POX5)) {
    console.error(`FATAL: ${r.out} still references ${TESTNET_POX5}`);
    process.exit(1);
  }
  if (body.includes(JING_MARKET_LOCAL) && !body.includes(JING_MARKET_MAINNET)) {
    console.error(`FATAL: ${r.out} still points at the vendored Jing market`);
    process.exit(1);
  }
  // Belt and braces: no test symbol may survive into a production artifact.
  for (const marker of ['#[env(simnet)]', 'invariant-', 'test-', 'update-context']) {
    if (body.includes(marker)) {
      console.error(`FATAL: ${r.out} still contains simnet-only code (${marker})`);
      process.exit(1);
    }
  }
}

const plan = `id: 0
name: fastpool-stx-rewards-signer-manager mainnet deployment
network: mainnet
stacks-node: https://api.hiro.so
bitcoin-node: http://blockstack:blockstacksystem@bitcoin.blockstack.com:8332
# GENERATED by scripts/build-mainnet.mjs -- do not hand-edit; regenerate instead.
#
# Sources come from build/mainnet/, which is contracts/ with the pox-5 principal
# rewritten from the testnet boot address to the mainnet one. Diff the two trees
# before applying; the only difference should be that principal.
#
# After applying, the suite still needs its admin wiring before it can run a
# cycle -- see docs/deploy-stx-rewards.md:
#   set-price-oracle, set-max-slippage-bips, set-dex-adapter (x2),
#   set-operator, update-fees, register-self
plan:
  batches:
${SUITE.map(([name], i) => `  - id: ${i}
    transactions:
    - transaction-type: contract-publish
      contract-name: ${name}
      expected-sender: ${deployer}
      cost: 500000
      path: ${outDir}/${name}.clar
      anchor-block-only: true
      clarity-version: 6
    epoch: '4.0'`).join('\n')}
`;
writeFileSync('deployments/stx-rewards.mainnet-plan.yaml', plan);
console.log('\nwrote deployments/stx-rewards.mainnet-plan.yaml');
console.log(`deployer: ${deployer}  (override with DEPLOYER=SP...)`);
