import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const testDir = dirname(fileURLToPath(import.meta.url));
const fastpoolManifest = resolve(testDir, '.build/fastpool-only/Clarinet.toml');
const activeManifest = resolve(
  process.cwd(),
  globalThis.options?.clarinet?.manifestPath ?? 'Clarinet.toml',
);

if (activeManifest === fastpoolManifest) {
  test('FastPool signer and vault lifecycle against pinned source bytes', async () => {
    await import('./run-fastpool.mjs');
  });
} else {
  test.skip('FastPool signer and vault lifecycle needs its isolated manifest', () => {});
}
