// Bounty mwofjt42 fixes #38 and #27 on fastpool-swap-vault, A/B on one mainnet fork.
//   pre = git HEAD source (before the fixes), fix = working tree.
// Both copies are the production source with only POOL repointed at the driver
// (DEP), so the POOL-gated entries (fund, splits, finish, setters) are callable.
//
// #38  DUST_SATS (u2) vs ROUTER_SLACK_SATS (u72): fund 20,050 sats with a 20,000
//      chunk cap, sell one chunk, and the 50-sat rest can't be sold (u16047).
//      pre: not empty, close-batch u16043, finish u16032. fix: empty, closes, finishes.
// #27  admin router-swap-split, jing leg + fallback DLMM: the market refunds the
//      unfilled rest + unused rebate and the router re-sells it from the vault, so
//      the vault's gross sBTC outflow is amount + refund. pre allows amount + min-x
//      (1000) and aborts (err u0, the with-ft allowance) once refund > 1000; fix
//      allows router-swap's headroom and sells.
//      The live book has no bid in range for a new taker, so a whale STX bid is
//      added (fork only) and settled; the jing size is found in two probe runs.
//
// Modes:
//   node simulations/fixes-38-27-stxer.mjs cap            capacity after the bid
//   node simulations/fixes-38-27-stxer.mjs swap <net>     whale taker swap, shows rem/left
//   node simulations/fixes-38-27-stxer.mjs full <net>     the A/B proof
// Env: STACKS_API_URL (default box), FORK_BLOCK, BID_USTX, PROOF_FILE (reuse one update).
import {appendJingStack,freshProofAfter,stacks,stxer,DEP,MARKET,SBTC,WSTX,SBTC_WHALE,STX_WHALE} from './_jing-v6-3.mjs';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {execSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const {Cl,ClarityVersion,deserializeCV,cvToString}=stacks,{SimulationBuilder,getSimulationResult}=stxer;
const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,'..');
const NODE=process.env.STACKS_API_URL||'http://77.42.3.101/stacks-api',API=process.env.STXER_API_URL||'https://api.stxer.xyz';
const [mode='full',netArg]=process.argv.slice(2);
const BID=BigInt(process.env.BID_USTX||'2000000000'); // 2,000 STX
const ROUTER_V61=resolve(process.env.JING_REPO||resolve(repo,'../jing-contracts-v3'),'contracts/sbtc-stx/swap-router-sbtc-stx-jing-v6-1.clar');

// one fork height + one signed update across the probe and proof runs
const PROOF_FILE=process.env.PROOF_FILE||resolve(here,'results/fixes-38-27/proof.json');
let tipHeight,proof;
if(existsSync(PROOF_FILE)&&mode!=='cap'){({tipHeight,proof}=JSON.parse(readFileSync(PROOF_FILE,'utf8')));}
else{
 const tip=(await (await fetch(`${NODE}/extended/v1/block?limit=1`,{signal:AbortSignal.timeout(20000)})).json()).results[0];
 tipHeight=tip.height;const p=await freshProofAfter(tip.block_time);
 proof={hex:p.hex,px:String(p.px),py:String(p.py),ts:p.ts};
 mkdirSync(dirname(PROOF_FILE),{recursive:true});writeFileSync(PROOF_FILE,JSON.stringify({tipHeight,proof},null,1));
}
const update=Cl.buffer(Buffer.from(proof.hex.replace(/^0x/,''),'hex'));
const mid=BigInt(proof.px)*100000000n/BigInt(proof.py); // market mid units (matches refresh-mid)

const POOL_LINE='(define-constant POOL .signer-manager-vault-stx-rewards)';
const sources={
 pre:execSync('git show HEAD:contracts/fastpool-swap-vault.clar',{cwd:repo,encoding:'utf8'}),
 fix:readFileSync(resolve(repo,'contracts/fastpool-swap-vault.clar'),'utf8'),
};
const testSource=s=>{if(!s.includes(POOL_LINE))throw Error('POOL constant not found');return s.replace(POOL_LINE,`(define-constant POOL '${DEP})`);};

