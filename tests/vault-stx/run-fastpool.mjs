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
const sim = globalThis.simnet || await initSimnet(manifest, true);

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
  'set-vault-pyth-fee-budget', 'set-vault-no-pyth-slippage-bps', 'jing-take', 'router-swap-split',
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

// Read-only config/status and all signer-routed vault controls.
truthy(cvToString(read(FV, 'get-config')).includes('(window-blocks u288)'));
truthy(cvToString(read(FV, 'get-upgrade-status')).includes('(empty true)'));
truthy(cvToString(read(FV, 'get-no-pyth-price')).includes('(source "dia")'));
err(call(FV, 'close-batch', [], admin), 16032);
err(call(FV, 'set-max-chunk-sats', [u(1)], admin), 16000);
err(call(FV, 'emergency-recover', [], admin), 16000);
err(call(FV, 'jing-take', [u(1), update], admin), 16000);
err(call(FV, 'router-swap-split', [u(1), u(1), u(0), u(0), u(0), update], admin), 16000);
err(call(FV, 'router-swap-split-dia', [u(1), u(1), u(0), u(0)], admin), 16000);
truthy(cvToString(read(F, 'get-pending-swap-vault')).includes('(vault none)'));
equal(cvToString(read(F, 'get-vault-cycle')), 'none');
equal(read(F, 'get-fees-bips').value, 0n);
equal(read(F, 'get-fee-bips-for-cycle', [u(140)]).value, 0n);
equal(read(F, 'get-mirrored-shares', [Cl.principal(alice), u(140)]).value, 0n);
equal(read(F, 'get-mirrored-total-shares', [u(140)]).value, 0n);
truthy(cvToString(read(F, 'get-swap-status', [u(140)])).includes('(remaining-sats u0)'));
truthy(cvToString(read(F, 'check-mirror', [u(140)])).includes('(matches true)'));
const callbackArgs = [cp(F), Cl.principal(alice), u(170)];
err(call(F, 'validate-stake!', [Cl.principal(alice), u(170), u(1), u(1), u(0), Cl.bool(false), Cl.none()]), 1003);
err(call('mock-pox', 'callback-test', [...callbackArgs, u(1), u(1), Cl.bool(true), Cl.none()]), 1015);
err(call('mock-pox', 'callback-test', [...callbackArgs, u(1), u(1), Cl.bool(false), Cl.some(Cl.buffer(new Uint8Array([1])))]), 1016);
err(call('mock-pox', 'callback-test', [...callbackArgs, u(97), u(1), Cl.bool(false), Cl.none()]), 1019);
for (const [fn, value, max] of [
  ['set-vault-leeway-bps', 100, 1000],
  ['set-vault-slippage-bps', 200, 1000],
  ['set-vault-dia-band-bps', 500, 5000],
  ['set-vault-router-cooldown', 2, 144],
  ['set-vault-pyth-fee-budget', 1000000, 10000000],
  ['set-vault-no-pyth-slippage-bps', 1200, 5000],
]) {
  err(call(F, fn, [u(value)]), 1001);
  err(call(F, fn, [u(max + 1)], admin), 16033);
  ok(call(F, fn, [u(value)], admin));
  const underlying = fn.replace('set-vault-', 'set-').replace('set-no-pyth-slippage-bps', 'set-no-pyth-slippage-bps');
  err(call(FV, underlying, [u(value)], admin), 16000);
}
err(call(F, 'set-vault-max-chunk-sats', [u(0)], admin), 16033);
ok(call(F, 'set-vault-pyth-fee-budget', [u(0)], admin));
truthy(cvToString(read(FV, 'get-config')).includes('(leeway-bps u100)'));
truthy(cvToString(read(FV, 'get-config')).includes('(no-pyth-slippage-bps u1200)'));
ok(call(F, 'set-vault-leeway-bps', [u(500)], admin));
ok(call(F, 'set-vault-slippage-bps', [u(100)], admin));
ok(call(F, 'set-vault-dia-band-bps', [u(1000)], admin));
ok(call(F, 'set-vault-router-cooldown', [u(1)], admin));
ok(call(F, 'set-vault-no-pyth-slippage-bps', [u(1000)], admin));

