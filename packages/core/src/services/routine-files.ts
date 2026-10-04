import type {
  RoutineDefinition,
  RoutineOutput,
  RoutineSchedule,
} from "../domain";
import { DaedalusError } from "../errors";

/**
 * The text form of a routine: the schedule and limits in YAML frontmatter
 * and the prompt as the body. A session writes this to add a routine, and
 * `routine get --text` prints it back. Daedalus stores the parsed routine in
 * SQLite and knows nothing about what it checks; that is all in the body.
 */

const ROUTINE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MIN_EVERY_MS = 60_000;
const OUTPUTS: readonly RoutineOutput[] = ["task", "notify", "none"];

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

export function formatDuration(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48)
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** A duration as `parseDuration` reads it back, exactly. */
function durationText(milliseconds: number): string {
  if (milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000}h`;
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  return `${Math.round(milliseconds / 1_000)}s`;
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

/** `+60m` from now, or an absolute local date and time. */
export function parseUntil(value: string, now: Date): Date {
  const text = value.trim();
  return text.startsWith("+")
    ? new Date(now.getTime() + parseDuration(text.slice(1)))
    : parseLocalDateTime(text);
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
/* Files                                                                       */
/* -------------------------------------------------------------------------- */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const stringValue = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return undefined;
};

/**
 * Parses a routine's text. Throws a `VALIDATION` error that names the field.
 * `fallbackName` names a routine whose frontmatter has no `name`, such as
 * one read from a file named after it.
 */
export function parseRoutineFile(
  text: string,
  fallbackName?: string,
): RoutineDefinition {
  const match = FRONTMATTER.exec(text);
  if (!match)
    throw new DaedalusError(
      "VALIDATION",
      "A routine file starts with frontmatter between two '---' lines",
    );
  let data: unknown;
  try {
    data = Bun.YAML.parse(match[1]!);
  } catch (error) {
    throw new DaedalusError(
      "VALIDATION",
      `Frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new DaedalusError(
      "VALIDATION",
      "Frontmatter must be a set of fields",
    );
  const fields = data as Record<string, unknown>;
  const nameText = stringValue(fields.name) ?? fallbackName;
  if (!nameText)
    throw new DaedalusError("VALIDATION", "The 'name' field is required");
  const name = routineName(nameText);
  const scheduleText = stringValue(fields.schedule);
  if (!scheduleText)
    throw new DaedalusError("VALIDATION", "The 'schedule' field is required");
  const schedule = parseSchedule(scheduleText);
  const untilText = stringValue(fields.until);
  const until = untilText ? parseLocalDateTime(untilText).toISOString() : null;
  const timeoutText = stringValue(fields.timeout);
  const output = (stringValue(fields.output) ?? "none") as RoutineOutput;
  if (!OUTPUTS.includes(output))
    throw new DaedalusError(
      "VALIDATION",
      `'output' must be one of: ${OUTPUTS.join(", ")}`,
    );
  const enabled = fields.enabled === undefined ? true : fields.enabled;
  if (typeof enabled !== "boolean")
    throw new DaedalusError("VALIDATION", "'enabled' must be true or false");
  const vars: Record<string, string> = {};
  if (fields.vars !== undefined) {
    if (
      !fields.vars ||
      typeof fields.vars !== "object" ||
      Array.isArray(fields.vars)
    )
      throw new DaedalusError(
        "VALIDATION",
        "'vars' must be a set of name: value pairs",
      );
    for (const [key, value] of Object.entries(fields.vars)) {
      const text = stringValue(value);
      if (text === undefined)
        throw new DaedalusError(
          "VALIDATION",
          `Var '${key}' must be a single value`,
        );
      vars[key] = text;
    }
  }
  const body = match[2]!.trim();
  if (!body)
    throw new DaedalusError(
      "VALIDATION",
      "The routine has no prompt below its frontmatter",
    );
  return {
    name,
    schedule,
    until,
    model: stringValue(fields.model) ?? null,
    timeoutMs: timeoutText ? parseDuration(timeoutText) : DEFAULT_TIMEOUT_MS,
    output,
    enabled,
    vars,
    body,
  };
}

/** Quotes a scalar for frontmatter only when YAML would misread it bare. */
const yamlScalar = (value: string): string =>
  /^[\w./@#+-][\w ./@#:+-]*$/.test(value) && !/:\s|\s#|:$/.test(value)
    ? value
    : JSON.stringify(value);

/** Renders a routine back to its text form. */
export function renderRoutineFile(routine: RoutineDefinition): string {
  const lines = [
    "---",
    `name: ${routine.name}`,
    `schedule: ${yamlScalar(routine.schedule.text)}`,
    ...(routine.until ? [`until: ${routine.until}`] : []),
    ...(routine.model ? [`model: ${yamlScalar(routine.model)}`] : []),
    `timeout: ${durationText(routine.timeoutMs)}`,
    `output: ${routine.output}`,
    `enabled: ${routine.enabled}`,
    ...(Object.keys(routine.vars).length
      ? [
          "vars:",
          ...Object.entries(routine.vars).map(
            ([key, value]) => `  ${key}: ${yamlScalar(value)}`,
          ),
        ]
      : []),
    "---",
    routine.body.trim(),
    "",
  ];
  return lines.join("\n");
}

/**
 * Fills `{{name}}` from the routine's vars and Daedalus's own values. An
 * unknown name is left as it is, so a typo shows in the prompt rather than
 * silently becoming an empty string.
 */
export function fillPlaceholders(
  body: string,
  values: Record<string, string>,
): string {
  return body.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (whole, key: string) =>
    Object.hasOwn(values, key) ? values[key]! : whole,
  );
}
