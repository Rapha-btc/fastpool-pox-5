import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  ADAPTER,
  MGR,
  ORACLE,
  POT,
  RATE,
  adapterPrincipal,
  amounts,
  armSwap,
  advancePastCycle,
  claimPot,
  deliverPot,
  deployer,
  distribute,
  distributeMany,
  checkMirror,
  mgrNum,
  mgrPrincipal,
  mgrRead,
  oraclePrincipal,
  POX5,
  quote,
  readNum,
  sbtcBalance,
  setup,
  stakerRewards,
  stakers,
  stxBalance,
  swap,
  swapStatus,
  swapWithProof,
  expectOk,
} from "./helpers/stx-rewards-fixture";
import { registerSigner } from "./helpers/rewards-fixture";

const errCode = (r: any) => Number((r.result as any).value.value);
const total = amounts.reduce((a, b) => a + b, 0);

/** Claim, arm the DEX, pin. Returns the pot actually pulled in. */
function ready(numCycles = 2) {
  const { rewardCycle } = setup(numCycles);
  armSwap();
  const pot = claimPot(rewardCycle);
  return { rewardCycle, pot };
}

describe("mirror and pinning", () => {
  it("mirrors pox-5's shares exactly and pins the denominator", () => {
    const { rewardCycle } = setup();
    const mirror = checkMirror(rewardCycle);
    expect(mirror.matches).toBe(true);
    expect(mirror.local).toBe(total);

    claimPot(rewardCycle);
    expectOk(
      simnet.callPublicFn(MGR, "pin-shares", [Cl.uint(rewardCycle)], deployer),
      "pin-shares",
    );
    expect(swapStatus(rewardCycle).totalShares).toBe(total);
    expect(swapStatus(rewardCycle).pinned).toBe(true);
  });

  it("refuses to pin a cycle that was never claimed", () => {
    const { rewardCycle } = setup();
    const r = simnet.callPublicFn(MGR, "pin-shares", [Cl.uint(rewardCycle)], deployer);
    expect(errCode(r)).toBe(1023); // ERR_CYCLE_NOT_CLAIMED
  });

  it("refuses to repair a pinned cycle", () => {
    const { rewardCycle } = ready();
    expectOk(simnet.callPublicFn(MGR, "pin-shares", [Cl.uint(rewardCycle)], deployer), "pin");
    const r = simnet.callPublicFn(
      MGR,
      "repair-mirror-many",
      [Cl.list([Cl.principal(stakers[0])]), Cl.uint(rewardCycle)],
      deployer,
    );
    expect(errCode(r)).toBe(1025); // ERR_SHARES_ALREADY_PINNED
  });

  it("repairs a mirror that drifted from a mid-lock unstake, then pins", () => {
    // Lock for three cycles, so a mid-lock unstake strands a future cycle in
    // the mirror without pox-5 ever calling back.
    const { rewardCycle } = setup(3);
    const driftedCycle = rewardCycle + 2;

    const un = simnet.callPublicFn(
      POX5,
      "unstake",
      [Cl.principal(mgrPrincipal())],
      stakers[0],
    );
    expectOk(un, "unstake");

    advancePastCycle(driftedCycle);
    deliverPot();
    claimPot(driftedCycle);

    const before = checkMirror(driftedCycle);
    expect(before.matches).toBe(false);
    expect(before.local).toBeGreaterThan(before.pox5);

    const failed = simnet.callPublicFn(MGR, "pin-shares", [Cl.uint(driftedCycle)], deployer);
    expect(errCode(failed)).toBe(1024); // ERR_SHARE_MIRROR_MISMATCH

    expectOk(
      simnet.callPublicFn(
        MGR,
        "repair-mirror-many",
        [Cl.list([Cl.principal(stakers[0])]), Cl.uint(driftedCycle)],
        deployer,
      ),
      "repair",
    );

    expect(checkMirror(driftedCycle).matches).toBe(true);
    expectOk(
      simnet.callPublicFn(MGR, "pin-shares", [Cl.uint(driftedCycle)], deployer),
      "pin after repair",
    );
    expect(mgrNum("get-mirrored-shares", [Cl.principal(stakers[0]), Cl.uint(driftedCycle)])).toBe(0);
  });
});

