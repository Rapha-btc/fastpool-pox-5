// Current Jing dependencies, fork only (FastPool vault + signer manager).
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
// The vault binds market v6-5 (LIVE) + router swap-router-sbtc-stx-jing-v6 (NOT on
// mainnet) and implements juice-swap-vault-trait-v3 (NOT on mainnet). core-v6,
// ladder-v1 and trait-v2 are live. appendJingStack deploys trait-v3 (this repo's
// bytes) and router v6 (jing-contracts-v3 bytes, sha-pinned, Clarity 5) as DEP on
// the fork before any vault or pool. Zest pool u3 does not exist on mainnet, so
// router v6 skips Zest: splits pass zest u0 + an empty tick list.
export const MARKET=DEP+'.markets-sbtc-stx-jing-v6-5',CORE=DEP+'.jing-core-v6',LADDER=DEP+'.jing-ladder-v1';
// Market v6-5 operator + core-v6 / ladder-v1 owner since 2026-10-24 (multisig): owner-only
// fork steps (pause, ladder reservation) are sent as this principal.
export const JING_OWNER='SM1N7VX04M1TT23KD7YHVD6H6413QV2ZNJFTWVF9P';
export const ROUTER_V6='swap-router-sbtc-stx-jing-v6',ROUTER=DEP+'.'+ROUTER_V6;
export const ROUTER_V5_5=DEP+'.swap-router-sbtc-stx-jing-v5-5'; // live, bound by Juice autoswap v1
export const TRAIT_V3='juice-swap-vault-trait-v3',TRAIT_V3_ID=DEP+'.'+TRAIT_V3;
export const SBTC='SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token',WSTX='SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2';
// Real sBTC holder for fork-only funding (SM2RRFN4... is empty at the tip).
export const SBTC_WHALE=process.env.SBTC_WHALE||'SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2';
// Real unlocked-STX holder for fork-only takers/bids (SP9BP4PN... is empty at the tip).
export const STX_WHALE=process.env.STX_WHALE||'SP1Z92MPDQEWZXW36VX71Q25HKF5K2EPCJ304F275';
export const {fetchLazerUpdateAny,lazerFeedTimes}=await import(resolve(JING_SRC,'../simulations/_lazer.js'));
// FORK_BLOCK pins a whole rerun set to one height (default: each builder's own tip).
export const FORK_BLOCK=process.env.FORK_BLOCK?Number(process.env.FORK_BLOCK):undefined;
// jing-contracts-v3 4593bbb (Zest pool u3: x = wstx, y = sBTC); ROUTER_SHA=skip disables.
export const ROUTER_V6_SHA=process.env.ROUTER_SHA||'8325e0c5300b3c9b65dc6d89ba70c1f4067add9515640efd2ca325c32b4e7a84';
const sha256=s=>createHash('sha256').update(s).digest('hex');
export function routerV6Source() {
 const file=resolve(JING_SRC,'sbtc-stx/'+ROUTER_V6+'.clar');
 const source=readFileSync(file,'utf8'),hash=sha256(source);
 if(ROUTER_V6_SHA!=='skip'&&hash!==ROUTER_V6_SHA)throw new Error(`router v6 sha ${hash} != pinned ${ROUTER_V6_SHA} (${file})`);
 return source;
}
export function vaultTraitV3Source() {
 return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),'../contracts/'+TRAIT_V3+'.clar'),'utf8');
}
// Router v6 (block 9525511) and trait-v3 (block 9525513) went LIVE at DEP on
// 2026-11-19, deployed comment-stripped and re-wrapped. When the fork height is at
// or past a contract's publish block, the live contract is used (redeploying would
// be "Duplicate contract") after proving its code equals the repo bytes modulo
// comments and whitespace; below it, the exact repo bytes are deployed as DEP.
const NODE_API=process.env.STACKS_API_URL||'http://77.42.3.101/stacks-api';
const codeTokens=src=>src.replace(/;;[^\n]*/g,' ').replace(/\s+/g,' ').replace(/\( /g,'(').replace(/ \)/g,')').trim();
async function liveContract(name,repoSource) {
 const meta=await fetch(`${NODE_API}/extended/v1/contract/${DEP}.${name}`,{signal:AbortSignal.timeout(20000)});
 if(meta.status===404)return null;
 if(!meta.ok)throw new Error(`${name}: contract lookup HTTP ${meta.status}`);
 const {block_height:height,tx_id:txid,source_code:source}=await meta.json();
 if(codeTokens(source)!==codeTokens(repoSource))throw new Error(`${name}: live code at ${DEP} (tx ${txid}) differs from repo bytes`);
 return {height,txid,sha256:sha256(source)};
}
const TRAIT_V3_SRC=vaultTraitV3Source(),ROUTER_V6_SRC=routerV6Source();
export const LIVE={[TRAIT_V3]:await liveContract(TRAIT_V3,TRAIT_V3_SRC),[ROUTER_V6]:await liveContract(ROUTER_V6,ROUTER_V6_SRC)};
const isLiveAt=(name,height)=>LIVE[name]&&(height===undefined||height>=LIVE[name].height);
// Pushes one {label,kind:'deploy'} plan entry per fork deploy (trait-v3, then router v6).
// forkHeight: the builder's useBlockHeight when FORK_BLOCK is unset (undefined = tip).
export function appendJingStack(builder,plan,sourceHashes={},forkHeight) {
 if(FORK_BLOCK!==undefined)builder.useBlockHeight(FORK_BLOCK);
 const height=FORK_BLOCK??forkHeight;
 sourceHashes['juice-swap-vault-trait-v2']=sha256(vaultTraitV2Source()); // live, not redeployed
 builder.withSender(DEP);
 for(const [name,source,version] of [[TRAIT_V3,TRAIT_V3_SRC,stacks.ClarityVersion.Clarity6],[ROUTER_V6,ROUTER_V6_SRC,stacks.ClarityVersion.Clarity5]]) {
  sourceHashes[name]=sha256(source);
  if(isLiveAt(name,height)){sourceHashes[name+' (live, code-equal)']=LIVE[name].sha256;continue;}
  builder.addContractDeploy({contract_name:name,source_code:source,clarity_version:version});
  plan.push({label:`deploy ${name} (exact repo bytes, Clarity ${version})`,kind:'deploy'});
 }
}

// juice-swap-vault-trait-v2 is LIVE at DEP (block 9219775): hashed for reports only.
const TRAIT_V2='juice-swap-vault-trait-v2';
export function vaultTraitV2Source() {
 const juice=resolve(homedir(),'projects/juicestx/contracts/pox-5/'+TRAIT_V2+'.clar');
 const mirror=resolve(dirname(fileURLToPath(import.meta.url)),'../contracts/'+TRAIT_V2+'.clar');
 const local=readFileSync(mirror,'utf8');
 if(existsSync(juice)&&readFileSync(juice,'utf8')!==local)throw new Error(`${TRAIT_V2}: ${juice} differs from ${mirror}`);
 return local;
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