// Permissionless mirror repair handles a downward and an upward reconciliation.
const repairCycle = 160;
for (const [who, amount] of [[alice, 1], [bob, 3]]) {
  ok(call('mock-pox', 'stake-test', [cp(F), Cl.principal(who), u(repairCycle), u(amount)]));
}
ok(call('mock-pox', 'set-share', [Cl.principal(alice), u(repairCycle), cp(F), u(0)]));
ok(call('mock-pox', 'set-share', [Cl.principal(bob), u(repairCycle), cp(F), u(4)]));
ok(call('mock-pox', 'set-total', [u(repairCycle), cp(F), u(5)]));
truthy(cvToString(read(F, 'check-mirror', [u(repairCycle)])).includes('(matches false)'));
ok(call('mock-pox', 'set-total', [u(repairCycle), cp(F), u(4)]));
const repaired = cvToString(ok(call(F, 'repair-mirror-many', [
  Cl.list([Cl.principal(alice), Cl.principal(bob)]), u(repairCycle),
])));
truthy(repaired.includes('(removed u1)'));
truthy(repaired.includes('(added u1)'));
equal(read(F, 'get-mirrored-shares', [Cl.principal(alice), u(repairCycle)]).value, 0n);
equal(read(F, 'get-mirrored-total-shares', [u(repairCycle)]).value, 4n);
truthy(cvToString(read(F, 'check-mirror', [u(repairCycle)])).includes('(matches true)'));
// Equal entries take the no-op arm of fold-repair-mirror.
ok(call(F, 'repair-mirror-many', [Cl.list([Cl.principal(alice), Cl.principal(bob)]), u(repairCycle)]));
err(call(F, 'pin-shares', [u(repairCycle)]), 1020);

// Full swap lifecycle, per-cycle pro-rata payouts, oracle guards and cooldown.
const cycle = 141;
for (const [who, amount] of [[alice, 1], [bob, 3]]) {
  ok(call('mock-pox', 'stake-test', [cp(F), Cl.principal(who), u(cycle), u(amount)]));
}
equal(read(F, 'get-mirrored-shares', [Cl.principal(alice), u(cycle)]).value, 1n);
equal(read(F, 'get-mirrored-total-shares', [u(cycle)]).value, 4n);
truthy(cvToString(read(F, 'check-mirror', [u(cycle)])).includes('(matches true)'));
ok(call(F, 'claim-rewards', [u(cycle)]));
equal(read(F, 'get-fee-bips-for-cycle', [u(cycle)]).value, 0n);
truthy(cvToString(read(F, 'get-settlement', [u(cycle)])).includes('(pot-sats u1000000)'));
truthy(cvToString(read(F, 'get-swap-status', [u(cycle)])).includes('(window-open true)'));
ok(call(F, 'fund-swap-vault', [u(cycle)]));
truthy(cvToString(read(F, 'get-vault-cycle')).includes(`(some u${cycle})`));
equal(ok(call(F, 'pin-shares', [u(cycle)])).value, 4n);
ok(call('mock-pox', 'callback-test', [cp(F), Cl.principal(alice), u(cycle), u(1), u(99), Cl.bool(false), Cl.none()]));
err(call(F, 'repair-mirror-many', [Cl.list([Cl.principal(alice)]), u(cycle)]), 1012);
err(call(FV, 'close-batch', [], admin), 16043);
err(call(FV, 'jing-reclaim', []), 16031);
err(call(F, 'fund-swap-vault', [u(cycle)]), 1050);
err(call(F, 'set-vault-window-blocks', [u(288)], admin), 16045);
err(call(FV, 'finish', [], admin), 16000);
ok(call(FV, 'jing-place', [update]));
err(call(F, 'refloor-vault', [update]), 1001);
err(call(FV, 'jing-refloor', [update], admin), 16000);
ok(call(F, 'refloor-vault', [update], admin));
ok(call(F, 'set-vault-dia-band-bps', [u(0)], admin));
ok(call(F, 'refloor-vault', [update], admin));
ok(call(F, 'set-vault-dia-band-bps', [u(1000)], admin));
err(call(F, 'jing-take', [u(1), update]), 1001);
err(call(F, 'jing-take', [u(1), update], admin), 16031);
err(call(FV, 'router-swap', [update]), 16031);
err(call(F, 'finalize-swap-vault'), 16032);
sim.mineEmptyBurnBlocks(288);
err(call(FV, 'jing-place', [update]), 16030);
ok(call(FV, 'jing-reclaim'));
ok(call('mock-dia', 'set-skew', [u(13000)]));
err(call(FV, 'router-swap', [update]), 16037);
ok(call('mock-dia', 'set-skew', [u(7000)]));
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
equal(cvToString(read(F, 'get-vault-cycle')), 'none');
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
equal(read(F, 'get-fee-bips-for-cycle', [u(149)]).value, 500n);
truthy(cvToString(read(F, 'get-settlement', [u(149)])).includes('(pinned true)'));
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

