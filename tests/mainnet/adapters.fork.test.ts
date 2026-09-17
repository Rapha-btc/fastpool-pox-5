// Mainnet-fork tests: the DEX adapters against REAL Bitflow liquidity, locally.
//
//   pnpm test:fork
//
// These use `Clarinet-mainnet.toml`, where `[repl.remote_data]` makes simnet
// read mainnet state on demand -- real contract code, real balances, real pool
// reserves. That is the one thing the default test suite cannot do: there,
// mainnet contracts arrive as `requirements`, which copies their source and
// deploys them empty, so `mock-dex-adapter` has to stand in for a pool.
//
// It is the same coverage as `simulations/1-adapter-swap.mjs`, but local and
// offline-reproducible rather than submitted to STXER, so it can run in CI.
import { Cl, cvToValue } from "@stacks/transactions";
import { appendFileSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
// A real mainnet address that holds sBTC. simnet does not verify signatures, so
// any principal can be the sender and it brings its real balance with it.
const WHALE = "SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2";

const AMOUNT_SATS = 1_000_000; // 0.01 sBTC

// vitest swallows console.log from these workers, so observed prices go to a
// file -- the point of a fork test is the numbers, not just the green tick.
// Appended to, never truncated: `pnpm test:fork` clears it first, so both fork
// test files can write into one report regardless of which vitest loads first.
const OUT = "tests/mainnet/last-run.txt";
const record = (line: string) => {
  try {
    appendFileSync(OUT, `${line}\n`);
  } catch {}
};

const num = (cv: any) => Number(cvToValue(cv, true)?.value ?? cvToValue(cv, true));

/** build/mainnet carries the mainnet pox-5 principal; contracts/ does not. */
function mainnetSource(name: string) {
  try {
    return readFileSync(`build/mainnet/${name}.clar`, "utf8");
  } catch {
    throw new Error(
      `build/mainnet/${name}.clar missing -- run \`node scripts/build-mainnet.mjs\` first`,
    );
  }
}

const sbtcBalance = (who: string) =>
  num(
    simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(who)], WHALE)
      .result,
  );
const stxBalance = (who: string) =>
  Number(simnet.getAssetsMap().get("STX")?.get(who) ?? 0n);

/**
 * Publish the suite under the test deployer.
 *
 * Called per test, not in `beforeAll`: the clarinet SDK resets simnet between
 * tests, so anything deployed in a hook is gone by the time a test body runs.
 */
function deploySuite() {
  const deployer = simnet.getAccounts().get("deployer")!;
  for (const name of [
    "dex-traits",
    "dex-adapter-bitflow-xyk",
    "dex-adapter-bitflow-dlmm",
  ]) {
    const r = simnet.deployContract(name, mainnetSource(name), null, deployer);
    // deployContract returns a bare bool, not a response.
    expect(r.result.type, `deploy ${name}: ${Cl.prettyPrint(r.result)}`).toBe("true");
  }
  return deployer;
}

describe("the fork itself", () => {
  it("reads real mainnet state", () => {
    deploySuite();
    record(`adapters, ${AMOUNT_SATS / 1e8} sBTC per leg:`);
    // If remote data were off, this would be 0 and every test below would be
    // meaningless -- so assert it before trusting anything else.
    expect(sbtcBalance(WHALE)).toBeGreaterThan(AMOUNT_SATS);
  });
});

describe("adapters against real Bitflow pools", () => {
  for (const venue of ["xyk", "dlmm"] as const) {
    it(`swaps sBTC for STX on ${venue}`, () => {
      const deployer = deploySuite();
      const adapter = `${deployer}.dex-adapter-bitflow-${venue}`;
      const sbtcBefore = sbtcBalance(WHALE);
      const stxBefore = stxBalance(WHALE);

      const r = simnet.callPublicFn(
        adapter,
        "swap-sbtc-to-stx",
        [Cl.uint(AMOUNT_SATS), Cl.uint(1)],
        WHALE,
      );
      expect(r.result.type, `${venue} swap: ${Cl.prettyPrint(r.result)}`).toBe("ok");

      const out = num(r.result);
      // Exactly the sBTC asked for left, and real STX came back.
      expect(sbtcBefore - sbtcBalance(WHALE)).toBe(AMOUNT_SATS);
      expect(stxBalance(WHALE) - stxBefore).toBeGreaterThan(0);
      // The adapter's return value is informational, but it should still agree
      // with what actually moved.
      expect(out).toBeGreaterThan(0);

      const received = stxBalance(WHALE) - stxBefore;
      record(
        `  ${venue.padEnd(5)} -> ${(received / 1e6).toFixed(2).padStart(10)} STX` +
          `  (${(received / AMOUNT_SATS).toFixed(1)} uSTX/sat)`,
      );
    });
  }

  it("honours min-stx-out", () => {
    const deployer = deploySuite();
    const adapter = `${deployer}.dex-adapter-bitflow-xyk`;
    // Ask for more STX than the pool can possibly give for 0.01 sBTC.
    const r = simnet.callPublicFn(
      adapter,
      "swap-sbtc-to-stx",
      [Cl.uint(AMOUNT_SATS), Cl.uint(10_000_000_000_000)],
      WHALE,
    );
    expect(r.result.type).toBe("err");
  });
});
