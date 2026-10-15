// FastPool vault maker-spread on the LIVE Jing book (stxer mainnet fork at the tip).
// Nothing is broadcast. Run: node simulations/maker-spread-live-stxer.mjs
//
// Claim (bounty mv8wal, Cunning Nexus #2, applied to fastpool-swap-vault aa07e9c):
// the vault pegs its maker ask at (some maker-spread-bps), default u1, so
//  - next to the live jing-buy-stx-0 ask pegged at the mid (spread u0), a
//    jing-place settles and RESTS on X at mid + 1 bp (token-x-limit-at = mid*10001/10000);
//  - with a Y bid pegged at the mid resting (the gist condition: an STX holder's
//    spread (some u0) bid, after a taker at limit = mid eats buy-0), a refloor at
//    the var still settles, while the same refloor at spread 0 is refused "crossing";
//  - set-maker-spread-bps is POOL-only, bounded by MAX_MAKER_SPREAD_BPS u50, and
//    reachable through the pool admin wrapper set-vault-maker-spread-bps; get-config shows it.
//
// Real: market v6-4, router v5-5, rungs, ladder, oracle, sBTC, pox-5, trait-v2 (all live,
// not redeployed). Fork-deployed: this repo's fastpool-swap-vault + signer-manager-vault-stx-rewards,
// byte for byte. Fixture (disclosed): earned PoX rewards + 1:3 shares seeded with Eval in pox-5
// (a fork cannot produce a reward claim); claim-rewards and fund-swap-vault then run their real code.
// Keeper = the Jing deployer (settles on mainnet). Prices are real signed Pyth Lazer updates.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const JING = process.env.JING_REPO || resolve(homedir(), 'projects/jing-contracts-v3');
const require = createRequire(resolve(JING, 'package.json'));
const { SimulationBuilder, getSimulationResult, getSimulationTip, submitSimulationSteps, callContract } = require('stxer');
const { Cl, ClarityVersion, deserializeCV, cvToString, getAddressFromPrivateKey } = require('@stacks/transactions');
const { fetchLazerUpdateAny, lazerFeedTimes } = await import(resolve(JING, 'simulations/_lazer.js'));

const NODE = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
const API = process.env.STXER_API_URL || 'https://api.stxer.xyz';
const DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const MK = `${DEP}.markets-sbtc-stx-jing-v6-4`, CORE = `${DEP}.jing-core-v6`;
const B0 = `${DEP}.jing-buy-stx-0`;
const POX = 'SP000000000000000000002Q6VF78.pox-5';
const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
const WSTX = 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2';
const WHALE = 'SM2RRFN4HXTS7EYP8MHHYKSTG118S3HKGDV8AB8M1'; // real sBTC holder
const STX_HOLDER = 'SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51'; // real STX holder (taker + Y bid)
const STRANGER = 'SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
const KEEPER = DEP;
const VAULT = 'fastpool-swap-vault', POOLN = 'signer-manager-vault-stx-rewards';
const VID = `${DEP}.${VAULT}`, PID = `${DEP}.${POOLN}`;
const ALICE = getAddressFromPrivateKey('7'.repeat(64) + '01', 'mainnet');
const BOB = getAddressFromPrivateKey('8'.repeat(64) + '01', 'mainnet');
const FUND = 100_000;
const cp = (s) => s.includes('.') ? Cl.contractPrincipal(...s.split('.')) : Cl.principal(s);
const vaultCV = cp(VID);
const sha = (s) => createHash('sha256').update(s).digest('hex');