// A sub-dust market remainder is reclaimed immediately and finishes with zero STX.
ok(call('mock-pox', 'set-reward', [u(1)]));
ok(call('mock-pox', 'stake-test', [cp(F), Cl.principal(alice), u(151), u(1)]));
ok(call('mock-pox', 'stake-test', [cp(F), Cl.principal(bob), u(151), u(3)]));
ok(call(F, 'claim-rewards', [u(151)]));
ok(call(F, 'fund-swap-vault', [u(151)]));
ok(call(FV, 'jing-place', [update]));
ok(call(FV, 'close-batch', [], admin));
equal(ok(call(F, 'finalize-swap-vault')).value, 0n);
ok(call('mock-pox', 'set-reward', [u(1000000)]));
ok(call('mock-pox', 'set-reward', [u(0)]));
ok(call(F, 'claim-rewards', [u(171)]));
equal(ok(call(F, 'pin-shares', [u(171)])).value, 0n);
ok(call(F, 'distribute-rewards-many', [Cl.list([Cl.principal(alice), Cl.principal(bob)]), u(171)]));
err(call(F, 'fund-swap-vault', [u(171)]), 1051);
ok(call('mock-pox', 'set-reward', [u(1000000)]));
ok(call('mock-pox', 'set-total', [u(160), cp(F), u(5)]));
ok(call(F, 'claim-rewards', [u(160)]));
err(call(F, 'pin-shares', [u(160)]), 1008);
ok(call('mock-pox', 'set-total', [u(160), cp(F), u(4)]));
equal(ok(call(F, 'pin-shares', [u(160)])).value, 4n);
err(call(F, 'repair-mirror-many', [Cl.list([Cl.principal(alice)]), u(160)]), 1012);
ok(call(F, 'fund-swap-vault', [u(160)]));
ok(sim.transferSTX(12n, `${admin}.${FV}`, admin));
ok(call(FV, 'jing-place', [update]));
truthy(cvToString(read(FV, 'get-clock')).includes('(window-ends (some u'));
sim.mineEmptyBurnBlocks(433);
ok(call(F, 'refloor-vault', [update], admin));
ok(call(F, 'recover-swap-vault'));
const bobFtBeforeCycle160 = ft(bob);
const bobStxBeforeCycle160 = stx(bob);
ok(call(F, 'distribute-rewards-many', [Cl.list([Cl.principal(alice), Cl.principal(bob)]), u(160)]));
equal(ft(bob) - bobFtBeforeCycle160, 950_001n);
equal(stx(bob) - bobStxBeforeCycle160, 12n);
equal(read(F, 'get-unpaid-stx').value, 0n);
truthy(cvToString(read(F, 'get-swap-status', [u(160)])).includes('(window-open false)'));

// The signer deadline can precede the vault deadline if funding is delayed.
ok(call('mock-pox', 'stake-test', [cp(F), Cl.principal(alice), u(172), u(1)]));
ok(call('mock-pox', 'stake-test', [cp(F), Cl.principal(bob), u(172), u(3)]));
ok(call(F, 'claim-rewards', [u(172)]));
sim.mineEmptyBurnBlocks(100);
ok(call(F, 'fund-swap-vault', [u(172)]));
sim.mineEmptyBurnBlocks(333);
err(call(F, 'recover-swap-vault'), 16046);
sim.mineEmptyBurnBlocks(99);
ok(call(F, 'recover-swap-vault'));
const bobFtBeforeCycle172 = ft(bob);
ok(call(F, 'distribute-rewards-many', [Cl.list([Cl.principal(alice), Cl.principal(bob)]), u(172)]));
equal(ft(bob) - bobFtBeforeCycle172, 712_500n);

