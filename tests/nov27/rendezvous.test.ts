import {it,expect} from 'vitest';
import fc from 'fast-check';
import {getContractFunction,strategyFor} from '@stacks/rendezvous';
import {boot,Cl,u,ok} from './lab';
const seeds=[20261126,20261127],numRuns=Number(process.env.RV_RUNS??500);
it.each(seeds)('RV dust/close state transitions seed %i',async(seed)=>{
 // Arrange
 const {sim,call,cp,admin,read,fund,balance}=await boot();
 const arb=strategyFor(sim,getContractFunction(sim,'vault','set-slippage-bps'));
 // Act + Assert: each generated sequence checks the dust boundary and cleans up through public exits.
 fc.assert(fc.property(arb,([raw])=>{
  const amount=Number((raw as any).value%145n)+1;
  fund(amount);
  expect(read('vault','is-empty')).toEqual(Cl.bool(amount<=72));
  const close=call('vault','close-batch');
  if(amount<=72)ok(close);
  else {expect(close.result).toEqual(Cl.error(u(16043)));ok(call('token','reset-balance',[Cl.principal(cp('vault')),u(0)]));ok(call('vault','close-batch'));}
  ok(call('vault','finish',[],cp('pool')));
  ok(call('token','reset-balance',[Cl.principal(cp('vault')),u(0)]));
  expect(balance(cp('vault'))).toBe(0n);
 }),{seed,numRuns});
});
it.each(seeds)('RV configuration bounds and rollback seed %i',async(seed)=>{
 // Arrange
 const {sim,call,read,cp,admin}=await boot();
 const authority=cp('pool');
 const arb=strategyFor(sim,getContractFunction(sim,'vault','set-slippage-bps'));
 // Act + Assert
 fc.assert(fc.property(arb,([raw])=>{
  const n=Number((raw as any).value%2001n);
  const before=read('vault','get-config');
  const result=call('vault','set-slippage-bps',[u(n)],authority);
  if(n<=1000){ok(result);expect((read('vault','get-config') as any).value['slippage-bps']).toEqual(u(n));}
  else {expect(result.result).toEqual(Cl.error(u(16033)));expect(read('vault','get-config')).toEqual(before);}
 }),{seed,numRuns});
});
it.each(seeds)('RV sweep authorization and atomic transfers seed %i',async(seed)=>{
 // Arrange
 const {sim,call,read,cp,admin,outsider,recipient,balance}=await boot();
 const arb=strategyFor(sim,getContractFunction(sim,'vault','set-slippage-bps'));
 // Act + Assert
 fc.assert(fc.property(arb,([raw])=>{
  const n=Number((raw as any).value%10000n)+1,mode=Number((raw as any).value%4n);
  ok(call('token','reset-balance',[Cl.principal(cp('vault')),u(n)]));
  ok(call('pool','set-vaults',[Cl.principal(mode===1?cp('vault'):admin),mode===2?Cl.some(Cl.principal(cp('vault'))):Cl.none()]));
  const before=balance(recipient);
  const result=call('vault','sweep',[Cl.principal(recipient)],mode===0?outsider:admin);
  if(mode===3){ok(result);expect(balance(cp('vault'))).toBe(0n);expect(balance(recipient)-before).toBe(BigInt(n));}
  else {expect(result.result).toEqual(Cl.error(u(mode===0?16000:16049)));expect(balance(cp('vault'))).toBe(BigInt(n));expect(balance(recipient)).toBe(before);}
 }),{seed,numRuns});
});
