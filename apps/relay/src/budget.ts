import { DurableObject } from "cloudflare:workers";
import { currentMonth, type Env } from "./util";

/**
 * A hard cap on what the relay can cost. Cloudflare has no spending limit
 * for Workers, Durable Objects or D1, only budget emails, so the relay keeps
 * its own month-to-date count of billable units in one Durable Object and
 * stops admitting connections once the estimated overage passes
 * `MONTHLY_BUDGET_USD`. See artifacts/remote-work/cost-analysis.md.
 */

export interface Units {
  /** Durable Object requests: connects, alarms, budget calls. */
  doRequests: number;
  /** Frames rooms forwarded; Cloudflare bills incoming ones 20 to 1. */
  frames: number;
  workerRequests: number;
}

const ZERO: Units = { doRequests: 0, frames: 0, workerRequests: 0 };

/** Workers Paid prices and included amounts, read 2026-10-10. */
const PRICES = {
  doRequestsIncluded: 1_000_000,
  doRequestPerMillion: 0.15,
  durationIncludedGbS: 400_000,
  durationPerMillionGbS: 12.5,
  workerRequestsIncluded: 10_000_000,
  workerRequestPerMillion: 0.3,
  /** Measured: a room is active about 1.45 ms per request, at 128 MB. */
  activeSecondsPerRequest: 0.00145,
  gb: 0.125,
};

/** Estimated spend beyond the plan's included amounts, in dollars. */
export function overageUsd(units: Units): number {
  const billedDo = units.doRequests + units.frames / 20;
  const gbS =
    (units.doRequests + units.frames) *
    PRICES.activeSecondsPerRequest *
    PRICES.gb;
  return (
    (Math.max(0, billedDo - PRICES.doRequestsIncluded) *
      PRICES.doRequestPerMillion) /
      1e6 +
    (Math.max(0, gbS - PRICES.durationIncludedGbS) *
      PRICES.durationPerMillionGbS) /
      1e6 +
    (Math.max(0, units.workerRequests - PRICES.workerRequestsIncluded) *
      PRICES.workerRequestPerMillion) /
      1e6
  );
}

export interface BudgetStatus {
  open: boolean;
  month: string;
  units: Units;
  overageUsd: number;
  budgetUsd: number;
  /** Set when closed by hand or by the watchdog rather than by the count. */
  closedBy: string | null;
}

export const budgetUsd = (env: Env): number => {
  const value = Number(env.MONTHLY_BUDGET_USD ?? "10");
  return Number.isFinite(value) && value >= 0 ? value : 10;
};

export const budget = (env: Env) =>
  env.BUDGET.get(env.BUDGET.idFromName("budget"));

export class Budget extends DurableObject<Env> {
  async #read(): Promise<{ units: Units; closedBy: string | null }> {
    const month = currentMonth();
    return {
      units: (await this.ctx.storage.get<Units>(`units:${month}`)) ?? ZERO,
      closedBy: (await this.ctx.storage.get<string>(`closed:${month}`)) ?? null,
    };
  }

  #status(units: Units, closedBy: string | null): BudgetStatus {
    const spent = overageUsd(units);
    const limit = budgetUsd(this.env);
    return {
      open: !closedBy && spent < limit,
      month: currentMonth(),
      units,
      overageUsd: spent,
      budgetUsd: limit,
      closedBy,
    };
  }

  /** Adds usage and says whether the relay is still open. */
  async add(delta: Partial<Units>): Promise<BudgetStatus> {
    const { units, closedBy } = await this.#read();
    const next: Units = {
      doRequests: units.doRequests + (delta.doRequests ?? 0) + 1,
      frames: units.frames + (delta.frames ?? 0),
      workerRequests: units.workerRequests + (delta.workerRequests ?? 0),
    };
    await this.ctx.storage.put(`units:${currentMonth()}`, next);
    return this.#status(next, closedBy);
  }

  async status(): Promise<BudgetStatus> {
    const { units, closedBy } = await this.#read();
    return this.#status(units, closedBy);
  }

  /** Closes the relay for the rest of the month, whatever the count says. */
  async close(by: string): Promise<BudgetStatus> {
    await this.ctx.storage.put(`closed:${currentMonth()}`, by);
    return this.status();
  }

  async reopen(): Promise<BudgetStatus> {
    await this.ctx.storage.delete(`closed:${currentMonth()}`);
    return this.status();
  }
}
