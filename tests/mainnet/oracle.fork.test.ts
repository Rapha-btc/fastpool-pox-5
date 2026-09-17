// Mainnet-fork test: what the price oracle CAN and CANNOT be checked on a fork.
//
//   pnpm test:fork
//
// A local fork serves mainnet *contract state* -- balances, maps, DEX pool
// reserves -- and real block heights. It does NOT serve burnchain tenure data:
// `get-tenure-info? miner-spend-total` returns simnet's own synthetic value.
//
// That matters here, because `price-oracle-jing` is built on exactly that
// primitive. On a fork it reports roughly 500,000 uSTX/sat against a real
// ~3,490 -- about 143x high, from a synthetic 2,000-sat average tenure spend.
//
// So the baseline CANNOT be measured locally. The real measurement is
// `simulations/3-price-baseline.mjs`, which runs on STXER where tenure data is
// real. What is checked here instead:
//   1. the oracle deploys and answers on a fork          (structural)
//   2. the market side of the comparison is faithful     (real pool reserves)
//   3. a canary, so nobody mistakes the fork number for a real one
import { Cl, cvToValue, fetchCallReadOnlyFunction } from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";
import { appendFileSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const WSTX = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2";
const XYK_HELPER = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-swap-helper-v-1-3";
const XYK_POOL = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1";
const JING_RFQ = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.rfq-sbtc-stx-jing-v2-3";

const SIZES = [100_000, 1_000_000, 5_000_000, 10_000_000]; // 0.001 .. 0.1 sBTC
const record = (line: string) => {
  try {
    appendFileSync("tests/mainnet/last-run.txt", `${line}\n`);
  } catch {}
};

const okNum = (cv: any) => Number(cvToValue(cv, true)?.value);

function deployOracle() {
  const deployer = simnet.getAccounts().get("deployer")!;
  for (const name of ["dex-traits", "price-oracle-jing"]) {
    const r = simnet.deployContract(
      name,
      readFileSync(`build/mainnet/${name}.clar`, "utf8"),
      null,
      deployer,
    );
    expect(r.result.type, `deploy ${name}: ${Cl.prettyPrint(r.result)}`).toBe("true");
  }
  return deployer;
}

describe("price oracle on a fork", () => {
  it("deploys and answers", () => {
    const deployer = deployOracle();
    const price = simnet.callReadOnlyFn(
      `${deployer}.price-oracle-jing`,
      "get-native-price",
      [],
      deployer,
    ).result;
    expect(price.type, Cl.prettyPrint(price)).toBe("ok");
    expect(okNum(price)).toBeGreaterThan(0);

    // The conversion is linear in size and uses the documented 1e10 scale.
    const one = okNum(
      simnet.callReadOnlyFn(
        `${deployer}.price-oracle-jing`,
        "sats-to-ustx",
        [Cl.uint(1_000_000)],
        deployer,
      ).result,
    );
    expect(one).toBe(Math.floor((1_000_000 * okNum(price)) / 1e10));
  });

  it("CANARY: fork tenure data is synthetic, so the baseline is not real", async () => {
    const deployer = deployOracle();
    const forkPrice = okNum(
      simnet.callReadOnlyFn(JING_RFQ, "get-native-price", [], deployer).result,
    );
    const live = await fetchCallReadOnlyFunction({
      contractAddress: JING_RFQ.split(".")[0],
      contractName: JING_RFQ.split(".")[1],
      functionName: "get-native-price",
      functionArgs: [],
      senderAddress: deployer,
      network: STACKS_MAINNET,
      client: { baseUrl: "https://api.hiro.so" },
    });
    const livePrice = okNum(live);

    record(
      `\nbaseline, fork vs live:  fork ${(forkPrice / 1e10).toFixed(1)} uSTX/sat` +
        `   live ${(livePrice / 1e10).toFixed(1)} uSTX/sat`,
    );

    // If this ever fails, clarinet has started forking burnchain tenure data --
    // in which case the baseline CAN be measured locally, and
    // simulations/3-price-baseline.mjs no longer needs to be the only source.
    // Delete this test and assert the real relationship instead.
    expect(
      forkPrice / livePrice,
      "fork tenure data now looks real -- see the comment above",
    ).toBeGreaterThan(10);
  });

  it("quotes the market faithfully, which is the half a fork gets right", () => {
    const deployer = deployOracle();
    record("\n  market quotes (real pool reserves):");
    let previousPerSat = Infinity;
    for (const sats of SIZES) {
      const market = okNum(
        simnet.callPublicFn(
          XYK_HELPER,
          "get-quote-a",
          [
            Cl.uint(sats),
            Cl.none(),
            Cl.tuple({ a: Cl.principal(SBTC), b: Cl.principal(WSTX) }),
            Cl.tuple({ a: Cl.principal(XYK_POOL) }),
          ],
          deployer,
        ).result,
      );
      expect(market).toBeGreaterThan(0);
      const perSat = market / sats;
      record(`    ${(sats / 1e8).toFixed(3)} sBTC -> ${(market / 1e6).toFixed(0).padStart(7)} STX  (${perSat.toFixed(1)} uSTX/sat)`);

      // Depth is the thing a fork DOES model: a bigger leg gets a worse price.
      // This is the curve behind the leg-sizing guidance in the deploy runbook.
      expect(perSat).toBeLessThan(previousPerSat);
      previousPerSat = perSat;
    }
  });
});