describe("lock periods", () => {
  // pox-5 accepts 1..MAX_NUM_CYCLES (u96). `validate-stake!` slices
  // CYCLE_OFFSETS to the lock length, so a list shorter than pox-5's cap turns
  // a perfectly legal stake into ERR_INVALID_LOCK_PERIOD. It was 12 entries
  // once, which silently capped the pool at 12-cycle locks.
  for (const numCycles of [1, 12, 13, 40, 96]) {
    it(`mirrors every cycle of a ${numCycles}-cycle lock`, () => {
      registerSigner(deployer, MGR);
      const cycle = readNum("current-pox-reward-cycle", []);
      const startBurnHt = readNum("reward-cycle-to-burn-height", [Cl.uint(cycle)]);
      const amount = 100_000_000_000;

      const r = simnet.callPublicFn(
        POX5,
        "stake",
        [
          Cl.principal(mgrPrincipal()),
          Cl.uint(amount),
          Cl.uint(numCycles),
          Cl.uint(startBurnHt),
          Cl.none(),
        ],
        stakers[0],
      );
      expectOk(r, `stake for ${numCycles} cycles`);

      // Shares mirrored for the whole lock, and nothing past its end.
      for (let i = 0; i < numCycles; i++) {
        expect(
          mgrNum("get-mirrored-shares", [
            Cl.principal(stakers[0]),
            Cl.uint(cycle + 1 + i),
          ]),
          `cycle ${cycle + 1 + i} of ${numCycles}`,
        ).toBe(amount);
      }
      expect(
        mgrNum("get-mirrored-shares", [
          Cl.principal(stakers[0]),
          Cl.uint(cycle + 1 + numCycles),
        ]),
      ).toBe(0);
    });
  }

  it("refuses a lock longer than pox-5 itself allows", () => {
    registerSigner(deployer, MGR);
    const cycle = readNum("current-pox-reward-cycle", []);
    const startBurnHt = readNum("reward-cycle-to-burn-height", [Cl.uint(cycle)]);
    const r = simnet.callPublicFn(
      POX5,
      "stake",
      [
        Cl.principal(mgrPrincipal()),
        Cl.uint(100_000_000_000),
        Cl.uint(97), // MAX_NUM_CYCLES + 1
        Cl.uint(startBurnHt),
        Cl.none(),
      ],
      stakers[0],
    );
    // pox-5 rejects it before the callback is reached, so this never becomes
    // our ERR_INVALID_LOCK_PERIOD -- which is why that error is unreachable in
    // practice and stays as a defensive guard.
    expect(r.result.type).toBe("err");
  });
});

describe("validate-stake! guards", () => {
  it("refuses staking calldata, since there is no L1 payout path here", () => {
    simnet.callPublicFn(MGR, "set-operator", [Cl.principal(deployer)], deployer);
    setup();
    const cycle = readNum("current-pox-reward-cycle", []);
    const startBurnHt = readNum("reward-cycle-to-burn-height", [Cl.uint(cycle)]);
    const r = simnet.callPublicFn(
      POX5,
      "stake",
      [
        Cl.principal(mgrPrincipal()),
        Cl.uint(10_000_000_000),
        Cl.uint(1),
        Cl.uint(startBurnHt),
        Cl.some(Cl.bufferFromHex("00")),
      ],
      stakers[0],
    );
    // pox-5 propagates the callback's error verbatim through `try!`.
    expect(errCode(r)).toBe(1003); // ERR_CALLDATA_NOT_SUPPORTED (shared code with max500)
  });
});

