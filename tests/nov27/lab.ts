import {track} from './coverage';
import {initSimnet} from '@stacks/clarinet-sdk';
import {Cl, type ClarityValue} from '@stacks/transactions';
import {expect} from 'vitest';
export {Cl};
export const u = Cl.uint;
export const ok = (r: any) => {expect(r.result.type, Cl.prettyPrint(r.result)).toBe('ok'); return r.result.value;};
export async function boot() {
 const sim = await initSimnet('tests/nov27/.build/Clarinet.toml', true, {trackCoverage:true,trackCosts:false});
 track(sim);
 const admin = sim.getAccounts().get('deployer')!;
 const outsider = sim.getAccounts().get('wallet_1')!;
 const recipient = sim.getAccounts().get('wallet_2')!;
 const cp = (name: string) => `${admin}.${name}`;
 const call = (name: string, fn: string, args: ClarityValue[] = [], sender = admin) => sender === cp('pool') ? sim.callPublicFn(cp('pool'), fn, [Cl.principal(cp(name)), ...args], admin) : sim.callPublicFn(cp(name), fn, args, sender);
 const read = (name: string, fn: string, args: ClarityValue[] = []) => sim.callReadOnlyFn(cp(name), fn, args, admin).result;
 const balance = (who: string) => (read('token','get-balance',[Cl.principal(who)]) as any).value.value as bigint;
 const authority = cp('pool');

 const fund = (amount: number) => {
  ok(call('token','mint',[u(amount), Cl.principal(cp('pool'))]));
  ok(call('vault','fund',[u(amount)],cp('pool')));
 };
 const elapsed = () => {sim.mineEmptyBurnBlocks(289);};
 ok(sim.transferSTX(10000000n,cp('router'),admin));
 ok(sim.transferSTX(10000000n,cp('market'),admin));
 return {sim, admin, outsider, recipient, cp, call, read, balance, authority, fund, elapsed};
}
