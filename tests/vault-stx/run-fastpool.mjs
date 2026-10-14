// FastPool-only Clarinet SDK tests, pinned to the final production source bytes.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDir, '../..');
let require = createRequire(resolve(projectRoot, 'package.json'));
try {
  require.resolve('@stacks/clarinet-sdk');
} catch {
  require = createRequire(resolve(projectRoot, '../jing-contracts-v3/package.json'));
}
const { initSimnet, tx } = require('@stacks/clarinet-sdk');
const { Cl, cvToString } = require('@stacks/transactions');
const manifest = resolve(testDir, '.build/fastpool-only/Clarinet.toml');
const sim = await initSimnet(manifest, true);

const accounts = sim.getAccounts();
const admin = accounts.get('deployer');
const alice = accounts.get('wallet_1');
const bob = accounts.get('wallet_2');
const F = 'fastpool-stx-vault-signer';
const FV = 'fastpool-swap-vault';
const FVN = 'fastpool-swap-vault-next';
const cp = name => Cl.contractPrincipal(admin, name);
const u = value => Cl.uint(value);
const update = Cl.buffer(new Uint8Array());
const vaultFunctions = new Set([
  'fund-swap-vault', 'finalize-swap-vault', 'recover-swap-vault', 'refloor-vault',
  'set-vault-window-blocks', 'set-vault-leeway-bps', 'set-vault-slippage-bps',
  'set-vault-max-chunk-sats', 'set-vault-dia-band-bps', 'set-vault-router-cooldown',
  'set-vault-no-pyth-slippage-bps', 'jing-take', 'router-swap-split',
  'router-swap-split-dia',
]);

let checks = 0;
function call(contract, fn, args = [], sender = alice) {
  const finalArgs = contract === F && vaultFunctions.has(fn) ? [...args, cp(FV)] : args;
  return sim.callPublicFn(contract, fn, finalArgs, sender);
}
function ok(result) {
  assert.equal(result.result.type, 'ok', cvToString(result.result));
  checks += 1;
  return result.result.value;
}
function err(result, code) {
  assert.equal(cvToString(result.result), `(err u${code})`);
  checks += 1;
}
function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  checks += 1;
}
function truthy(actual, message) {
  assert.ok(actual, message);
  checks += 1;
}
function read(contract, fn, args = []) {
  return sim.callReadOnlyFn(contract, fn, args, admin).result;
}
function stx(who) {
  return sim.getAssetsMap().get('STX').get(who) || 0n;
}
function ft(who) {
  return read('mock-ft', 'get-balance', [Cl.principal(who)]).value.value;
}

// Admin boundaries and fixed vault access.
ok(sim.transferSTX(50_000_000_000n, `${admin}.mock-router`, admin));
err(call(FV, 'fund', [u(1)], admin), 16000);
err(call(F, 'set-vault-window-blocks', [u(288)]), 1001);
err(call(F, 'set-vault-window-blocks', [u(289)], admin), 16033);
err(call(FV, 'set-window-blocks', [u(1)], admin), 16000);
ok(call(F, 'set-vault-window-blocks', [u(288)], admin));

// Full swap lifecycle, per-cycle pro-rata payouts, oracle guards and cooldown.
const cycle = 141;
for (const [who, amount] of [[alice, 1], [bob, 3]]) {
  ok(call('mock-pox', 'stake-test', [cp(F), Cl.principal(who), u(cycle), u(amount)]));
}
ok(call(F, 'claim-rewards', [u(cycle)]));
ok(call(F, 'fund-swap-vault', [u(cycle)]));
err(call(F, 'fund-swap-vault', [u(cycle)]), 1050);
err(call(FV, 'finish', [], admin), 16000);
ok(call(FV, 'jing-place', [update]));
err(call(FV, 'router-swap', [update]), 16031);
err(call(F, 'finalize-swap-vault'), 16032);
sim.mineEmptyBurnBlocks(288);
ok(call(FV, 'jing-reclaim'));
ok(call('mock-dia', 'set-skew', [u(13000)]));
err(call(FV, 'router-swap', [update]), 16037);
ok(call('mock-dia', 'set-skew', [u(10000)]));
ok(call('mock-dia', 'set-stale', [Cl.bool(true)]));
err(call(FV, 'router-swap', [update]), 16036);
ok(call('mock-dia', 'set-stale', [Cl.bool(false)]));
ok(call(F, 'set-vault-max-chunk-sats', [u(500000)], admin));
const first = tx.callPublicFn(FV, 'router-swap', [update], alice);
const sameBlock = sim.mineBlock([
  first,
  tx.callPublicFn(FV, 'router-swap', [update], bob),
]);
ok(sameBlock[0]);
err(sameBlock[1], 16044);
err(call(F, 'finalize-swap-vault'), 16032);
sim.mineEmptyBurnBlock();
ok(call(FV, 'router-swap', [update]));
ok(call(F, 'set-vault-max-chunk-sats', [u(1000000)], admin));
equal(ok(call(F, 'finalize-swap-vault')).value, 3_200_000_000n);
let aliceStx = stx(alice);
let bobStx = stx(bob);
ok(call(F, 'distribute-rewards-many', [Cl.list([Cl.principal(alice), Cl.principal(bob)]), u(cycle)]));
equal(stx(alice) - aliceStx, 800_000_000n);
equal(stx(bob) - bobStx, 2_400_000_000n);
aliceStx = stx(alice);
err(call(F, 'distribute-rewards', [Cl.principal(alice), u(cycle)]), 1013);
equal(stx(alice), aliceStx);
truthy(cvToString(read(FV, 'get-clock')).includes('(batch-start none)'));
console.log('FastPool: patience, reclaim, oracle rejection, chunk cooldown, finalization, pro-rata STX and replay guards passed');

