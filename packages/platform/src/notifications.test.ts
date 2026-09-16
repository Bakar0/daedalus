import { describe, expect, test } from "vitest";
import {
  appleScriptLiteral,
  osascriptArguments,
  parseHidIdleNanoseconds,
  sendNativeNotification,
  systemIdleSeconds,
  terminalNotifierArguments,
} from "./notifications";

const ok = { exitCode: 0, stdout: "", stderr: "" };

describe("native notifications", () => {
  test("attaches a click command so an alert can open the right session", () => {
    const args = terminalNotifierArguments({
      title: "Daedalus · Claude · #11",
      body: "Claude needs permission: Bash(git push)",
      activate: { executable: "daedal", args: ["focus", "session-1"] },
      bundleId: "dev.daedalus.app",
    });
    expect(args.slice(0, 4)).toEqual([
      "-title",
      "Daedalus · Claude · #11",
      "-message",
      "Claude needs permission: Bash(git push)",
    ]);
    expect(args).toContain("-execute");
    expect(args.at(-1)).toBe("'daedal' 'focus' 'session-1'");
  });

  test("escapes AppleScript literals rather than interpolating them raw", () => {
    expect(appleScriptLiteral('say "hi" \\ bye')).toBe(
      '"say \\"hi\\" \\\\ bye"',
    );
    const args = osascriptArguments({
      title: 'A "quoted" title',
      body: "body",
    });
    expect(args[0]).toBe("-e");
    expect(args[1]).toContain('\\"quoted\\"');
  });

  test("prefers the app's own notifier over AppleScript", async () => {
    const shown: string[] = [];
    const result = await sendNativeNotification(
      { title: "Daedalus · Claude", body: "b" },
      {
        run: async () => ok,
        locate: () => undefined,
        showInApp: (notification) => shown.push(notification.title),
      },
    );
    expect(shown).toEqual(["Daedalus · Claude"]);
    // Attributed to Daedalus, but clicking it can only raise the app.
    expect(result).toEqual({
      delivered: true,
      backend: "app",
      degraded: true,
    });
  });

  test("falls back to osascript and reports that it cannot be clicked", async () => {
    const calls: string[] = [];
    const result = await sendNativeNotification(
      { title: "t", body: "b" },
      {
        run: async (executable: string) => {
          calls.push(executable);
          return ok;
        },
        locate: (executable: string) =>
          executable === "osascript" ? "/usr/bin/osascript" : undefined,
      },
    );
    expect(calls).toEqual(["/usr/bin/osascript"]);
    expect(result).toEqual({
      delivered: true,
      backend: "osascript",
      degraded: true,
    });
  });

  test("reports failure when no notifier exists at all", async () => {
    const result = await sendNativeNotification(
      { title: "t", body: "b" },
      { run: async () => ok, locate: () => undefined },
    );
    expect(result.delivered).toBe(false);
    expect(result.backend).toBe("none");
  });
});

describe("system idle time", () => {
  test("takes the busiest device, because any input means the user is here", () => {
    expect(
      parseHidIdleNanoseconds(
        '"HIDIdleTime" = 900000000000\n"HIDIdleTime" = 4000000000',
      ),
    ).toBe(4_000_000_000);
    expect(parseHidIdleNanoseconds("nothing here")).toBeUndefined();
  });

  test("an unreadable idle time reads as present, never as away", async () => {
    expect(
      await systemIdleSeconds(
        async () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
        () => "/usr/sbin/ioreg",
      ),
    ).toBe(0);
    expect(
      await systemIdleSeconds(
        async () => ok,
        () => undefined,
      ),
    ).toBe(0);
    expect(
      await systemIdleSeconds(
        async () => ({
          exitCode: 0,
          stdout: '"HIDIdleTime" = 420000000000',
          stderr: "",
        }),
        () => "/usr/sbin/ioreg",
      ),
    ).toBe(420);
  });
});
