/**
 * Dollar amounts as Claude Code estimates them. Always shown with a tilde:
 * the estimate prices tokens at list prices, and the bill (AWS or Anthropic)
 * is the real figure.
 */
export function usdLabel(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  if (usd >= 100) return `~$${Math.round(usd).toLocaleString("en-US")}`;
  return `~$${usd.toFixed(2)}`;
}

/** A spend limit's dollars, as Claude reported them: "$385 of $3,300". */
export function spendOfLimit(usedUsd: number, limitUsd: number): string {
  const whole = (usd: number) => `$${Math.round(usd).toLocaleString("en-US")}`;
  return `${whole(usedUsd)} of ${whole(limitUsd)}`;
}

export const COST_ESTIMATE_NOTE =
  "Estimated by Claude Code from token counts at list prices, for sessions Daedalus ran. Your AWS or Anthropic bill is the real figure.";

type Billing = "usage" | "credits";
type Spend = { todayUsd: number; monthUsd: number };

/**
 * What the footer says for an account with no limit windows. Usage credits
 * are capped by the month, so that is the figure; per-use billing shows
 * today.
 */
export function accountCostLabel(billing: Billing, cost?: Spend): string {
  if (!cost) return "–";
  return billing === "credits"
    ? `${usdLabel(cost.monthUsd)} this month`
    : `${usdLabel(cost.todayUsd)} today`;
}

export function accountCostTitle(billing: Billing, cost?: Spend): string {
  const head =
    billing === "credits"
      ? "Claude Enterprise usage credits, spent at list prices against a monthly cap. Counts only sessions Daedalus ran; /usage in Claude shows your full spend and the cap."
      : "Billed per use, with no plan limits.";
  if (!cost)
    return `${head} Spend shows once a session on this account has replied.`;
  return `${head} Today ${usdLabel(cost.todayUsd)} · this month ${usdLabel(cost.monthUsd)}. ${COST_ESTIMATE_NOTE}`;
}
