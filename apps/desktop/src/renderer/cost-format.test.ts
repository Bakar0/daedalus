import { describe, expect, test } from "vitest";
import {
  accountCostLabel,
  accountCostTitle,
  spendOfLimit,
  usdLabel,
} from "./cost-format";

describe("cost labels", () => {
  test("say they are estimates, at a precision worth reading", () => {
    expect(usdLabel(0)).toBe("~$0.00");
    expect(usdLabel(0.004)).toBe("<$0.01");
    expect(usdLabel(4.2)).toBe("~$4.20");
    expect(usdLabel(1234.4)).toBe("~$1,234");
  });

  test("per-use billing shows today; Enterprise credits show the month", () => {
    const cost = { todayUsd: 4.2, monthUsd: 61.5 };
    expect(accountCostLabel("usage", cost)).toBe("~$4.20 today");
    expect(accountCostLabel("credits", cost)).toBe("~$61.50 this month");
    expect(accountCostLabel("credits")).toBe("–");
    expect(accountCostTitle("usage", cost)).toContain(
      "Today ~$4.20 · this month ~$61.50",
    );
    expect(accountCostTitle("credits")).toContain("/usage in Claude");
  });

  test("a spend limit reads as dollars of dollars", () => {
    expect(spendOfLimit(385.17, 3300)).toBe("$385 of $3,300");
  });
});