describe("swap", () => {
  it("swaps the whole pot and pays every staker STX pro-rata", () => {
    const { rewardCycle, pot } = ready();
    const expected = quote(pot);
    expectOk(swap(rewardCycle, pot, expected), "swap");

    const status = swapStatus(rewardCycle);
    expect(status.swappedSats).toBe(pot);
    expect(status.remainingSats).toBe(0);
    expect(status.stxOut).toBe(expected);
    expect(mgrNum("get-unswapped-sats")).toBe(0);
    expect(mgrNum("get-unpaid-stx")).toBe(expected);

    const before = stakers.map(stxBalance);
    const r = distributeMany(stakers, rewardCycle);
    expectOk(r, "distribute-rewards-many");
    const paid = stakers.map((w, i) => stxBalance(w) - before[i]);

    // Everyone gets their share of the same fill, floored.
    stakers.forEach((_, i) => {
      expect(paid[i]).toBe(Math.floor((expected * amounts[i]) / total));
    });
    // The pot is fully accounted for: payouts plus the rounding dust left behind.
    const dust = expected - paid.reduce((a, b) => a + b, 0);
    expect(dust).toBeGreaterThanOrEqual(0);
    expect(dust).toBeLessThan(stakers.length);
    expect(mgrNum("get-unpaid-stx")).toBe(dust);
  });

  it("splits one pot across several legs and pays the increment each time", () => {
    const { rewardCycle, pot } = ready();
    const legA = Math.floor(pot / 3);
    const legB = pot - legA;

    expectOk(swap(rewardCycle, legA, quote(legA)), "leg A");
    const afterA = stakerRewards(stakers[0], rewardCycle);
    expect(afterA["stx-due"]).toBe(
      Math.floor((quote(legA) * amounts[0]) / total),
    );

    const before = stxBalance(stakers[0]);
    expectOk(distribute(stakers[0], rewardCycle), "distribute after leg A");
    expect(stxBalance(stakers[0]) - before).toBe(afterA["stx-due"]);

    // Second leg through the same adapter; the watermark means only the
    // difference is paid out.
    expectOk(swap(rewardCycle, legB, quote(legB)), "leg B");
    const due = stakerRewards(stakers[0], rewardCycle)["stx-due"];
    const before2 = stxBalance(stakers[0]);
    expectOk(distribute(stakers[0], rewardCycle), "distribute after leg B");
    expect(stxBalance(stakers[0]) - before2).toBe(due);

    expect(stakerRewards(stakers[0], rewardCycle)["stx-due"]).toBe(0);
    expect(swapStatus(rewardCycle).remainingSats).toBe(0);
  });

  it("re-distributing a staker with nothing due is an error, not a second payment", () => {
    const { rewardCycle, pot } = ready();
    expectOk(swap(rewardCycle, pot, quote(pot)), "swap");
    expectOk(distribute(stakers[0], rewardCycle), "first");
    const balance = stxBalance(stakers[0]);
    const r = distribute(stakers[0], rewardCycle);
    expect(errCode(r)).toBe(1001); // ERR_NO_CLAIMABLE_REWARDS (shared code with max500)
    expect(stxBalance(stakers[0])).toBe(balance);
  });

  it("takes the fee in sBTC before the DEX sees anything, and it is withdrawable", () => {
    // Queue the rate BEFORE staking: like max500, a fee increase only becomes
    // snapshottable FEE_ACTIVATION_DELAY_CYCLES later, and `setup` advances
    // exactly that far while it runs the cycle out.
    expectOk(simnet.callPublicFn(MGR, "update-fees", [Cl.uint(500)], deployer), "fees");
    const { rewardCycle } = setup();
    armSwap();
    const pot = claimPot(rewardCycle);

    const fee = Math.floor((pot * 500) / 10_000);
    const net = pot - fee;
    expectOk(swap(rewardCycle, pot, quote(net)), "swap");

    expect(mgrNum("get-earned-fees")).toBe(fee);
    expect(swapStatus(rewardCycle).feeSats).toBe(fee);
    // Only the net reached the DEX.
    expect(swapStatus(rewardCycle).stxOut).toBe(quote(net));

    const before = sbtcBalance(deployer);
    expectOk(
      simnet.callPublicFn(
        MGR,
        "withdraw-fees",
        [Cl.uint(fee), Cl.principal(deployer)],
        deployer,
      ),
      "withdraw-fees",
    );
    expect(sbtcBalance(deployer) - before).toBe(fee);
    expect(mgrNum("get-earned-fees")).toBe(0);
  });

  it("treats the baseline as informational until an admin switches it on", () => {
    const { rewardCycle, pot } = ready();
    expect(mgrRead("get-enforce-price-floor", []).type).toBe("false");
    // Far below the baseline, and it still goes through: the floor is off.
    expectOk(swap(rewardCycle, pot, 1), "unenforced");
    // ...and the swap still happened at the market's price, not the floor's.
    expect(swapStatus(rewardCycle).stxOut).toBe(quote(pot));
  });

  it("enforces the baseline floor once switched on", () => {
    const { rewardCycle, pot } = ready();
    expectOk(
      simnet.callPublicFn(MGR, "set-enforce-price-floor", [Cl.bool(true)], deployer),
      "enable floor",
    );
    const floor = Math.floor((quote(pot) * 8000) / 10_000); // 20% default tolerance
    expect(errCode(swap(rewardCycle, pot, floor - 1))).toBe(1031); // ERR_MIN_OUT_TOO_LOW
    expectOk(swap(rewardCycle, pot, floor), "at the floor");
  });

  it("does not let a dead oracle block a swap while the floor is off", () => {
    const { rewardCycle, pot } = ready();
    // Rate 0 makes the dummy quote 0, which is the closest stand-in for an
    // oracle with nothing useful to say.
    expectOk(simnet.callPublicFn(ORACLE, "set-rate", [Cl.uint(0)], deployer), "zero rate");
    expectOk(swap(rewardCycle, pot, quote(pot)), "swap without a usable baseline");
    expect(swapStatus(rewardCycle).stxOut).toBe(quote(pot));
  });

  it("rejects an unlisted adapter, a wrong oracle, and a non-operator caller", () => {
    const { rewardCycle, pot } = ready();
    expect(
      errCode(swap(rewardCycle, pot, quote(pot), deployer, `${deployer}.price-oracle-dummy`)),
    ).toBe(1028); // ERR_ADAPTER_NOT_ALLOWED
    expect(
      errCode(
        swap(rewardCycle, pot, quote(pot), deployer, adapterPrincipal(), adapterPrincipal()),
      ),
    ).toBe(1029); // ERR_WRONG_ORACLE
    expect(errCode(swap(rewardCycle, pot, quote(pot), stakers[1]))).toBe(1020); // ERR_UNAUTHORIZED_OPERATOR
  });

  it("reverts the whole transaction when the adapter under-delivers", () => {
    const { rewardCycle, pot } = ready();
    expectOk(simnet.callPublicFn(ADAPTER, "set-mode", [Cl.uint(1)], deployer), "mode");
    const r = swap(rewardCycle, pot, quote(pot));
    expect(errCode(r)).toBe(1032); // ERR_SLIPPAGE
    // Nothing moved: the pot is intact and no STX was credited.
    expect(swapStatus(rewardCycle).swappedSats).toBe(0);
    expect(mgrNum("get-unswapped-sats")).toBe(pot);
    expect(mgrNum("get-unpaid-stx")).toBe(0);
  });

  it("refuses to swap more than the pot has left", () => {
    const { rewardCycle, pot } = ready();
    expect(errCode(swap(rewardCycle, pot + 1, quote(pot + 1)))).toBe(1027); // ERR_SWAP_EXCEEDS_POT
    expectOk(swap(rewardCycle, pot, quote(pot)), "exact pot");
    expect(errCode(swap(rewardCycle, 1, 0))).toBe(1027); // nothing left
  });

  it("hands swap rights to a rotated operator and takes them from the old one", () => {
    const { rewardCycle, pot } = ready();
    expectOk(
      simnet.callPublicFn(MGR, "set-operator", [Cl.principal(stakers[1])], deployer),
      "set-operator",
    );
    expect(errCode(swap(rewardCycle, pot, quote(pot), deployer))).toBe(1020);
    expectOk(swap(rewardCycle, pot, quote(pot), stakers[1]), "new operator swaps");
  });
});

