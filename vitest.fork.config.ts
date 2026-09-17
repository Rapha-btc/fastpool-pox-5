import { defineConfig } from "vitest/config";
import {
  vitestSetupFilePath,
  getClarinetVitestsArgv,
} from "@stacks/clarinet-sdk/vitest";

/*
  Config for the MAINNET-FORK tests (`tests/mainnet/*.fork.test.ts`).

    pnpm test:fork

  These run against `Clarinet-mainnet.toml`, where `[repl.remote_data]` makes
  simnet read mainnet state on demand: real contract code, real balances, real
  DEX pool reserves. The default suite cannot do that -- there, mainnet
  contracts arrive as `requirements`, which copies their source and deploys
  them empty, so pools have no liquidity and the mock adapter stands in.

  They are a separate config, not a separate filter, because the default run
  excludes `*.fork.test.ts` outright: these hit the network, so they are slower
  and can fail for reasons that have nothing to do with the code under test.
*/

export default defineConfig({
  test: {
    environment: "clarinet",
    pool: "forks",
    isolate: false,
    maxWorkers: 1,
    include: ["tests/mainnet/**/*.fork.test.ts"],
    // Remote reads make these an order of magnitude slower than simnet.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    setupFiles: [vitestSetupFilePath],
    environmentOptions: {
      clarinet: {
        ...getClarinetVitestsArgv(),
      },
    },
  },
});
