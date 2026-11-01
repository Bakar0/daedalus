import type { RoutineSchedule } from "../domain";
import { DaedalusError } from "../errors";

/**
 * Routine schedules: the stored text (`every 30m`, `cron "…"`, `at …`), when
 * a routine is next due, and the plain words a user types for one.
 */

const ROUTINE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MIN_EVERY_MS = 60_000;

export function routineName(value: string): string {
  const name = value.trim();
  if (!ROUTINE_NAME.test(name))
    throw new DaedalusError(
      "VALIDATION",
      "A routine name uses lowercase letters, digits and dashes, and starts with a letter or digit",
    );
  return name;
}

/** `90s`, `10m`, `2h`, `1d`. */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(value.trim());
  if (!match)
    throw new DaedalusError(
      "VALIDATION",
      `'${value}' is not a duration; use a number and s, m, h or d, such as 10m`,
    );
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as "s" | "m" | "h" | "d"
  ];
  return Number(match[1]) * unit;
}

/** A timestamp as local `YYYY-MM-DD HH:MM`, or a dash when there is none. */
export function localTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A local date and time, `2026-09-30T15:40` or `2026-09-30 15:40`, read in
 * the machine's time zone the way the user wrote it. An explicit offset or
 * `Z` is honoured.
 */
export function parseLocalDateTime(value: string): Date {
  const text = value.trim().replace(" ", "T");
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    text,
  );
  const date = local
    ? new Date(
        Number(local[1]),
        Number(local[2]) - 1,
        Number(local[3]),
        Number(local[4]),
        Number(local[5]),
        Number(local[6] ?? 0),
      )
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(
          text,
        )
      ? new Date(text)
      : new Date(Number.NaN);
  if (Number.isNaN(date.getTime()))
    throw new DaedalusError(
      "VALIDATION",
      `'${value}' is not a date and time; use 2026-09-30T15:40`,
    );
  return date;
}

/* -------------------------------------------------------------------------- */
/* Cron                                                                        */
/* -------------------------------------------------------------------------- */

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Cron's own rule: with both restricted, either day field matches. */
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

function cronField(
  text: string,
  minimum: number,
  maximum: number,
  label: string,
): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    let start: number;
    let end: number;
    if (range === "*") {
      start = minimum;
      end = maximum;
    } else if (range && /^\d+-\d+$/.test(range)) {
      [start, end] = range.split("-").map(Number) as [number, number];
    } else if (range && /^\d+$/.test(range)) {
      start = Number(range);
      end = stepText === undefined ? start : maximum;
    } else {
      throw new DaedalusError(
        "VALIDATION",
        `Cron ${label} '${text}' is not valid`,
      );
    }
    if (
      !Number.isInteger(step) ||
      step < 1 ||
      start < minimum ||
      end > maximum ||
      start > end
    )
      throw new DaedalusError(
        "VALIDATION",
        `Cron ${label} '${text}' is out of range ${minimum}-${maximum}`,
      );
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new DaedalusError(
      "VALIDATION",
      `Cron '${expression}' needs five fields: minute hour day month weekday`,
    );
  const [minute, hour, day, month, weekday] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const weekdays = cronField(weekday, 0, 7, "weekday");
  // 7 is Sunday too.
  if (weekdays.delete(7)) weekdays.add(0);
  return {
    minutes: cronField(minute, 0, 59, "minute"),
    hours: cronField(hour, 0, 23, "hour"),
    days: cronField(day, 1, 31, "day"),
    months: cronField(month, 1, 12, "month"),
    weekdays,
    dayRestricted: day !== "*",
    weekdayRestricted: weekday !== "*",
  };
}

/** The first minute strictly after `after` that the expression matches. */
export function nextCronTime(expression: string, after: Date): Date {
  const fields = parseCron(expression);
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  // Five years of minutes is far more than any valid expression needs; an
  // expression such as 31 February matches nothing and ends here.
  const limit = after.getTime() + 5 * 366 * 86_400_000;
  while (candidate.getTime() <= limit) {
    if (!fields.months.has(candidate.getMonth() + 1)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0);
      continue;
    }
    const dayMatches = fields.days.has(candidate.getDate());
    const weekdayMatches = fields.weekdays.has(candidate.getDay());
    const dateMatches =
      fields.dayRestricted && fields.weekdayRestricted
        ? dayMatches || weekdayMatches
        : dayMatches && weekdayMatches;
    if (!dateMatches) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0);
      continue;
    }
    if (!fields.hours.has(candidate.getHours())) {
      candidate.setHours(candidate.getHours() + 1, 0);
      continue;
    }
    if (!fields.minutes.has(candidate.getMinutes())) {
      candidate.setMinutes(candidate.getMinutes() + 1);
      continue;
    }
    return candidate;
  }
  throw new DaedalusError(
    "VALIDATION",
    `Cron '${expression}' never matches a real date`,
  );
}

