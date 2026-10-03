/** "in 4m", "12m ago", "3h ago", "Mon 09:13": short enough for a row. */
export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  const delta = at - now;
  const minutes = Math.round(Math.abs(delta) / 60_000);
  if (minutes < 1) return delta >= 0 ? "now" : "just now";
  const span =
    minutes < 60
      ? `${minutes}m`
      : minutes < 48 * 60
        ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
        : undefined;
  if (span) return delta >= 0 ? `in ${span}` : `${span} ago`;
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function durationLabel(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