// Unreserved donated sBTC/STX is sweepable; the fee and stacker liabilities stay reserved.
err(call(F, 'sweep-sbtc-dust', [Cl.principal(admin)], admin), 1014);
err(call(F, 'sweep-stx-dust', [Cl.principal(admin)], admin), 1014);
ok(sim.callPublicFn('mock-ft', 'mint', [u(17), cp(F)], admin));
equal(ok(call(F, 'sweep-sbtc-dust', [Cl.principal(admin)], admin)).value, 17n);
ok(sim.transferSTX(23n, `${admin}.${F}`, admin));
equal(ok(call(F, 'sweep-stx-dust', [Cl.principal(admin)], admin)).value, 23n);
err(call(F, 'update-fees', [u(10000)], admin), 1004);
err(call(F, 'update-admin', [Cl.principal(bob), Cl.bool(true)]), 1001);
err(call(F, 'update-admin', [Cl.principal(admin), Cl.bool(false)], admin), 1001);
ok(call(F, 'update-admin', [Cl.principal(bob), Cl.bool(true)], admin));
truthy(cvToString(read(F, 'is-admin', [Cl.principal(bob)])).includes('true'));
ok(call(F, 'update-admin', [Cl.principal(bob), Cl.bool(false)], admin));
truthy(cvToString(read(F, 'is-admin', [Cl.principal(bob)])).includes('false'));
const signerKey = Cl.buffer(new Uint8Array(33).fill(7));
const signerSig = Cl.buffer(new Uint8Array(65).fill(3));
err(call(F, 'register-self', [cp(F), signerKey, u(0), signerSig]), 1001);
ok(call(F, 'register-self', [cp(F), signerKey, u(0), signerSig], admin));

// Both split routers exercise the dedicated vault paths with matching totals.
for (const [nextCycle, split] of [
  [152, [0, 400000, 300000, 250000]],
  [153, [0, 400000, 300000, 250000]],
]) {
  ok(call('mock-pox', 'stake-test', [cp(F), Cl.principal(alice), u(nextCycle), u(1)]));
  ok(call('mock-pox', 'stake-test', [cp(F), Cl.principal(bob), u(nextCycle), u(3)]));
  ok(call(F, 'claim-rewards', [u(nextCycle)]));
  ok(call(F, 'fund-swap-vault', [u(nextCycle)]));
  if (nextCycle === 152) {
    err(call(F, 'router-swap-split', [u(950000), u(0), u(400000), u(300000), u(250000), update], admin), 16031);
  } else {
    err(call(F, 'router-swap-split-dia', [u(950000), u(400000), u(300000), u(250000)], admin), 16031);
  }
  sim.mineEmptyBurnBlocks(288);
  if (nextCycle === 152) {
    err(call(F, 'router-swap-split', [u(950000), u(0), u(400000), u(300000), u(249999), update], admin), 16040);
    err(call(F, 'router-swap-split', [u(0), u(0), u(0), u(0), u(0), update], admin), 16006);
    err(call(F, 'router-swap-split', [u(960000), u(0), u(400000), u(300000), u(260000), update], admin), 16006);
    err(call(F, 'router-swap-split', [u(1000001), u(0), u(400000), u(300000), u(300001), update], admin), 16039);
    err(call(F, 'router-swap-split', [u(950000), u(split[0]), u(split[1]), u(split[2]), u(split[3]), update]), 1001);
    ok(call(F, 'router-swap-split', [u(950000), u(split[0]), u(split[1]), u(split[2]), u(split[3]), update], admin));
  } else {
    ok(call('mock-dia', 'set-stale', [Cl.bool(true)]));
    truthy(cvToString(read(FV, 'get-no-pyth-price')).includes('(source "native")'));
    err(call(F, 'router-swap-split-dia', [u(950000), u(400000), u(300000), u(249999)], admin), 16040);
    err(call(F, 'router-swap-split-dia', [u(0), u(0), u(0), u(0)], admin), 16006);
    err(call(F, 'router-swap-split-dia', [u(1000001), u(400000), u(300000), u(300001)], admin), 16039);
    err(call(F, 'router-swap-split-dia', [u(950000), u(400000), u(300000), u(250000)]), 1001);
    ok(call(F, 'router-swap-split-dia', [u(950000), u(split[1]), u(split[2]), u(split[3])], admin));
    ok(call('mock-dia', 'set-stale', [Cl.bool(false)]));
  }
  equal(ok(call(F, 'finalize-swap-vault')).value, 3_040_000_000n);
  ok(call(F, 'distribute-rewards-many', [Cl.list([Cl.principal(alice), Cl.principal(bob)]), u(nextCycle)]));
}

