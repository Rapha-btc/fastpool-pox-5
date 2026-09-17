// Property-based tests for the distribution maths.
//
// These complement `tests/rv/signer-manager-stx-rewards.tests.clar`: rendezvous
// fuzzes CALL SEQUENCES and checks invariants over the contract's private
// state, which is where it is strongest. What it cannot easily express is a
// property over a whole randomised *share vector* -- Clarity has no way to sum
// an arbitrary-length list of payouts and compare it to the pot.
//
// So the properties here are about the split itself: conservation, fairness,
// and the exact dust bound the design promises.
//
// NOTE ON SHAPE. fast-check is used as the GENERATOR, not the runner: the
// clarinet SDK resets simnet between *tests*, not between fc iterations, so
// running many iterations inside one `it` would stake against an
// already-registered signer and fail from the second case on. `fc.sample` with
// a fixed seed draws the vectors up front and each becomes its own test, which
// keeps both the randomness and the isolation -- and makes a failure replayable
// by seed.
import { Cl } from "@stacks/transactions";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MGR,
  armSwap,
  claimPot,
  deployer,
  distribute,
  distributeMany,
  expectOk,
  quote,
  setup,
  stakers as ALL_STAKERS,
  stakerRewards,
  stxBalance,
  swap,
  swapStatus,
} from "./helpers/stx-rewards-fixture";

// pox-5 has a stacking minimum, so shares are drawn well above it. Eight is the
// number of funded simnet wallets.
const shareVector = fc.array(
  fc.integer({ min: 50_000, max: 5_000_000 }).map((k) => k * 1_000_000),
  { minLength: 2, maxLength: 8 },
);

// Fixed seed: the vectors are random but the run is reproducible, and a
// failure names the case that broke.
const SEED = 20260827;
const CASES = 6;
const VECTORS = fc.sample(shareVector, { numRuns: CASES, seed: SEED });
const label = (v: number[]) => v.map((n) => n / 1e6).join("/");

/** Stake `stakes`, claim, swap the whole pot, and pay everyone. */
function runCycle(stakes: number[]) {
  const { rewardCycle, stakers } = setup(2, stakes);
  armSwap();
  const pot = claimPot(rewardCycle);
  expectOk(swap(rewardCycle, pot, quote(pot)), "swap");

  const before = stakers.map(stxBalance);
  expectOk(distributeMany(stakers, rewardCycle), "distribute");
  const paid = stakers.map((w, i) => stxBalance(w) - before[i]);

  return { rewardCycle, stakers, stakes, paid, stxOut: swapStatus(rewardCycle).stxOut };
}

