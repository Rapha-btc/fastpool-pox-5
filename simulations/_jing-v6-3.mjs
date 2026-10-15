// Current Jing dependencies, fork only. Shared setup for the three vault repos.
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
export const JING_SRC=process.env.JING_SRC||resolve(homedir(),'projects/jing-contracts-v3/contracts');
const require=createRequire(resolve(JING_SRC,'../package.json'));
export const stacks=require('@stacks/transactions'),stxer=require('stxer');
export const DEP='SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
// The vault binds market v6-4 + router v5-5, both LIVE on mainnet since 2026-10-15
// (core-v6, ladder-v1 and trait-v2 too), so the forks use the deployed contracts.
export const MARKET=DEP+'.markets-sbtc-stx-jing-v6-4',CORE=DEP+'.jing-core-v6',LADDER=DEP+'.jing-ladder-v1',ROUTER=DEP+'.swap-router-sbtc-stx-jing-v5-5';
export const SBTC='SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token',WSTX='SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2';
export const {fetchLazerUpdateAny,lazerFeedTimes}=await import(resolve(JING_SRC,'../simulations/_lazer.js'));
// FORK_BLOCK pins a whole rerun set to one height (default: each builder's own tip).
export const FORK_BLOCK=process.env.FORK_BLOCK?Number(process.env.FORK_BLOCK):undefined;
export function appendJingStack(builder,plan,sourceHashes={}) {
 // Live stack: nothing to deploy or initialize (redeploying would be "Duplicate contract").
 if(FORK_BLOCK!==undefined)builder.useBlockHeight(FORK_BLOCK);
 appendVaultTraitV2(builder,plan,sourceHashes);
}

// The vaults implement juice-swap-vault-trait-v2 (v1 + set-pyth-fee-budget), not yet
// on mainnet: deploy it under DEP before any vault or pool. Source of truth is the
// Juice repo; this repo's contracts/ mirror is used until that file exists.
const TRAIT_V2='juice-swap-vault-trait-v2';
export function vaultTraitV2Source() {
 const juice=resolve(homedir(),'projects/juicestx/contracts/pox-5/'+TRAIT_V2+'.clar');
 const mirror=resolve(dirname(fileURLToPath(import.meta.url)),'../contracts/'+TRAIT_V2+'.clar');
 const local=readFileSync(mirror,'utf8');
 if(existsSync(juice)&&readFileSync(juice,'utf8')!==local)throw new Error(`${TRAIT_V2}: ${juice} differs from ${mirror}`);
 return local;
}
export function appendVaultTraitV2(builder,plan,sourceHashes={}) {
 // juice-swap-vault-trait-v2 is LIVE at DEP (block 9219775): hash the mirror for the report, do not redeploy.
 sourceHashes[TRAIT_V2]=createHash('sha256').update(vaultTraitV2Source()).digest('hex');
}

export async function freshProofAfter(stamp) {
 if(!Number.isFinite(stamp))throw new Error('Fork block timestamp missing');
 for(let i=0;i<30;i++) {
  const p=await fetchLazerUpdateAny();
  if((await lazerFeedTimes(p.hex)).at>stamp)return p;
  await new Promise(r=>setTimeout(r,2000));
 }
 throw new Error('No signed price newer than '+stamp);
}