/* -------------------------------------------------------------------------- */
/* Schedules                                                                   */
/* -------------------------------------------------------------------------- */

export function parseSchedule(value: string): RoutineSchedule {
  const text = value.trim();
  const every = /^every\s+(\S+)$/.exec(text);
  if (every) {
    const everyMs = parseDuration(every[1]!);
    if (everyMs < MIN_EVERY_MS)
      throw new DaedalusError(
        "VALIDATION",
        "A routine runs at most once a minute",
      );
    return { kind: "every", everyMs, text };
  }
  const cron = /^cron\s+(?:"([^"]*)"|'([^']*)'|(.+))$/.exec(text);
  if (cron) {
    const expression = (cron[1] ?? cron[2] ?? cron[3] ?? "").trim();
    parseCron(expression);
    return { kind: "cron", expression, text };
  }
  const at = /^at\s+(.+)$/.exec(text);
  if (at)
    return {
      kind: "at",
      at: parseLocalDateTime(at[1]!).toISOString(),
      text,
    };
  throw new DaedalusError(
    "VALIDATION",
    `Schedule '${value}' is not one of: every <n>m|h, cron "<5 fields>", at <date and time>`,
  );
}

/**
 * When a routine is next due after `from`. A new `every` routine is due
 * right away; after that it is due one interval after its last run, never
 * before now, so an app that was closed for a day fires once, not once per
 * missed slot. An `at` routine that has already run is due never.
 */
export function nextRunTime(
  schedule: RoutineSchedule,
  input: { now: Date; lastRunAt: string | null },
): Date | null {
  switch (schedule.kind) {
    case "every":
      return input.lastRunAt
        ? new Date(Date.parse(input.lastRunAt) + schedule.everyMs)
        : input.now;
    case "cron":
      // After the last run, so a slot missed while the app was closed is
      // overdue and fires once; a new routine waits for its first slot.
      return nextCronTime(
        schedule.expression,
        input.lastRunAt ? new Date(input.lastRunAt) : input.now,
      );
    case "at":
      return input.lastRunAt ? null : new Date(schedule.at);
  }
}

/* -------------------------------------------------------------------------- */
/* Plain words                                                                 */
/* -------------------------------------------------------------------------- */

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_PLURALS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];
const DAY_WORDS: Array<[RegExp, number]> = [
  [/^sun(day)?s?$/, 0],
  [/^mon(day)?s?$/, 1],
  [/^tue(s|sday)?s?$/, 2],
  [/^wed(nesday)?s?$/, 3],
  [/^thu(r|rs|rsday)?s?$/, 4],
  [/^fri(day)?s?$/, 5],
  [/^sat(urday)?s?$/, 6],
];

const dayNumber = (word: string): number | undefined =>
  DAY_WORDS.find(([pattern]) => pattern.test(word))?.[1];

/**
 * Reads when a routine runs, as the user typed it, into the stored schedule
 * text. Takes the stored forms as they are (`every 30m`, `cron "…"`, `at …`)
 * and plain words: "weekdays 9:00", "every day at 19:00", "fridays 9",
 * "sun to thu at 8, 10, 13, 16", "hourly".
 */