describe("distribution properties", () => {
  VECTORS.forEach((stakes) =>
    it(`conserves the pot: payouts plus dust equal the swap output [${label(stakes)}]`, () => {
      {
        const { paid, stxOut } = runCycle(stakes);
        const distributed = paid.reduce((a, b) => a + b, 0);
        const dust = stxOut - distributed;

        // Nothing is created...
        expect(distributed).toBeLessThanOrEqual(stxOut);
        // ...and nothing meaningful is lost: at most one micro-STX per staker,
        // which is the most floor division can shave off.
        expect(dust).toBeGreaterThanOrEqual(0);
        expect(dust).toBeLessThan(stakes.length);
      }
    }),
  );

  VECTORS.forEach((stakes) =>
    it(`pays exactly the pro-rata share, floored [${label(stakes)}]`, () => {
      {
        const { paid, stakes: used, stxOut } = runCycle(stakes);
        const total = used.reduce((a, b) => a + b, 0);
        used.forEach((share, i) => {
          expect(paid[i]).toBe(Math.floor((stxOut * share) / total));
        });
      }
    }),
  );

  VECTORS.forEach((stakes) =>
    it(`is monotone in stake: never less STX for a larger share [${label(stakes)}]`, () => {
      {
        const { paid, stakes: used } = runCycle(stakes);
        const order = used.map((s, i) => ({ s, p: paid[i] })).sort((a, b) => a.s - b.s);
        for (let i = 1; i < order.length; i++) {
          expect(order[i].p).toBeGreaterThanOrEqual(order[i - 1].p);
        }
      }
    }),
  );

  // Batching independence. A second full cycle cannot be run inside one test
  // (simnet only resets between tests), so instead this pays the SAME cycle
  // one staker at a time, in reverse order, and checks each against the
  // pro-rata formula. Together with the bulk case above -- same formula, one
  // call -- that is the property: the split does not depend on how it is
  // batched or in what order.
  VECTORS.slice(0, 3).forEach((stakes) =>
    it(`splits the same paid one-by-one, in reverse [${label(stakes)}]`, () => {
      const { rewardCycle, stakers } = setup(2, stakes);
      armSwap();
      const pot = claimPot(rewardCycle);
      expectOk(swap(rewardCycle, pot, quote(pot)), "swap");
      const stxOut = swapStatus(rewardCycle).stxOut;
      const total = stakes.reduce((a, b) => a + b, 0);

      const before = stakers.map(stxBalance);
      [...stakers].reverse().forEach((w) => {
        expectOk(distribute(w, rewardCycle), "distribute one");
      });

      stakers.forEach((w, i) => {
        expect(stxBalance(w) - before[i]).toBe(
          Math.floor((stxOut * stakes[i]) / total),
        );
      });
    }),
  );

  VECTORS.slice(0, 3).forEach((stakes) =>
    it(`is idempotent: a second distribution pays nothing more [${label(stakes)}]`, () => {
      {
        const { rewardCycle, stakers, paid } = runCycle(stakes);
        const before = stakers.map(stxBalance);
        // Every staker is now settled, so the batch finds nothing to do.
        const again = distributeMany(stakers, rewardCycle);
        expectOk(again, "second distribute");
        expect(Number((again.result as any).value.value.paid.value)).toBe(0);
        stakers.forEach((w, i) => expect(stxBalance(w) - before[i]).toBe(0));
        // ...and the view agrees nothing is left.
        stakers.forEach((w) => expect(stakerRewards(w, rewardCycle)["stx-due"]).toBe(0));
        expect(paid.every((p) => p >= 0)).toBe(true);
      }
    }),
  );
});

describe("fee properties", () => {
  const FEE_CASES = fc.sample(fc.integer({ min: 0, max: 500 }), {
    numRuns: 3,
    seed: SEED,
  });
  FEE_CASES.forEach((bips, i) =>
    it(`never takes more than ${bips} bips, and never from the STX leg`, () => {
      {
        const stakes = VECTORS[i % VECTORS.length];
          // Queued before staking: an increase waits FEE_ACTIVATION_DELAY_CYCLES,
          // which is exactly what `setup` advances past.
          expectOk(
            simnet.callPublicFn(MGR, "update-fees", [Cl.uint(bips)], deployer),
            "update-fees",
          );
          const { rewardCycle, stakers } = setup(2, stakes);
          armSwap();
          const pot = claimPot(rewardCycle);
          const fee = Math.floor((pot * bips) / 10_000);
          expectOk(swap(rewardCycle, pot, quote(pot - fee)), "swap");

          // The fee is taken in sBTC, off the top, before the DEX sees anything.
          expect(swapStatus(rewardCycle).feeSats).toBe(fee);
          expect(Number(mgrEarnedFees())).toBe(fee);

          // ...so the STX leg is untouched by it: stakers split the whole of
          // what came back.
          const before = stakers.map(stxBalance);
          expectOk(distributeMany(stakers, rewardCycle), "distribute");
          const distributed = stakers.reduce((a, w, i) => a + stxBalance(w) - before[i], 0);
        expect(swapStatus(rewardCycle).stxOut - distributed).toBeLessThan(stakes.length);
      }
    }),
  );
});

const mgrEarnedFees = () =>
  (simnet.callReadOnlyFn(MGR, "get-earned-fees", [], deployer).result as any).value;