describe("swap-rewards-with-proof", () => {
  // Stands in for a Pyth VAA: the manager treats it as opaque bytes.
  const PROOF = "deadbeef".repeat(8);

  it("swaps through a proof-carrying venue and forwards the payload untouched", () => {
    const { rewardCycle, pot } = ready();
    const expected = quote(pot);
    expectOk(swapWithProof(rewardCycle, pot, expected, PROOF), "swap with proof");

    expect(swapStatus(rewardCycle).stxOut).toBe(expected);
    expect(swapStatus(rewardCycle).swappedSats).toBe(pot);
    // The manager must not inspect, truncate or reorder the venue's payload.
    expect(
      simnet.callReadOnlyFn(ADAPTER, "get-last-proof", [], deployer).result,
    ).toStrictEqual(Cl.bufferFromHex(PROOF));
  });

  it("holds the proof path to the same min-stx-out as the plain path", () => {
    const { rewardCycle, pot } = ready();
    expectOk(simnet.callPublicFn(ADAPTER, "set-mode", [Cl.uint(1)], deployer), "under-deliver");
    expect(errCode(swapWithProof(rewardCycle, pot, quote(pot), PROOF))).toBe(1032); // ERR_SLIPPAGE
    expect(swapStatus(rewardCycle).swappedSats).toBe(0);
    expect(mgrNum("get-unswapped-sats")).toBe(pot);
  });

  it("is operator-gated and allowlisted like the plain path", () => {
    const { rewardCycle, pot } = ready();
    expect(errCode(swapWithProof(rewardCycle, pot, quote(pot), PROOF, stakers[1]))).toBe(1020);
    expect(
      errCode(
        swapWithProof(rewardCycle, pot, quote(pot), PROOF, deployer, oraclePrincipal()),
      ),
    ).toBe(1028); // ERR_ADAPTER_NOT_ALLOWED
  });

  it("accumulates legs with the plain path on the same cycle", () => {
    const { rewardCycle, pot } = ready();
    const legA = Math.floor(pot / 2);
    const legB = pot - legA;
    expectOk(swap(rewardCycle, legA, quote(legA)), "amm leg");
    expectOk(swapWithProof(rewardCycle, legB, quote(legB), PROOF), "auction leg");
    // One settlement record, both venues.
    expect(swapStatus(rewardCycle).swappedSats).toBe(pot);
    expect(swapStatus(rewardCycle).stxOut).toBe(quote(legA) + quote(legB));
    expect(swapStatus(rewardCycle).remainingSats).toBe(0);
  });
});

