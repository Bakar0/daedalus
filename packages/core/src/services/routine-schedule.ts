import { DaedalusError } from "../errors";
import { parseSchedule } from "./routine-files";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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
    const days = field.split(",").map((day) => DAY_NAMES[Number(day) % 7]!);
    return days.length === 1 ? `${days[0]}s` : days.join(", ");
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