// The fee snapshot survives an admin rate change and a later claim for the same cycle.
ok(call(F, 'update-fees', [u(500)], admin));
ok(call('mock-pox', 'set-cycle', [u(152)]));
for (const [who, amount] of [[alice, 1], [bob, 3]]) {
  ok(call('mock-pox', 'stake-test', [cp(F), Cl.principal(who), u(149), u(amount)]));
}
ok(call(F, 'claim-rewards', [u(149)]));
ok(call(F, 'update-fees', [u(0)], admin));
for (let batch = 0; batch < 2; batch += 1) {
  ok(call(F, 'fund-swap-vault', [u(149)]));
  equal(read(F, 'get-earned-fees').value, BigInt((batch + 1) * 50_000));
  if (batch === 0) ok(call(F, 'claim-rewards', [u(149)]));
  sim.mineEmptyBurnBlocks(288);
  ok(call(FV, 'router-swap', [update]));
  equal(ok(call(F, 'finalize-swap-vault')).value, 3_040_000_000n);
  aliceStx = stx(alice);
  bobStx = stx(bob);
  ok(call(F, 'distribute-rewards-many', [Cl.list([Cl.principal(alice), Cl.principal(bob)]), u(149)]));
  equal(stx(alice) - aliceStx, 760_000_000n);
  equal(stx(bob) - bobStx, 2_280_000_000n);
}
equal(read(F, 'get-unswapped-sats').value, 0n);
equal(read(F, 'get-unpaid-stx').value, 0n);
err(call(F, 'withdraw-fees', [u(100001), Cl.principal(admin)], admin), 1005);
ok(call(F, 'withdraw-fees', [u(100000), Cl.principal(admin)], admin));
console.log('FastPool: fee snapshot, late claim isolation, batch totals and fee withdrawal passed');

// The timed fallback recovers unsold sBTC and pays it with no second fee.
ok(call(F, 'update-fees', [u(500)], admin));
for (const [who, amount] of [[alice, 1], [bob, 3]]) {
  ok(call('mock-pox', 'stake-test', [cp(F), Cl.principal(who), u(150), u(amount)]));
}
ok(call(F, 'claim-rewards', [u(150)]));
ok(call(F, 'fund-swap-vault', [u(150)]));
err(call(F, 'recover-swap-vault'), 1052);
sim.mineEmptyBurnBlocks(433);
ok(call(F, 'recover-swap-vault'));
equal(read(F, 'get-unswapped-for-cycle', [u(150)]).value, 950_000n);
let aliceFt = ft(alice);
let bobFt = ft(bob);
ok(call(F, 'distribute-rewards-many', [Cl.list([Cl.principal(alice), Cl.principal(bob)]), u(150)]));
equal(ft(alice) - aliceFt, 237_500n);
equal(ft(bob) - bobFt, 712_500n);
equal(read(F, 'get-unswapped-sats').value, 0n);
equal(read(F, 'get-earned-fees').value, 50_000n);
console.log('FastPool: 432-block fallback and mixed-asset pro-rata recovery passed');

// Vault handover requires an idle vault and its full 4032-block notice.
equal(cvToString(read(F, 'get-swap-vault')), cvToString(cp(FV)));
err(call(F, 'propose-swap-vault', [cp(FV)], admin), 1055);
err(call(F, 'propose-swap-vault', [cp(FVN)]), 1001);
ok(call(F, 'propose-swap-vault', [cp(FVN)], admin));
err(call(F, 'confirm-swap-vault', [cp(FV), cp(FVN)], admin), 1057);
sim.mineEmptyBurnBlocks(4032);
ok(call(F, 'confirm-swap-vault', [cp(FV), cp(FVN)], admin));
equal(cvToString(read(F, 'get-swap-vault')), cvToString(cp(FVN)));
err(call(F, 'set-vault-window-blocks', [u(288)], admin), 1055);
ok(sim.callPublicFn(F, 'set-vault-window-blocks', [u(288), cp(FVN)], admin));
console.log(`FastPool: vault handover and active-vault enforcement passed (${checks} assertions)`);