describe("the 3-day swap window", () => {
  it("holds the sBTC leg at zero while the window is open", () => {
    const { rewardCycle } = ready();
    expect(swapStatus(rewardCycle).windowOpen).toBe(true);
    const due = stakerRewards(stakers[0], rewardCycle);
    expect(due["sbtc-due"]).toBe(0);
    expect(due["sbtc-gross-due"]).toBe(0);
    // ...even though the pot is entirely unswapped.
    expect(swapStatus(rewardCycle).remainingSats).toBeGreaterThan(0);
  });

  it("pays the whole pot as sBTC, net of fees, when the operator never swaps", () => {
    // See the note in the fee test above: queued before the delay elapses.
    expectOk(simnet.callPublicFn(MGR, "update-fees", [Cl.uint(500)], deployer), "fees");
    const { rewardCycle } = setup();
    armSwap();
    const pot = claimPot(rewardCycle);

    simnet.mineEmptyBurnBlocks(433);
    expect(swapStatus(rewardCycle).windowOpen).toBe(false);
    expect(errCode(swap(rewardCycle, pot, quote(pot)))).toBe(1026); // ERR_SWAP_WINDOW_CLOSED

    const before = stakers.map(sbtcBalance);
    expectOk(distributeMany(stakers, rewardCycle), "distribute");
    const paid = stakers.map((w, i) => sbtcBalance(w) - before[i]);

    let fees = 0;
    stakers.forEach((_, i) => {
      const gross = Math.floor((pot * amounts[i]) / total);
      const fee = Math.floor((gross * 500) / 10_000);
      fees += fee;
      expect(paid[i]).toBe(gross - fee);
    });
    expect(mgrNum("get-earned-fees")).toBe(fees);
    // Nothing was ever swapped, so no STX is owed to anyone.
    expect(mgrNum("get-unpaid-stx")).toBe(0);
  });

  it("pays both legs when the window closes mid-route", () => {
    const { rewardCycle, pot } = ready();
    const swapped = Math.floor(pot / 2);
    expectOk(swap(rewardCycle, swapped, quote(swapped)), "half");

    simnet.mineEmptyBurnBlocks(433);
    const leftover = pot - swapped;

    const stxBefore = stakers.map(stxBalance);
    const sbtcBefore = stakers.map(sbtcBalance);
    expectOk(distributeMany(stakers, rewardCycle), "distribute both legs");

    stakers.forEach((w, i) => {
      expect(stxBalance(w) - stxBefore[i]).toBe(
        Math.floor((quote(swapped) * amounts[i]) / total),
      );
      expect(sbtcBalance(w) - sbtcBefore[i]).toBe(
        Math.floor((leftover * amounts[i]) / total),
      );
    });
    expect(swapStatus(rewardCycle).remainingSats).toBe(leftover);
  });
});

