import {afterEach} from 'vitest';
import {appendFileSync, mkdirSync} from 'node:fs';
import {basename} from 'node:path';
import type {Simnet} from '@stacks/clarinet-sdk';
let active: Simnet | undefined;
export function track(sim: Simnet) { active = sim; }
// Reporting only: every test still arranges its own fresh simnet explicitly.
afterEach((context) => {
 if (!active) return;
 const report = active.collectReport(false, '');
 mkdirSync('tests/nov27/.build/coverage', {recursive:true});
 appendFileSync(`tests/nov27/.build/coverage/${basename(context.task.file.filepath)}.lcov`, report.coverage);
 active = undefined;
});