const builder=SimulationBuilder.new({stacksNodeAPI:NODE,apiEndpoint:API,skipTracing:!process.env.STXER_TRACE}).useBlockHeight(tipHeight).withSender(DEP);
const plan=[];
appendJingStack(builder,plan,{},tipHeight);
const deploy=(name,src,ver=ClarityVersion.Clarity6)=>{builder.addContractDeploy({contract_name:name,source_code:src,clarity_version:ver});plan.push({label:`deploy ${name}`,kind:'deploy'});};
const call=(label,id,fn,args,want,sender=DEP)=>{builder.withSender(sender).addContractCall({contract_id:id,function_name:fn,function_args:args,sender});plan.push({label,kind:'tx',want});};
const ev=(label,id,code,want)=>{builder.addEvalCode(id,code);plan.push({label,kind:'eval',want});};
const advance=n=>{builder.addAdvanceBlocks({bitcoin_blocks:n,stacks_blocks_per_bitcoin:1,bitcoin_interval_secs:1});plan.push({label:`advance ${n} burn block`,kind:'advance'});};
const ok=v=>v.startsWith('(ok'),sbtcT=Cl.contractPrincipal(...SBTC.split('.')),wstxT=Cl.contractPrincipal(...WSTX.split('.'));
const bal=id=>`(unwrap-panic (contract-call? '${SBTC} get-balance '${id}))`;

deploy('swap-router-sbtc-stx-jing-v6-1',readFileSync(ROUTER_V61,'utf8'),ClarityVersion.Clarity5);
// fork-only STX bid so a new taker has Jing depth in range
call(`fixture: whale STX bid ${BID} uSTX at mid + 5%`,MARKET,'deposit-token-y',[Cl.uint(BID),Cl.uint(mid*105n/100n),Cl.none(),wstxT,Cl.stringAscii('wstx')],ok,STX_WHALE);
call('keeper settles the bid',MARKET,'settle-token-y-deposit',[Cl.principal(STX_WHALE),update,wstxT,Cl.stringAscii('wstx')],v=>ok(v)||v.includes('u1'),DEP); // ok, or already resting
const capCode=who=>`(let ((m (unwrap-panic (refresh-mid ${'0x'+proof.hex.replace(/^0x/,'')})))) { mid: m, cap: (get-taker-capacity m (/ (* m u9900) u10000) true '${who} none) })`;

