import {describe, it, expect} from 'vitest';
import {boot, Cl, u, ok} from './lab';

describe('fastpool-swap-vault — Nov 26/27 regressions', () => {
 it.each([3, 36, 71, 72, 73])('dust boundary: %i sats', async (amount) => {
  // Arrange
  const {fund, read, call, balance, cp, sim} = await boot();
  fund(amount);
  const clockBefore = sim.getDataVar(cp('vault'),'batch-start');
  // Act
  const empty = read('vault','is-empty');
  const close = call('vault','close-batch');
  // Assert
  expect(empty).toEqual(Cl.bool(amount <= 72));
  if (amount <= 72) {
   ok(close);
   expect(sim.getDataVar(cp('vault'),'batch-start')).toEqual(Cl.none());
  } else {
   expect(close.result).toEqual(Cl.error(u(16043)));
   expect(sim.getDataVar(cp('vault'),'batch-start')).toEqual(clockBefore);
  }
  expect(balance(cp('vault'))).toBe(BigInt(amount));
 });
 it.each([3,72,73])('close-batch reclaims %i sats of resting dust only within the total dust line', async (amount) => {
  // Arrange
  const {fund, call, read, cp, balance} = await boot();
  fund(amount);
  ok(call('vault','jing-place',[Cl.bufferFromHex('')]));
  expect(balance(cp('vault'))).toBe(0n);
  // Act
  const result = call('vault','close-batch');
  // Assert
  if (amount <= 72) {ok(result); expect(read('vault','is-empty')).toEqual(Cl.bool(true)); expect(balance(cp('vault'))).toBe(BigInt(amount));}
  else {expect(result.result).toEqual(Cl.error(u(16043))); expect(balance(cp('vault'))).toBe(0n);}
 });
 it.each([52,1000,1500])('router-swap permits a refund/re-pull of 2 × min-x (%i)', async (minX) => {
  // Arrange
  const {fund, elapsed, call, cp, balance} = await boot();
  fund(10000); elapsed();
  ok(call('market','set-min-x',[u(minX)]));
  ok(call('router','configure',[u(2*minX),Cl.bool(false)]));
  // Act
  const result = call('vault','router-swap',[Cl.bufferFromHex('')]);
  // Assert
  ok(result);
  expect(balance(cp('vault'))).toBe(0n);
  expect(balance(cp('router'))).toBe(10000n);
 });
 it('router-swap refuses one sat beyond amount + 2 × min-x and rolls back', async () => {
  // Arrange
  const {fund, elapsed, call, cp, balance, sim} = await boot();
  fund(10000); elapsed();
  ok(call('router','configure',[u(2001),Cl.bool(false)]));
  const tick = sim.getDataVar(cp('vault'),'last-router-swap');
  // Act
  const result = call('vault','router-swap',[Cl.bufferFromHex('')]);
  // Assert
  expect(result.result.type).toBe('err');
  expect(balance(cp('vault'))).toBe(10000n);
  expect(balance(cp('router'))).toBe(0n);
  expect(sim.getDataVar(cp('vault'),'last-router-swap')).toEqual(tick);
 });
 it.each([2000,2001])('router-swap-split allowance boundary: refund/re-pull %i', async (extra) => {
  // Arrange
  const {fund, elapsed, call, authority, balance, cp} = await boot();
  fund(10000); elapsed();
  ok(call('router','configure',[u(extra),Cl.bool(false)]));
  // Act
  const result = call('vault','router-swap-split',[u(10000),u(10000),u(0),Cl.list([]),u(0),u(0),u(0),Cl.bufferFromHex(''),Cl.some(u(1))],authority);
  // Assert
  if (extra === 2000) {ok(result); expect(balance(cp('vault'))).toBe(0n);}
  else {expect(result.result.type).toBe('err'); expect(balance(cp('vault'))).toBe(10000n);}
 });
 it.each(['router-swap-split','router-swap-split-dia'])('%s rejects nothing sold with u16050 without consuming cooldown', async (fn) => {
  // Arrange
  const {fund, elapsed, call, authority, cp, balance, sim} = await boot();
  fund(10000); elapsed();
  ok(call('router','configure',[u(0),Cl.bool(true)]));
  const tick = sim.getDataVar(cp('vault'),'last-router-swap');
  const args = fn.endsWith('-dia')
   ? [u(10000),u(10000),Cl.list([]),u(0),u(0),u(0),Cl.none()]
   : [u(10000),u(10000),u(0),Cl.list([]),u(0),u(0),u(0),Cl.bufferFromHex(''),Cl.none()];
  // Act
  const result = call('vault',fn,args,authority);
  // Assert
  expect(result.result).toEqual(Cl.error(u(16050)));
  expect(sim.getDataVar(cp('vault'),'last-router-swap')).toEqual(tick);
  expect(balance(cp('vault'))).toBe(10000n);
  ok(call('router','configure',[u(0),Cl.bool(false)]));
  ok(call('vault',fn,args,authority));
 });
 it.each(['outsider','active','pending','retired'])('sweep guard: %s', async (state) => {
  // Arrange
  const {sim, call, admin, outsider, recipient, cp, balance} = await boot();
  ok(call('token','mint',[u(72),Cl.principal(cp('vault'))]));
  ok(sim.transferSTX(123n,cp('vault'),admin));
  ok(call('pool','set-vaults',[Cl.principal(state==='active'?cp('vault'):admin),state==='pending'?Cl.some(Cl.principal(cp('vault'))):Cl.none()]));
  const stxBefore = sim.getAssetsMap().get('STX')!.get(recipient)!;
  // Act
  const result = call('vault','sweep',[Cl.principal(recipient)],state==='outsider'?outsider:admin);
  // Assert
  if (state==='retired') {
   ok(result); expect(balance(recipient)).toBe(72n); expect(balance(cp('vault'))).toBe(0n);
   expect(sim.getAssetsMap().get('STX')!.get(recipient)!-stxBefore).toBe(123n);
   ok(call('vault','sweep',[Cl.principal(recipient)]));
  } else {
   expect(result.result).toEqual(Cl.error(u(state==='outsider'?16000:16049)));
   expect(balance(cp('vault'))).toBe(72n);
   expect(sim.getAssetsMap().get('STX')!.get(cp('vault'))).toBe(123n);
  }
 });
 it('sweep reads the current pool admin', async () => {
  // Arrange
  const {call, outsider, recipient} = await boot();
  ok(call('pool','set-admin',[Cl.principal(outsider)]));
  // Act
  const oldAdmin = call('vault','sweep',[Cl.principal(recipient)]);
  const newAdmin = call('vault','sweep',[Cl.principal(recipient)],outsider);
  // Assert
  expect(oldAdmin.result).toEqual(Cl.error(u(16000))); ok(newAdmin);
 });
});
