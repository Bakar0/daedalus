import { writeFileAtomic } from "@daedalus/platform";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What one Claude session has cost, day by day, as Claude Code estimates it.
 *
 * Claude's status line reports `cost.total_cost_usd`: the token counts of
 * every response priced at Claude Code's built-in list prices. It is a total
 * for the running process, so it starts again from zero when the session is
 * restored or revived. The ledger keeps the last total it saw and books only
 * what was added since, on the day it was added, so a restart neither loses
 * the earlier spend nor counts it twice.
 */
export interface CostLedger {
  lastTotalUsd: number;
  /** Local calendar day (YYYY-MM-DD) to dollars added that day. */
  days: Record<string, number>;
}

/** Days older than this are dropped: the footer shows today and this month. */
const KEEP_DAYS = 62;

/** The Mac's local calendar day, which is what "today" means to the user. */
export function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Books a new running total. A total lower than the last one means the
 * process started again, so all of it is new.
 */
export function addCost(
  ledger: CostLedger | undefined,
  totalUsd: number,
  now: Date,
): CostLedger {
  const last = ledger?.lastTotalUsd ?? 0;
  const added = totalUsd >= last ? totalUsd - last : totalUsd;
  const today = localDay(now);
  const oldest = localDay(new Date(now.getTime() - KEEP_DAYS * 86_400_000));
  const days: Record<string, number> = {};
  for (const [day, usd] of Object.entries(ledger?.days ?? {}))
    if (day >= oldest) days[day] = usd;
  if (added > 0) days[today] = (days[today] ?? 0) + added;
  return { lastTotalUsd: totalUsd, days };
}

export const costLedgerDirectory = (home: string): string =>
  join(home, "telemetry", "cost");

const isLedger = (value: unknown): value is CostLedger =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as CostLedger).lastTotalUsd === "number" &&
  typeof (value as CostLedger).days === "object" &&
  (value as CostLedger).days !== null;

async function readLedger(path: string): Promise<CostLedger | undefined> {
  try {
    const value = (await Bun.file(path).json()) as unknown;
    return isLedger(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Books one status-line reading. Called from the status-line hook, so it
 * must stay quick and must never throw into Claude.
 */
export async function recordSessionCost(
  home: string,
  sessionId: string,
  totalUsd: number,
  now = new Date(),
): Promise<void> {
  if (!Number.isFinite(totalUsd) || totalUsd < 0) return;
  const directory = costLedgerDirectory(home);
  const path = join(directory, `${sessionId}.json`);
  const ledger = addCost(await readLedger(path), totalUsd, now);
  await writeFileAtomic(path, JSON.stringify(ledger), {
    mode: 0o600,
    ensureDir: true,
  });
}

/**
 * Every session's ledger, by session id. A ledger untouched for longer than
 * the footer looks back is deleted rather than read again.
 */
export async function readCostLedgers(
  home: string,
  now = new Date(),
): Promise<Map<string, CostLedger>> {
  const directory = costLedgerDirectory(home);
  const ledgers = new Map<string, CostLedger>();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return ledgers;
  }
  await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const path = join(directory, name);
        if (
          now.getTime() - Bun.file(path).lastModified >
          KEEP_DAYS * 86_400_000
        ) {
          await rm(path, { force: true }).catch(() => undefined);
          return;
        }
        const ledger = await readLedger(path);
        if (ledger) ledgers.set(name.slice(0, -".json".length), ledger);
      }),
  );
  return ledgers;
}

/** Today's and this month's spend across some ledgers. */
export function costTotals(
  ledgers: Iterable<CostLedger>,
  now: Date,
): { todayUsd: number; monthUsd: number } {
  const today = localDay(now);
  const month = today.slice(0, 7);
  let todayUsd = 0;
  let monthUsd = 0;
  for (const ledger of ledgers)
    for (const [day, usd] of Object.entries(ledger.days)) {
      if (day === today) todayUsd += usd;
      if (day.startsWith(month)) monthUsd += usd;
    }
  return { todayUsd, monthUsd };
}