if(mode==='cap'){
 ev('mid + taker capacity at the vault limit (mid - 100 bps)',MARKET,capCode(`${DEP}.t27-fix`),()=>true);
}else if(mode==='swap'){
 const net=BigInt(netArg);const gross=(((net+1n)*10020n)-1n)/10000n;
 call(`whale taker swap gross ${gross} (net ${net}) at limit mid-1%: rem/left`,MARKET,'swap',[Cl.uint(gross),Cl.uint(mid*9900n/10000n),update,sbtcT,Cl.stringAscii('sbtc-token'),wstxT,Cl.stringAscii('wstx'),Cl.bool(true)],()=>true,SBTC_WHALE);
}else if(mode==='mia'){
 // CityCoins ccd016 A/B: pre = citycoins-protocol git HEAD, fix = working tree. Test
 // copies keep production code except the DAO gate (opened to the driver) and
 // bind the repo's ccd015 book, deployed as DEP. A batch is a real sBTC transfer
 // plus an aged clock (no treasury on the fork), as in dust-vaults-stxer.mjs.
 const CC=resolve(repo,'../citycoins-protocol'),F='contracts/extensions/ccd016-swap-vault-mia-v2.clar';
 const miaSrc={pre:execSync(`git show HEAD:${F}`,{cwd:CC,encoding:'utf8'}),fix:readFileSync(resolve(CC,F),'utf8')};
 const openGate=s=>{const a=s.indexOf('(define-public (is-dao-or-extension)'),b=s.indexOf('(define-public (callback',a);if(a<0||b<0)throw Error('DAO gate not found');return s.slice(0,a)+`(define-public (is-dao-or-extension) (ok (asserts! (is-eq tx-sender '${DEP}) (err u16000))))\n\n`+s.slice(b);};
 deploy('ccd015-redemption-book-mia-stx',readFileSync(resolve(CC,'contracts/extensions/ccd015-redemption-book-mia-stx.clar'),'utf8'));
 const net=BigInt(netArg);const gross=(((net+1n)*10020n)-1n)/10000n;
 const open=(k,id,sats)=>{
  call(`${k}: window u0`,id,'set-window-blocks',[Cl.uint(0)],'(ok true)');
  call(`${k}: real sBTC into the vault (${sats})`,SBTC,'transfer',[Cl.uint(sats),Cl.principal(SBTC_WHALE),Cl.principal(id),Cl.none()],'(ok true)',SBTC_WHALE);
  ev(`${k}: fixture: batch clock opened one block ago`,id,'(begin (var-set batch-start (some (- burn-block-height u1))) true)','true');
 };
 for(const k of ['pre','fix'])deploy(`m27-${k}`,openGate(miaSrc[k]));
 for(const k of ['pre','fix'])deploy(`m38-${k}`,openGate(miaSrc[k]));
 for(const k of ['pre','fix'])open(`MIA #27 ${k}`,`${DEP}.m27-${k}`,gross);
 const split=[Cl.uint(gross),Cl.uint(gross),Cl.uint(0),Cl.list([]),Cl.uint(0),Cl.uint(0),Cl.uint(0),update,Cl.some(Cl.uint(1))];
 call(`MIA #27 pre: split all-jing ${gross}, fallback DLMM -> allowance abort (err u0)`,`${DEP}.m27-pre`,'router-swap-split',split,'(err u0)');
 ev('MIA #27 pre: sBTC untouched after the abort',`${DEP}.m27-pre`,bal(`${DEP}.m27-pre`),`u${gross}`);
 call('MIA #27 fix: same split on the same book -> ok',`${DEP}.m27-fix`,'router-swap-split',split,v=>ok(v)&&v.includes('(unsold u0)'));
 ev('MIA #27 fix: vault drained',`${DEP}.m27-fix`,bal(`${DEP}.m27-fix`),v=>/^u\d+$/.test(v)&&BigInt(v.slice(1))<=72n);
 for(const k of ['pre','fix']){const id=`${DEP}.m38-${k}`;open(`MIA #38 ${k}`,id,20050);
  call(`MIA #38 ${k}: chunk cap 20000`,id,'set-max-chunk-sats',[Cl.uint(20000)],'(ok true)');
  call(`MIA #38 ${k}: router-swap sells one 20000 chunk`,id,'router-swap',[update],v=>ok(v)&&v.includes('(amount u20000)'),STX_WHALE);}
 advance(1);
 for(const k of ['pre','fix']){const id=`${DEP}.m38-${k}`,fx=k==='fix';
  ev(`MIA #38 ${k}: leftover is 3..72 sats`,id,bal(id),v=>/^u\d+$/.test(v)&&BigInt(v.slice(1))>=3n&&BigInt(v.slice(1))<=72n);
  if(!fx)call('MIA #38 pre: leftover cannot be sold (u16047)',id,'router-swap',[update],'(err u16047)',STX_WHALE);
  ev(`MIA #38 ${k}: is-empty ${fx}`,id,'(is-empty)',String(fx));
  // fix: the chunk sale's close-if-empty already cleared the clock (50 <= slack): u16032
  call(`MIA #38 ${k}: close-batch ${fx?'u16032 (already closed by the sale)':'u16043 (not empty)'}`,id,'close-batch',[],fx?'(err u16032)':'(err u16043)',STX_WHALE);
  ev(`MIA #38 ${k}: batch clock ${fx?'cleared':'still set'}`,id,'(var-get batch-start)',v=>fx?v==='none':v.startsWith('(some'));
 }
}else if(mode==='rswap'){
 // permissionless router-swap (smart swap, Jing first) under the fix's new 2 x min-x allowance
 const net=BigInt(netArg);const gross=(((net+1n)*10020n)-1n)/10000n;
 deploy('trs-fix',testSource(sources.fix));const id=`${DEP}.trs-fix`;
 call('rswap fix: window u0',id,'set-window-blocks',[Cl.uint(0)],'(ok true)');
 call('rswap fix: real sBTC to driver',SBTC,'transfer',[Cl.uint(gross),Cl.principal(SBTC_WHALE),Cl.principal(DEP),Cl.none()],'(ok true)',SBTC_WHALE);
 call(`rswap fix: fund ${gross}`,id,'fund',[Cl.uint(gross)],`(ok u${gross})`);
 call(`rswap fix: router-swap ${gross} (smart swap, Jing leg first) -> ok`,id,'router-swap',[update],ok,STX_WHALE);
 ev('rswap fix: what is left in the vault',id,bal(id),v=>/^u\d+$/.test(v));
 ev('rswap fix: bid left resting (STX not taken by Jing)',MARKET,`(get-token-y-deposit (get-current-cycle) '${STX_WHALE})`,()=>true);
}else{
 const net=BigInt(netArg);const gross=(((net+1n)*10020n)-1n)/10000n;
 for(const k of ['pre','fix'])deploy(`t27-${k}`,testSource(sources[k]));
 for(const k of ['pre','fix'])deploy(`t38-${k}`,testSource(sources[k]));
 // ---- #27 ----
 for(const k of ['pre','fix']){
  const id=`${DEP}.t27-${k}`;
  call(`#27 ${k}: window u0`,id,'set-window-blocks',[Cl.uint(0)],'(ok true)');
  call(`#27 ${k}: real sBTC to driver`,SBTC,'transfer',[Cl.uint(gross),Cl.principal(SBTC_WHALE),Cl.principal(DEP),Cl.none()],'(ok true)',SBTC_WHALE);
  call(`#27 ${k}: fund ${gross}`,id,'fund',[Cl.uint(gross)],`(ok u${gross})`);
 }
 ev('#27 capacity seen by the vault taker',MARKET,capCode(`${DEP}.t27-pre`),()=>true);
 const split=[Cl.uint(gross),Cl.uint(gross),Cl.uint(0),Cl.list([]),Cl.uint(0),Cl.uint(0),Cl.uint(0),update,Cl.some(Cl.uint(1))];
 call(`#27 pre: split all-jing ${gross}, fallback DLMM -> allowance abort (err u0)`,`${DEP}.t27-pre`,'router-swap-split',split,'(err u0)');
 ev('#27 pre: sBTC untouched after the abort',`${DEP}.t27-pre`,bal(`${DEP}.t27-pre`),`u${gross}`);
 call(`#27 fix: same split on the same book -> ok, refund re-sold on DLMM`,`${DEP}.t27-fix`,'router-swap-split',split,v=>ok(v)&&v.includes('(unsold u0)'));
 ev('#27 fix: vault drained',`${DEP}.t27-fix`,bal(`${DEP}.t27-fix`),v=>/^u\d+$/.test(v)&&BigInt(v.slice(1))<=72n);
 // ---- #38 ----
 for(const k of ['pre','fix']){
  const id=`${DEP}.t38-${k}`;
  call(`#38 ${k}: window u0`,id,'set-window-blocks',[Cl.uint(0)],'(ok true)');
  call(`#38 ${k}: chunk cap 20000`,id,'set-max-chunk-sats',[Cl.uint(20000)],'(ok true)');
  call(`#38 ${k}: real sBTC to driver`,SBTC,'transfer',[Cl.uint(20050),Cl.principal(SBTC_WHALE),Cl.principal(DEP),Cl.none()],'(ok true)',SBTC_WHALE);
  call(`#38 ${k}: fund 20050`,id,'fund',[Cl.uint(20050)],'(ok u20050)');
  call(`#38 ${k}: router-swap sells one 20000 chunk`,id,'router-swap',[update],v=>ok(v)&&v.includes('(amount u20000)'));
 }
 advance(1);
 for(const k of ['pre','fix']){
  const id=`${DEP}.t38-${k}`,fx=k==='fix';
  ev(`#38 ${k}: leftover is 3..72 sats`,id,bal(id),v=>/^u\d+$/.test(v)&&BigInt(v.slice(1))>=3n&&BigInt(v.slice(1))<=72n);
  // pre: the 50 sats keep the batch open and can't be sold. fix: the chunk sale's own
  // close-if-empty already closed the batch (50 <= ROUTER_SLACK_SATS), so there is
  // nothing to sell (u16031, no open batch) and close-batch has no clock left (u16032).
  ev(`#38 ${k}: after the chunk the batch is ${fx?'already closed (ready-to-finish)':'still open'}`,id,'(get-clock)',v=>fx?v.includes('(batch-start none)')&&v.includes('(ready-to-finish true)'):v.includes('(batch-start (some')&&v.includes('(ready-to-finish false)'));
  call(`#38 ${k}: router-swap on the leftover ${fx?'u16031 (batch closed)':'u16047 (unsellable)'}`,id,'router-swap',[update],fx?'(err u16031)':'(err u16047)');
  ev(`#38 ${k}: is-empty ${fx}`,id,'(is-empty)',String(fx));
  call(`#38 ${k}: close-batch ${fx?'u16032 (already closed)':'u16043 (not empty)'}`,id,'close-batch',[],fx?'(err u16032)':'(err u16043)');
  call(`#38 ${k}: finish ${fx?'ok':'u16032'}`,id,'finish',[],fx?ok:'(err u16032)');
  ev(`#38 ${k}: batch clock`,id,'(get-clock)',v=>fx?v.includes('(batch-start none)')&&v.includes('(ready-to-finish false)'):v.includes('(batch-start (some'));
 }
}