// ---- sources (repo bytes, unchanged) ----
const vaultSrc = readFileSync(resolve(here, `../contracts/${VAULT}.clar`), 'utf8');
const poolSrc = readFileSync(resolve(here, `../contracts/${POOLN}.clar`), 'utf8');
for (const [n, s] of [['vault', vaultSrc], ['pool', poolSrc]]) {
  if (!s.includes('markets-sbtc-stx-jing-v6-4') && n === 'vault') throw new Error('vault does not bind market v6-4');
}
if (!vaultSrc.includes('swap-router-sbtc-stx-jing-v5-5')) throw new Error('vault does not bind router v5-5');
const hashes = { [VAULT]: sha(vaultSrc), [POOLN]: sha(poolSrc) };
console.log(`sources: ${VAULT} ${hashes[VAULT].slice(0, 16)}, ${POOLN} ${hashes[POOLN].slice(0, 16)}`);

// ---- helpers ----
const cv = (hex) => cvToString(deserializeCV(hex));
const decode = (step) => {
  const r = step?.Result ?? step;
  if (r?.Eval) return 'Ok' in r.Eval ? cv(r.Eval.Ok) : `EVAL-ERR ${JSON.stringify(r.Eval.Err).slice(0, 300)}`;
  if (r?.Transaction?.Ok) { const t = r.Transaction.Ok; if (t.vm_error || t.post_condition_aborted) return `ENGINE-ERR ${JSON.stringify(t).slice(0, 300)}`; return cv(t.result); }
  return `ENGINE-ERR ${JSON.stringify(r).slice(0, 300)}`;
};
let sid, n = 0, passed = 0;
const fails = [], log = [];
function check(id, label, actual, want, wantDesc) {
  n++;
  const good = typeof want === 'function' ? !!want(actual) : actual === want;
  if (good) passed++; else fails.push(`${id} ${label}`);
  log.push({ id, label, passed: good, actual: String(actual).slice(0, 600) });
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${id} ${label}\n         expected: ${wantDesc ?? (typeof want === 'function' ? 'predicate' : want)}\n         actual:   ${String(actual).slice(0, 400)}`);
  return good;
}
async function ev(id, label, cid, code, want, wantDesc) {
  const out = await submitSimulationSteps(sid, { steps: [{ Eval: [DEP, '', cid, code] }] });
  const v = decode(out.steps[0]);
  if (want !== undefined) check(id, label, v, want, wantDesc);
  return v;
}
function prints(r, from = CORE) {
  const evs = (r.receipt?.events ?? []).map((e) => typeof e === 'string' ? JSON.parse(e) : e);
  return evs.filter((e) => e.contract_event?.contract_identifier === from).map((e) => cv(e.contract_event.raw_value)).join(' | ');
}
async function tx(id, label, sender, contract, fn, args, want, wantDesc) {
  const r = await callContract(sid, { sender, contract, functionName: fn, functionArgs: args, fee: 0 });
  const v = r.vmError || r.pcAborted ? `ENGINE-ERR ${JSON.stringify({ vm: r.vmError, pc: r.pcAborted }).slice(0, 300)}` : r.result;
  check(id, label, v, want, wantDesc);
  return r;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freshUpdate(notBefore) {
  for (let i = 0; i < 400; i++) {
    const now = Date.now() / 1000;
    if (now < notBefore + 2) { await sleep(Math.min(15_000, (notBefore + 3 - now) * 1000)); continue; }
    const u = await fetchLazerUpdateAny();
    const at = (await lazerFeedTimes(u.hex)).at;
    if (at > notBefore) return { cv: Cl.buffer(Buffer.from(u.hex.replace(/^0x/, ''), 'hex')), at, mid: (u.px * 100_000_000n) / u.py };
    await sleep(2000);
  }
  throw new Error('no Lazer update newer than the fork clock');
}
const has = (...ss) => (v) => ss.every((s) => v.includes(s));
const lacks = (...ss) => (v) => ss.every((s) => !v.includes(s));
const cyc = '(get-current-cycle)';
const xdep = (p) => `(get-token-x-deposit ${cyc} '${p})`;
const onX = (p) => `(is-some (index-of? (get-token-x-depositors ${cyc}) '${p}))`;

// ---- SETUP: one stxer session at the live tip ----
const tipBlock = (await (await fetch(`${NODE}/extended/v1/block?limit=1`, { signal: AbortSignal.timeout(20000) })).json()).results[0];
const rd = async (id, fn) => { const [a, nm] = id.split('.'); const j = await (await fetch(`${NODE}/v2/contracts/call-read/${a}/${nm}/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sender: DEP, arguments: [] }) })).json(); return deserializeCV(j.result); };
const rc = Number((await rd(POX, 'current-pox-reward-cycle')).value) - 1;
let b = SimulationBuilder.new({ stacksNodeAPI: NODE, apiEndpoint: API, skipTracing: !process.env.STXER_TRACE }).useBlockHeight(tipBlock.height).withSender(DEP);
const plan = [];
const add = (id, label, f, want) => { b = f(b); plan.push({ id, label, want }); };
const deploy = (name, src) => (bb) => bb.withSender(DEP).addContractDeploy({ contract_name: name, source_code: src, clarity_version: ClarityVersion.Clarity6 });
const call = (sender, cid, fn, args) => (bb) => bb.withSender(sender).addContractCall({ contract_id: cid, function_name: fn, function_args: args });
const okDeploy = (v) => !v.includes('ERR');
add('S1', `deploy ${VAULT} (repo bytes; market v6-4 + router v5-5 + trait-v2 are live)`, deploy(VAULT, vaultSrc), okDeploy);
add('S2', `deploy ${POOLN} (repo bytes, admin = DEP)`, deploy(POOLN, poolSrc), okDeploy);
add('S3', 'real sBTC holder funds pox-5 with the reward stand-in (fork only)', call(WHALE, SBTC, 'transfer', [Cl.uint(FUND), Cl.principal(WHALE), Cl.principal(POX), Cl.none()]), '(ok true)');
const key = `{ reward-cycle: u${rc}, bond-index: none, signer: '${PID} }`;
add('S4', 'FIXTURE: crystallized PoX rewards + 1:3 shares in pox-5', (bb) => bb.addEvalCode(POX, `(begin
  (map-set signer-shares-staked-for-cycle ${key} u4)
  (map-set signer-pending-staked-ustx-per-cycle { signer: '${PID}, cycle: u${rc} } u4)
  (map-set signer-rewards-per-token-settled-for-cycle ${key} (get-rewards-per-token-for-cycle u${rc} none))
  (map-set signer-unclaimed-rewards-for-cycle ${key} u${FUND})
  (map-set staker-shares-staked-for-cycle { reward-cycle: u${rc}, bond-index: none, signer: '${PID}, staker: '${ALICE} } u1)
  (map-set staker-shares-staked-for-cycle { reward-cycle: u${rc}, bond-index: none, signer: '${PID}, staker: '${BOB} } u3)
  (var-set last-accounted-rewards-only (+ (var-get last-accounted-rewards-only) u${FUND}))
  (try! (contract-call? '${PID} validate-stake! '${ALICE} u${rc} u1 u1 u0 false none))
  (try! (contract-call? '${PID} validate-stake! '${BOB} u${rc} u1 u3 u0 false none))
  (ok true))`), '(ok true)');
add('S5', 'real pool claim-rewards stages the pot', call(STRANGER, PID, 'claim-rewards', [Cl.uint(rc)]), `(ok u${FUND})`);
add('S6', 'real pool fund-swap-vault -> vault.fund (opens the batch clock)', call(STRANGER, PID, 'fund-swap-vault', [Cl.uint(rc), vaultCV]), `(ok u${FUND})`);
sid = await b.run();
const url = `https://stxer.xyz/simulations/mainnet/${sid}`;
console.log(`stxer: ${url}`);
const setup = (await getSimulationResult(sid, { stxerApi: API })).steps.filter((s) => s.Result?.Transaction || s.Result?.Eval);
plan.forEach((s, i) => check(s.id, s.label, decode(setup[i]), s.want, typeof s.want === 'string' ? s.want : 'deployed / ok'));
if (fails.length) { console.log('\nRESULT: FAIL (setup)'); process.exit(1); }

const tip0 = await getSimulationTip(sid);
console.log(`fork: stacks ${tip0.stacks_height} burn ${tip0.burn_height} time ${tip0.block_time}`);
const u1 = await freshUpdate(Number(tip0.block_time));
const mid = u1.mid, ask1 = (mid * 10001n) / 10000n;
console.log(`lazer mid ${mid}, mid + 1 bp ${ask1}`);
await ev('L0', 'fork clock is before the signed update', MK, `(< stacks-block-time u${u1.at})`, 'true');

// ---- C: config + setter auth and bounds (direct and through the pool admin wrapper) ----
await ev('C1', 'get-config: maker-spread-bps defaults to u1, binds market v6-4 + router v5-5', VID, '(get-config)', has('(maker-spread-bps u1)', `(market ${MK})`, `(router ${DEP}.swap-router-sbtc-stx-jing-v5-5)`));
await tx('C2', 'stranger calls vault set-maker-spread-bps directly', STRANGER, VID, 'set-maker-spread-bps', [Cl.uint(0)], '(err u16000)');
await tx('C3', 'pool admin (DEP) calls vault set-maker-spread-bps directly: not the POOL contract', DEP, VID, 'set-maker-spread-bps', [Cl.uint(0)], '(err u16000)');
await tx('C4', 'stranger calls pool wrapper set-vault-maker-spread-bps', STRANGER, PID, 'set-vault-maker-spread-bps', [Cl.uint(5), vaultCV], '(err u1001)');
await tx('C5', 'admin wrapper above MAX_MAKER_SPREAD_BPS (u51)', DEP, PID, 'set-vault-maker-spread-bps', [Cl.uint(51), vaultCV], '(err u16033)');
await ev('C6', 'unchanged after the refusals', VID, '(get maker-spread-bps (get-config))', 'u1');
await tx('C7', 'admin wrapper at the bound (u50)', DEP, PID, 'set-vault-maker-spread-bps', [Cl.uint(50), vaultCV], '(ok true)');
await ev('C8', 'get-config shows u50', VID, '(get maker-spread-bps (get-config))', 'u50');
await tx('C9', 'admin wrapper back to u1', DEP, PID, 'set-vault-maker-spread-bps', [Cl.uint(1), vaultCV], '(ok true)');
await ev('C10', 'get-config shows u1', VID, '(get maker-spread-bps (get-config))', 'u1');

// ---- L: the live book on the fork ----
await ev('L1', 'live: jing-buy-stx-0 rests sBTC on X', MK, xdep(B0), (v) => /^u[1-9]/.test(v), 'u > 0');
await ev('L2', 'live: its X order is pegged at spread (some u0)', MK, `(get-token-x-order '${B0})`, has('(spread-bps (some u0))'));
await ev('L3', 'live: its ask at the update mid = the mid', MK, `(token-x-limit-at '${B0} u${mid})`, `u${mid}`);
await ev('L4', 'live: Y list non-empty (an X deposit goes pending)', MK, `(> (len (get-token-y-depositors ${cyc})) u0)`, 'true');
await ev('L5', 'gate: an ask at mid + 1 bp would not take', MK, `(would-take-as-x u${mid} u${ask1})`, 'false');
await ev('V0', 'vault funded: 100,000 sats, window open', VID, `{ sbtc: (unwrap-panic (contract-call? '${SBTC} get-balance current-contract)), clock: (get-clock) }`, has(`(sbtc u${FUND})`, '(window-open true)'));

// ---- P: jing-place next to the live spread-0 ask ----
let r = await tx('P1', 'stranger jing-place(update)', STRANGER, VID, 'jing-place', [u1.cv], has('(ok', `(amount u${FUND})`));
await ev('P2', 'pending escrow carries spread-bps (some u1) (the var)', MK, `(get-token-x-pending-deposit '${VID})`, has('(some', '(spread-bps (some u1))', `(amount u${FUND})`));
r = await tx('P3', 'keeper settle-token-x-deposit(vault, update)', KEEPER, MK, 'settle-token-x-deposit', [cp(VID), u1.cv, cp(SBTC), Cl.stringAscii('sbtc-token')], `(ok u${FUND})`);
check('P4', 'settled as deposit-x, no pending-refund (not "crossing")', prints(r), (v) => v.includes('"deposit-x"') && lacks('pending-refund', '"crossing"')(v), 'deposit-x, no pending-refund-x');
await ev('P5', 'vault rests on X at spread (some u1)', MK, `{ dep: ${xdep(VID)}, on: ${onX(VID)}, order: (get-token-x-order '${VID}) }`, has(`(dep u${FUND})`, '(on true)', '(spread-bps (some u1))'));
await ev('P6', 'vault ask at the mid = mid * 10001 / 10000 (mid + 1 bp)', MK, `(token-x-limit-at '${VID} u${mid})`, `u${ask1}`);
await ev('P7', 'next to it: buy-0 still rests at the mid', MK, `{ dep: ${xdep(B0)}, px: (token-x-limit-at '${B0} u${mid}) }`, has(`(px u${mid})`) );

// ---- G: the gist condition, a Y bid pegged at the mid resting ----
const b0dep = BigInt((await ev('G0', 'buy-0 X depth before the taker', MK, xdep(B0), (v) => /^u\d+$/.test(v), 'uint')).slice(1));
// a swap must fill to under min-token-y (1 STX) or it reverts u1017 ERR_PARTIAL_FILL: buy-0's notional at the mid + 0.5 STX
const eat = (b0dep * mid) / 10_000_000_000n + 500_000n;
r = await tx('G1', `real STX holder swaps ${eat} uSTX for sBTC at limit = mid (eats buy-0 only)`, STX_HOLDER, MK, 'swap', [Cl.uint(eat), Cl.uint(mid), u1.cv, cp(SBTC), Cl.stringAscii('sbtc-token'), cp(WSTX), Cl.stringAscii('wstx'), Cl.bool(false)], has('(ok'));
await ev('G2', 'buy-0 X depth gone', MK, xdep(B0), 'u0');
await ev('G3', 'the vault was not touched by a limit-at-mid taker', MK, xdep(VID), `u${FUND}`);
const bid = 50_000_000;
await tx('G4', 'real STX holder deposit-token-y 50 STX pegged at the mid (some u0), cap mid + 5%', STX_HOLDER, MK, 'deposit-token-y', [Cl.uint(bid), Cl.uint((mid * 105n) / 100n), Cl.some(Cl.uint(0)), cp(WSTX), Cl.stringAscii('wstx')], `(ok u${bid})`);
const pendY = await ev('G5', 'Y deposit is pending (X list non-empty)', MK, `(get-token-y-pending-deposit '${STX_HOLDER})`, (v) => v.startsWith('(some'), '(some ...)');
if (pendY.startsWith('(some')) {
  r = await tx('G6', 'keeper settle-token-y-deposit(holder, update)', KEEPER, MK, 'settle-token-y-deposit', [cp(STX_HOLDER), u1.cv, cp(WSTX), Cl.stringAscii('wstx')], has('(ok'));
  check('G7', 'Y bid settled resting, not refunded', prints(r), (v) => v.includes('"deposit-y"') && !v.includes('pending-refund'), 'deposit-y, no pending-refund-y');
}
await ev('G8', 'Y bid rests at the mid', MK, `(token-y-limit-at '${STX_HOLDER} u${mid})`, `u${mid}`);
await ev('G9', 'gist condition live: an ask AT the mid would take (crossing)', MK, `(would-take-as-x u${mid} u${mid})`, 'true');
await ev('G10', 'the vault at mid + 1 bp would not take', MK, `(would-take-as-x u${mid} u${ask1})`, 'false');

// ---- R: refloor at the var settles; at spread 0 it is refused "crossing" ----
await tx('R1', 'admin pool.refloor-vault (var u1) -> pending', DEP, PID, 'refloor-vault', [u1.cv, vaultCV], (v) => /^\(ok u\d+\)$/.test(v), '(ok floor)');
r = await tx('R2', 'keeper settle-token-x-limit(vault, update)', KEEPER, MK, 'settle-token-x-limit', [cp(VID), u1.cv], '(ok true)');
check('R3', 'no "crossing" refusal at the var', prints(r), lacks('"crossing"'), 'no crossing');
await ev('R4', 'order still (some u1), still resting all 100,000 sats', MK, `{ dep: ${xdep(VID)}, order: (get-token-x-order '${VID}) }`, has(`(dep u${FUND})`, '(spread-bps (some u1))'));
await tx('R5', 'admin wrapper sets maker-spread-bps u0', DEP, PID, 'set-vault-maker-spread-bps', [Cl.uint(0), vaultCV], '(ok true)');
await tx('R6', 'admin pool.refloor-vault (var u0) -> pending', DEP, PID, 'refloor-vault', [u1.cv, vaultCV], (v) => /^\(ok u\d+\)$/.test(v), '(ok floor)');
r = await tx('R7', 'keeper settle-token-x-limit on the spread-0 refloor', KEEPER, MK, 'settle-token-x-limit', [cp(VID), u1.cv], '(ok false)');
check('R8', 'spread-0 refloor refused "crossing" (the var is what the vault sends)', prints(r), has('(reason "crossing")'), 'reason "crossing"');
await ev('R9', 'order unchanged at (some u1), resting unchanged', MK, `{ dep: ${xdep(VID)}, order: (get-token-x-order '${VID}) }`, has(`(dep u${FUND})`, '(spread-bps (some u1))'));
await tx('R10', 'admin wrapper restores u1', DEP, PID, 'set-vault-maker-spread-bps', [Cl.uint(1), vaultCV], '(ok true)');
await ev('R11', 'get-config shows u1', VID, '(get maker-spread-bps (get-config))', 'u1');

// ---- T: a walking STX->sBTC taker fills the vault at mid + 1 bp ----
const stx0 = BigInt((await ev('T0', 'vault STX before', VID, '(stx-get-balance current-contract)', (v) => /^u\d+$/.test(v), 'uint')).slice(1));
// the holder now rests a Y bid (a resting maker cannot swap, u1018): the taker is STRANGER, a real address holding ~68 STX
r = await tx('T1', 'second real STX holder swaps 10 STX for sBTC, limit mid + 1%', STRANGER, MK, 'swap', [Cl.uint(10_000_000), Cl.uint((mid * 10100n) / 10000n), u1.cv, cp(SBTC), Cl.stringAscii('sbtc-token'), cp(WSTX), Cl.stringAscii('wstx'), Cl.bool(false)], has('(ok'));
const m = prints(r).split(' | ').find((e) => e.includes('"match"') && e.includes(VID)) ?? '';
console.log(`         T1 prints: ${prints(r).slice(0, 1500)}`);
check('T2', 'the walk matched the vault at mid + 1 bp', m, has(`(price u${ask1})`), `match with ${VID} at u${ask1}`);
await ev('T3', 'vault received STX from the fill', VID, '(stx-get-balance current-contract)', (v) => /^u\d+$/.test(v) && BigInt(v.slice(1)) > stx0, '> before');

console.log(`\n${passed}/${n} checks passed${fails.length ? `; FAILED: ${fails.join('; ')}` : ''}`);
const dir = resolve(here, 'results/maker-spread-live'); mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'fastpool.json'), JSON.stringify({ id: sid, url, forkBlock: tipBlock.height, mid: String(mid), sourceHashes: hashes, passed, total: n, checks: log }, null, 2) + '\n');
console.log(`RESULT: ${fails.length ? 'FAIL' : 'PASS'}\n${url}`);
process.exit(fails.length ? 1 : 0);
