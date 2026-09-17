#!/usr/bin/env node
//
// Summarise an STXER simulation result: one line per step, Ok/Err, and the
// values any read step returned.
//
//   node simulations/summarize.mjs <simulation-id>
import { getSimulationResult } from 'stxer';
import { Cl, hexToCV } from '@stacks/transactions';

// Read values come back as raw Clarity hex; print them as Clarity instead.
const pretty = (v) => {
  if (v == null) return String(v);
  const s = String(v);
  if (!/^[0-9a-f]+$/i.test(s) || s.length < 2) return s;
  try {
    return Cl.prettyPrint(hexToCV(s.startsWith('0x') ? s : `0x${s}`), 2);
  } catch {
    return s;
  }
};

const id = process.argv[2];
if (!id) {
  console.error('usage: node simulations/summarize.mjs <simulation-id>');
  process.exit(1);
}

const res = await getSimulationResult(id, 'mainnet');
console.log(`block ${res.metadata?.block_height}  burn ${res.metadata?.burn_block_height}  epoch ${res.metadata?.epoch}`);

let failures = 0;
res.steps.forEach((step, i) => {
  const r = step.Result ?? {};
  if (r.Transaction) {
    const tx = r.Transaction;
    if (tx.Ok) {
      const err = tx.Ok.vm_error;
      const bad = err || String(tx.Ok.result ?? '').startsWith('08'); // 08 = (err ..)
      if (bad) failures++;
      console.log(
        `${String(i).padStart(3)}  tx    ${bad ? 'ERR ' : 'ok  '}${pretty(tx.Ok.result)}` +
          (err ? `  vm_error=${err}` : '') +
          `  events=${tx.Ok.events?.length ?? 0}`,
      );
      if (process.env.EVENTS) {
        for (const e of tx.Ok.events ?? []) {
          const j = typeof e === 'string' ? e : JSON.stringify(e);
          const m = j.match(/"(stx|ft)_transfer_event":\{"amount":"(\d+)"[^}]*"recipient":"([^"]+)"/);
          if (m) console.log(`       - ${m[1]} ${m[2]} -> ${m[3]}`);
        }
      }
    } else {
      failures++;
      console.log(`${String(i).padStart(3)}  tx    FAILED ${JSON.stringify(tx).slice(0, 300)}`);
    }
  } else if (r.Eval !== undefined) {
    const e = r.Eval;
    console.log(`${String(i).padStart(3)}  eval  ${e.Ok !== undefined ? pretty(e.Ok) : `ERR ${JSON.stringify(e).slice(0, 250)}`}`);
  } else if (r.Reads !== undefined) {
    for (const v of r.Reads) {
      if (v.Ok !== undefined) console.log(`${String(i).padStart(3)}  read  ${pretty(v.Ok)}`);
      else console.log(`${String(i).padStart(3)}  read  ERR ${JSON.stringify(v).slice(0, 200)}`);
    }
  } else {
    console.log(`${String(i).padStart(3)}  ${JSON.stringify(r).slice(0, 250)}`);
  }
});
console.log(failures ? `\n${failures} step(s) failed` : '\nall steps ok');