console.log(`${mode}: ${plan.length} steps at block ${tipHeight}`);
const id=await builder.run();const url=`https://stxer.xyz/simulations/mainnet/${id}`;console.log('View:',url);
const result=await getSimulationResult(id,{stxerApi:API});
const checks=plan.map((p,i)=>{
 const step=result.steps[i]?.Result;let actual;
 if(p.kind==='advance')actual=step?.AdvanceBlocks?.Ok?'ok':`ENGINE ${JSON.stringify(step)}`;
 else if(p.kind==='eval')actual=step?.Eval?.Ok!==undefined?cvToString(deserializeCV(step.Eval.Ok)):`ENGINE ${JSON.stringify(step)}`;
 else actual=step?.Transaction?.Ok&&!step.Transaction.Ok.vm_error?cvToString(deserializeCV(step.Transaction.Ok.result)):`ENGINE ${JSON.stringify(step).slice(0,300)}`;
 const passed=p.kind==='advance'?actual==='ok':p.kind==='deploy'?actual.startsWith('(ok'):typeof p.want==='function'?p.want(actual):actual===p.want;
 console.log(`${passed?'PASS':'FAIL'} ${p.label}: ${actual.slice(0,400)}`);return {label:p.label,passed,actual};
});
const out=resolve(here,'results/fixes-38-27');mkdirSync(out,{recursive:true});
writeFileSync(resolve(out,`${mode}.json`),JSON.stringify({id,url,mode,net:netArg??null,forkBlock:tipHeight,proofTs:proof.ts,bidUstx:String(BID),checks},null,2));
console.log(`${checks.filter(c=>c.passed).length}/${checks.length} passed`);
if(mode==='full'&&checks.some(c=>!c.passed))process.exitCode=1;