export function parseWhen(value: string): string {
  const text = value.trim();
  if (/^(every\s+\d|cron\s|at\s)/i.test(text)) {
    parseSchedule(text);
    return text;
  }
  const lower = text.toLowerCase().replace(/\s+/g, " ");
  if (lower === "hourly" || lower === "every hour") return 'cron "0 * * * *"';
  const timeMatch = /(?:at )?((?:\d{1,2}(?::\d{2})?(?:, ?| and )?)+)\s*$/.exec(
    lower,
  );
  if (!timeMatch)
    throw new DaedalusError(
      "VALIDATION",
      `Add a time to '${value}', such as "weekdays 9:00" or "every day at 19:00"`,
    );
  const times = timeMatch[1]!
    .split(/, ?| and /)
    .filter(Boolean)
    .map((part) => {
      const [hour, minute = "0"] = part.split(":");
      return { hour: Number(hour), minute: Number(minute) };
    });
  if (
    times.some(
      (time) =>
        time.hour > 23 ||
        time.minute > 59 ||
        Number.isNaN(time.hour + time.minute),
    )
  )
    throw new DaedalusError(
      "VALIDATION",
      `'${value}' has a time that does not exist`,
    );
  const minutes = new Set(times.map((time) => time.minute));
  if (minutes.size > 1)
    throw new DaedalusError(
      "VALIDATION",
      "Times on one schedule must share their minutes, such as 8:30 and 13:30",
    );
  const daysText = lower
    .slice(0, timeMatch.index)
    .replace(/\b(every|on|at)\b/g, " ")
    .trim();
  let weekdays = "*";
  if (/^(day|days|daily)?$/.test(daysText)) weekdays = "*";
  else if (/^weekdays?$/.test(daysText)) weekdays = "1-5";
  else if (/^weekends?$/.test(daysText)) weekdays = "0,6";
  else {
    const range = /^(\w+) (?:to|-) (\w+)$/.exec(daysText);
    if (range) {
      const from = dayNumber(range[1]!);
      const to = dayNumber(range[2]!);
      if (from === undefined || to === undefined)
        throw new DaedalusError(
          "VALIDATION",
          `Cannot read the days in '${value}'`,
        );
      weekdays = `${from}-${to}`;
    } else {
      const days = daysText
        .split(/, ?| and | /)
        .filter(Boolean)
        .map(dayNumber);
      if (!days.length || days.some((day) => day === undefined))
        throw new DaedalusError(
          "VALIDATION",
          `Cannot read the days in '${value}'`,
        );
      weekdays = days.join(",");
    }
  }
  const expression = `${times[0]!.minute} ${times.map((time) => time.hour).join(",")} * * ${weekdays}`;
  const stored = `cron "${expression}"`;
  parseSchedule(stored);
  return stored;
}

const pad = (value: number): string => String(value).padStart(2, "0");

function describeDays(field: string): string | undefined {
  if (field === "*") return "Every day";
  if (field === "1-5") return "Weekdays";
  if (field === "0,6" || field === "6,0") return "Weekends";
  const range = /^(\d)-(\d)$/.exec(field);
  if (range)
    return `${DAY_NAMES[Number(range[1])]} to ${DAY_NAMES[Number(range[2])]}`;
  if (/^\d(,\d)*$/.test(field)) {
    const days = field.split(",").map((day) => Number(day) % 7);
    return days.length === 1
      ? DAY_PLURALS[days[0]!]
      : days.map((day) => DAY_NAMES[day]).join(", ");
  }
  return undefined;
}

/**
 * A stored schedule in words for the Routines table, such as "Sun to Thu at
 * 8:00, 10:00, 13:00, 16:00". Falls back to the stored text when the
 * expression has no short reading.
 */
export function describeSchedule(stored: string): string {
  const schedule = parseSchedule(stored);
  if (schedule.kind === "at")
    return `Once, ${new Date(schedule.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`;
  if (schedule.kind === "every") {
    const minutes = schedule.everyMs / 60_000;
    return minutes % 60 === 0
      ? `Every ${minutes / 60 === 1 ? "hour" : `${minutes / 60} hours`}`
      : `Every ${minutes} min`;
  }
  const [minute, hour, day, month, weekday] = schedule.expression.split(/\s+/);
  if (day !== "*" || month !== "*" || !/^\d+$/.test(minute ?? ""))
    return stored;
  const days = describeDays(weekday!);
  if (!days) return stored;
  if (hour === "*") return `${days}, every hour at :${pad(Number(minute))}`;
  if (!/^\d+(,\d+)*$/.test(hour ?? "")) return stored;
  const times = hour!
    .split(",")
    .map((value) => `${pad(Number(value))}:${pad(Number(minute))}`);
  return `${days} at ${times.join(", ")}`;
}