// Lazer charges the signer vault as tx-sender: one fee per verify must fit the
// with-stx allowance, and finish preserves the configured reserve.
ok(call('mock-lazer-oracle', 'set-fee', [u(10)]));
ok(call(F, 'set-vault-pyth-fee-budget', [u(10)], admin));
ok(sim.transferSTX(30n, `${admin}.${FV}`, admin));
ok(call('mock-pox', 'stake-test', [cp(F), Cl.principal(alice), u(154), u(1)]));
ok(call('mock-pox', 'stake-test', [cp(F), Cl.principal(bob), u(154), u(3)]));
ok(call(F, 'claim-rewards', [u(154)]));
ok(call(F, 'fund-swap-vault', [u(154)]));
ok(call('mock-lazer-oracle', 'set-fee', [u(11)]));
err(call(FV, 'jing-place', [update]), 0);
ok(call('mock-lazer-oracle', 'set-fee', [u(10)]));
ok(call(FV, 'jing-place', [update]));
sim.mineEmptyBurnBlocks(288);
ok(call(FV, 'jing-reclaim'));
ok(call(FV, 'router-swap', [update]));
equal(ok(call(F, 'finalize-swap-vault')).value, 3_040_000_000n);
equal(stx(`${admin}.${FV}`), 10n);
ok(call(F, 'distribute-rewards-many', [Cl.list([Cl.principal(alice), Cl.principal(bob)]), u(154)]));
equal(read(F, 'get-unswapped-sats').value, 0n);
ok(call(F, 'set-vault-pyth-fee-budget', [u(0)], admin));
ok(call('mock-lazer-oracle', 'set-fee', [u(0)]));

ok(call('mock-dia', 'set-stale', [Cl.bool(true)]));
truthy(cvToString(read(FV, 'get-no-pyth-price')).includes('(source "native")'));
ok(call('mock-native', 'set-failed', [Cl.bool(true)]));
equal(cvToString(read(FV, 'get-no-pyth-price')), '(err u900)');
ok(call('mock-native', 'set-failed', [Cl.bool(false)]));
ok(call('mock-native', 'set-mid', [u(0)]));
equal(cvToString(read(FV, 'get-no-pyth-price')), '(err u16013)');
ok(call('mock-native', 'set-mid', [u(32000000000000)]));
ok(call('mock-dia', 'set-skew', [u(0)]));
truthy(cvToString(read(FV, 'get-no-pyth-price')).includes('(source "native")'));
ok(call('mock-dia', 'set-stale', [Cl.bool(false)]));
ok(call('mock-dia', 'set-skew', [u(10000)]));

// Vault handover requires an idle vault and its full 4032-block notice.
equal(cvToString(read(F, 'get-swap-vault')), cvToString(cp(FV)));
err(call(F, 'propose-swap-vault', [cp(FV)], admin), 1055);
err(call(F, 'propose-swap-vault', [cp(FVN)]), 1001);
ok(call(F, 'propose-swap-vault', [cp(FVN)], admin));
truthy(cvToString(read(F, 'get-pending-swap-vault')).includes(`(vault (some ${admin}.fastpool-swap-vault-next))`));
err(call(F, 'confirm-swap-vault', [cp(FV), cp(FV)], admin), 1055);
ok(call(F, 'cancel-swap-vault-proposal', [], admin));
truthy(cvToString(read(F, 'get-pending-swap-vault')).includes('(vault none)'));
err(call(F, 'confirm-swap-vault', [cp(FV), cp(FVN)], admin), 1054);
ok(call(F, 'propose-swap-vault', [cp(FVN)], admin));
err(call(F, 'confirm-swap-vault', [cp(FV), cp(FVN)], admin), 1057);
sim.mineEmptyBurnBlocks(4032);
ok(call('mock-pox', 'stake-test', [cp(F), Cl.principal(alice), u(175), u(1)]));
ok(call('mock-pox', 'stake-test', [cp(F), Cl.principal(bob), u(175), u(3)]));
ok(call(F, 'claim-rewards', [u(175)]));
ok(call(F, 'fund-swap-vault', [u(175)]));
err(call(F, 'confirm-swap-vault', [cp(FV), cp(FVN)], admin), 1050);
sim.mineEmptyBurnBlocks(433);
ok(call(F, 'recover-swap-vault'));
ok(call(F, 'distribute-rewards-many', [Cl.list([Cl.principal(alice), Cl.principal(bob)]), u(175)]));
ok(call(F, 'confirm-swap-vault', [cp(FV), cp(FVN)], admin));
equal(cvToString(read(F, 'get-swap-vault')), cvToString(cp(FVN)));
err(call(F, 'set-vault-window-blocks', [u(288)], admin), 1055);
ok(sim.callPublicFn(F, 'set-vault-window-blocks', [u(288), cp(FVN)], admin));
console.log(`FastPool: vault handover and active-vault enforcement passed (${checks} assertions)`);
