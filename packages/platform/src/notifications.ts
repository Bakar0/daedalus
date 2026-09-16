import {
  findExecutable,
  runCommand,
  standardExecutableFallbacks,
  type CommandResult,
} from "./process";

/**
 * Executables are passed as arrays and never interpolated into a shell string,
 * so a reason containing quotes or backticks is inert. AppleScript is the one
 * exception in spirit — `osascript -e` takes a script — so the two strings it
 * embeds are escaped for AppleScript literals below.
 */
export interface NativeNotification {
  title: string;
  /** Second line: workspace, session, and task number when task-backed. */
  subtitle?: string;
  body: string;
  /**
   * Command run when the user clicks the notification. Only `terminal-notifier`
   * can honour it; the AppleScript fallback has nowhere to attach a click.
   */
  activate?: { executable: string; args: string[] };
  /** Bundle identifier raised on click, when the notifier supports it. */
  bundleId?: string;
}

export interface NativeNotifierResult {
  delivered: boolean;
  /** Which backend handled it, for honest reporting up the stack. */
  backend: "terminal-notifier" | "app" | "osascript" | "none";
  /** True when the backend cannot make the notification clickable. */
  degraded: boolean;
}

export interface NativeNotifierOptions {
  run?: (executable: string, args: string[]) => Promise<CommandResult>;
  locate?: (executable: string, fallbacks?: string[]) => string | undefined;
  /**
   * The host app's own notification call, when the caller *is* the app. It is
   * correctly attributed and needs nothing installed, but it cannot carry a
   * click action, so it ranks below `terminal-notifier` and above AppleScript.
   */
  showInApp?: (notification: NativeNotification) => void;
}

/** AppleScript string literals escape only the backslash and the quote. */
export const appleScriptLiteral = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function terminalNotifierArguments(
  notification: NativeNotification,
): string[] {
  const args = [
    "-title",
    notification.title,
    "-message",
    notification.body,
    ...(notification.subtitle ? ["-subtitle", notification.subtitle] : []),
    ...(notification.bundleId ? ["-sender", notification.bundleId] : []),
  ];
  // `-execute` wins over `-activate`: the command re-raises the app itself and
  // additionally selects the session, which plain activation cannot do.
  if (notification.activate)
    args.push(
      "-execute",
      [notification.activate.executable, ...notification.activate.args]
        .map((part) => `'${part.replace(/'/g, `'\\''`)}'`)
        .join(" "),
    );
  else if (notification.bundleId) args.push("-activate", notification.bundleId);
  return args;
}

export function osascriptArguments(notification: NativeNotification): string[] {
  const parts = [
    `display notification ${appleScriptLiteral(notification.body)}`,
    `with title ${appleScriptLiteral(notification.title)}`,
  ];
  if (notification.subtitle)
    parts.push(`subtitle ${appleScriptLiteral(notification.subtitle)}`);
  return ["-e", parts.join(" ")];
}

/**
 * Sends a macOS notification down a three-tier ladder, each tier honest about
 * what it gives up:
 *
 * 1. `terminal-notifier` — the only widely available way to attach a *click
 *    action*, so an alert can open the session it is about.
 * 2. the host app's own notifier — correctly attributed to Daedalus and needs
 *    nothing installed, but clicking only raises the app.
 * 3. AppleScript — always available, attributed to Script Editor, no click
 *    target at all.
 *
 * `degraded` reports which of those the caller actually got.
 */
export async function sendNativeNotification(
  notification: NativeNotification,
  options: NativeNotifierOptions = {},
): Promise<NativeNotifierResult> {
  const run = options.run ?? runCommand;
  const locate = options.locate ?? findExecutable;
  const notifier = locate(
    "terminal-notifier",
    standardExecutableFallbacks("terminal-notifier"),
  );
  if (notifier) {
    const result = await run(notifier, terminalNotifierArguments(notification));
    if (result.exitCode === 0)
      return {
        delivered: true,
        backend: "terminal-notifier",
        degraded: false,
      };
  }
  if (options.showInApp) {
    options.showInApp(notification);
    return { delivered: true, backend: "app", degraded: true };
  }
  const osascript = locate(
    "osascript",
    standardExecutableFallbacks("osascript"),
  );
  if (!osascript) return { delivered: false, backend: "none", degraded: true };
  const result = await run(osascript, osascriptArguments(notification));
  return {
    delivered: result.exitCode === 0,
    backend: "osascript",
    degraded: true,
  };
}

/**
 * Seconds since the last keyboard or pointer event, read from the IOKit HID
 * system. `ioreg` reports the idle time in nanoseconds on the primary HID
 * device; the smallest value across devices is the one that matters, because
 * any single device being used means the user is present.
 */
export function parseHidIdleNanoseconds(output: string): number | undefined {
  const matches = [...output.matchAll(/"HIDIdleTime"\s*=\s*(\d+)/g)].map(
    (match) => Number(match[1]),
  );
  const values = matches.filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : undefined;
}

export async function systemIdleSeconds(
  run: (
    executable: string,
    args: string[],
  ) => Promise<CommandResult> = runCommand,
  locate: (
    executable: string,
    fallbacks?: string[],
  ) => string | undefined = findExecutable,
): Promise<number> {
  // `ioreg` lives in /usr/sbin, which the standard list deliberately omits.
  const ioreg = locate("ioreg", [
    "/usr/sbin/ioreg",
    ...standardExecutableFallbacks("ioreg"),
  ]);
  if (!ioreg) return 0;
  try {
    const result = await run(ioreg, ["-c", "IOHIDSystem", "-d", "4", "-r"]);
    if (result.exitCode !== 0) return 0;
    const nanoseconds = parseHidIdleNanoseconds(result.stdout);
    // An unreadable idle time must read as "present", never as "away": the
    // expensive mistake is a desktop notification for someone sitting there.
    return nanoseconds === undefined ? 0 : Math.floor(nanoseconds / 1e9);
  } catch {
    return 0;
  }
}
