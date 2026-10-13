import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  addCost,
  costTotals,
  localDay,
  readCostLedgers,
  recordSessionCost,
} from "../index";

const at = (iso: string) => new Date(iso);

describe("session cost ledger", () => {
  test("books what a running total added, on the day it was added", () => {
    let ledger = addCost(undefined, 1.5, at("2026-10-12T10:00:00"));
    ledger = addCost(ledger, 2, at("2026-10-12T18:00:00"));
    ledger = addCost(ledger, 2.75, at("2026-10-13T09:00:00"));
    expect(ledger).toEqual({
      lastTotalUsd: 2.75,
      days: { "2026-10-12": 2, "2026-10-13": 0.75 },
    });
    // A restored session's process counts from zero again: all of it is new,
    // and nothing booked before is lost or counted twice.
    ledger = addCost(ledger, 0.5, at("2026-10-13T11:00:00"));
    expect(ledger.days["2026-10-13"]).toBeCloseTo(1.25);
    expect(ledger.lastTotalUsd).toBe(0.5);
  });

  test("drops days the footer no longer looks at", () => {
    const ledger = addCost(
      { lastTotalUsd: 1, days: { "2026-01-01": 1, "2026-10-01": 2 } },
      1,
      at("2026-10-13T09:00:00"),
    );
    expect(ledger.days).toEqual({ "2026-10-01": 2 });
  });

  test("adds up today and this month across sessions", () => {
    const now = at("2026-10-13T12:00:00");
    expect(
      costTotals(
        [
          { lastTotalUsd: 0, days: { "2026-10-13": 1, "2026-10-02": 2 } },
          { lastTotalUsd: 0, days: { "2026-10-13": 0.5, "2026-09-30": 9 } },
        ],
        now,
      ),
    ).toEqual({ todayUsd: 1.5, monthUsd: 3.5 });
  });

  test("the status-line hook's bookings are read back by session", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const now = new Date();
      await recordSessionCost(home, "session-a", 0.4, now);
      await recordSessionCost(home, "session-a", 1.1, now);
      await recordSessionCost(home, "session-b", Number.NaN, now);
      const ledgers = await readCostLedgers(home, now);
      expect([...ledgers.keys()]).toEqual(["session-a"]);
      expect(ledgers.get("session-a")?.days[localDay(now)]).toBeCloseTo(1.1);
    });
  });
});
