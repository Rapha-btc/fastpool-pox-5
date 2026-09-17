// Shared plumbing for the STXER simulations in this directory.
//
// STXER runs a transaction against a real mainnet fork, so these cover exactly
// what the simnet tests cannot: the real Bitflow pools with real liquidity, the
// real Jing RFQ contract behind the price oracle, and the real pox-5.
//
// The reverse is also true, and matters for reading the results: a simulation
// is a single point in chain time, so it cannot advance reward cycles. Anything
// that needs a cycle boundary -- pox-5 accruing rewards to a brand-new signer,
// the fee-activation delay -- is covered by `tests/stx-rewards.test.ts` instead.
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { Cl, cvToValue, fetchCallReadOnlyFunction } from '@stacks/transactions';
import { STACKS_MAINNET } from '@stacks/network';

// The real FAST Pool deployer, so a simulation mirrors the actual deployment.
export const DEPLOYER = 'SPMPMA1V6P430M8C91QS1G9XJ95S59JS1TZFZ4Q4';
// Impersonated: a mainnet address that really holds sBTC. STXER lets any
// address be the sender, which is how these get funded without a faucet.
export const SBTC_WHALE = 'SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2';
// Stand-ins for the keeper and for three stakers.
export const OPERATOR = 'SP1K1A1PMGW2ZJCNF46NWZWHG8TS1D23EGH1KNK60';
export const STAKERS = [
  'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE',
  'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7',
  'SP3D6PV2ACBPEKYJTCMH7HEN02KP87QSP8KTEH335',
];

export const SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
export const XYK_HELPER = 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-swap-helper-v-1-3';
export const XYK_POOL = 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1';
export const WSTX = 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2';

const net = { network: STACKS_MAINNET, client: { baseUrl: 'https://api.hiro.so' } };

// A stale build/mainnet is the worst kind of failure here: the simulation runs,
// the URL looks fine, and it is exercising last week's contract. Refuse instead.
function assertFresh(path) {
  const built = statSync(path).mtimeMs;
  const newest = readdirSync('contracts')
    .filter((f) => f.endsWith('.clar'))
    .map((f) => statSync(`contracts/${f}`).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);
  if (newest > built) {
    throw new Error(
      `${path} is older than contracts/ -- run \`node scripts/build-mainnet.mjs\` first.\n` +
        'A stale build silently simulates the wrong contract.',
    );
  }
}

/** Mainnet-flavoured source, i.e. with the pox-5 principal rewritten. */
export function source(name) {
  try {
    const path = `build/mainnet/${name}.clar`;
    assertFresh(path);
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (String(e.message).includes('older than contracts/')) throw e;
    throw new Error(
      `build/mainnet/${name}.clar is missing -- run \`node scripts/build-mainnet.mjs\` first.\n` +
        'The contracts in contracts/ carry the TESTNET pox-5 principal and will not ' +
        'deploy against a mainnet fork.',
    );
  }
}

/** The live Bitflow XYK quote, so `min-stx-out` is set the way the keeper sets it. */
export async function quoteXyk(amountSats) {
  const cv = await fetchCallReadOnlyFunction({
    contractAddress: XYK_HELPER.split('.')[0],
    contractName: XYK_HELPER.split('.')[1],
    functionName: 'get-quote-a',
    functionArgs: [
      Cl.uint(amountSats),
      Cl.none(),
      Cl.tuple({ a: Cl.principal(SBTC), b: Cl.principal(WSTX) }),
      Cl.tuple({ a: Cl.principal(XYK_POOL) }),
    ],
    senderAddress: DEPLOYER,
    ...net,
  });
  const v = cvToValue(cv, true);
  if (v?.value === undefined) throw new Error(`quote failed: ${Cl.prettyPrint(cv)}`);
  return BigInt(v.value);
}

export const stx = (ustx) => `${(Number(ustx) / 1e6).toFixed(2)} STX`;
export const btc = (sats) => `${(Number(sats) / 1e8).toFixed(5)} sBTC`;

export function report(title, id) {
  console.log(`\n${title}`);
  console.log(`  https://stxer.xyz/simulations/mainnet/${id}`);
  return id;
}