describe("reserves and sweeps", () => {
  it("never lets a sweep reach sBTC or STX owed to stakers", () => {
    const { rewardCycle, pot } = ready();
    // Whole pot pulled in, nothing swapped: it is all staker liability.
    expect(mgrNum("get-unswapped-sats")).toBe(pot);
    expect(errCode(simnet.callPublicFn(MGR, "sweep-sbtc-dust", [Cl.principal(deployer)], deployer)))
      .toBe(1033); // ERR_NO_DUST

    expectOk(swap(rewardCycle, pot, quote(pot)), "swap");
    // Now it is all STX liability instead.
    expect(errCode(simnet.callPublicFn(MGR, "sweep-stx-dust", [Cl.principal(deployer)], deployer)))
      .toBe(1033); // ERR_NO_DUST

    expectOk(distributeMany(stakers, rewardCycle), "distribute");

    // What is left is the floor-division remainder, and it stays reserved:
    // `unpaid-stx` is only reduced by what stakers were actually paid, so the
    // remainder is inside the liability and no sweep can reach it. That
    // strands well under a micro-STX per staker per cycle, and buys the
    // guarantee that an admin call can never touch staker funds.
    expect(stxBalance(mgrPrincipal())).toBe(mgrNum("get-unpaid-stx"));
    expect(
      errCode(simnet.callPublicFn(MGR, "sweep-stx-dust", [Cl.principal(deployer)], deployer)),
    ).toBe(1033); // ERR_NO_DUST
  });

  it("recovers STX that arrived outside the reward path", () => {
    const { rewardCycle, pot } = ready();
    expectOk(swap(rewardCycle, pot, quote(pot)), "swap");
    expectOk(distributeMany(stakers, rewardCycle), "distribute");

    const stray = 7_000_000;
    simnet.transferSTX(stray, mgrPrincipal(), stakers[3]);

    const before = stxBalance(deployer);
    expectOk(
      simnet.callPublicFn(MGR, "sweep-stx-dust", [Cl.principal(deployer)], deployer),
      "sweep stray",
    );
    expect(stxBalance(deployer) - before).toBe(stray);
    // The reserved remainder is still untouched.
    expect(stxBalance(mgrPrincipal())).toBe(mgrNum("get-unpaid-stx"));
  });
});
