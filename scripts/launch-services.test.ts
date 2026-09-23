import { describe, expect, test } from "vitest";
import { parseRegistrations, staleRegistrations } from "./launch-services";

const SEPARATOR = "-".repeat(80);

const record = (path: string, identifier: string) =>
  [
    "bundle id:                  Daedalus (0x3b50)",
    `path:                       ${path} (0x5aa4)`,
    "name:                       Daedalus",
    `identifier:                 ${identifier}`,
    "infoDictionary:             7 values (88028 (0x157dc))",
    "                            {",
    `                                CFBundleIdentifier = "${identifier}";`,
    "                            }",
  ].join("\n");

const dump = [
  "Checking data integrity......done.",
  record("/Users/me/Applications/Daedalus.app", "dev.daedalus.app"),
  record(
    "/Users/me/worktrees/a b/daedalus/build/stable-macos-arm64/Daedalus.app",
    "dev.daedalus.app",
  ),
  record(
    "/Users/me/worktrees/c/daedalus/build/dev-macos-arm64/Daedalus-dev.app",
    "dev.daedalus.app.dev",
  ),
  "claim id:                   Web page (0x1234)\nrank:  Default",
].join(`\n${SEPARATOR}\n`);

describe("Launch Services registrations", () => {
  test("reads each bundle's path and identifier, spaces included", () => {
    expect(parseRegistrations(dump)).toEqual([
      {
        path: "/Users/me/Applications/Daedalus.app",
        identifier: "dev.daedalus.app",
      },
      {
        path: "/Users/me/worktrees/a b/daedalus/build/stable-macos-arm64/Daedalus.app",
        identifier: "dev.daedalus.app",
      },
      {
        path: "/Users/me/worktrees/c/daedalus/build/dev-macos-arm64/Daedalus-dev.app",
        identifier: "dev.daedalus.app.dev",
      },
    ]);
  });

  test("lists other copies of the identifier and leaves other channels alone", () => {
    expect(
      staleRegistrations(
        dump,
        "dev.daedalus.app",
        "/Users/me/Applications/Daedalus.app",
      ),
    ).toEqual([
      "/Users/me/worktrees/a b/daedalus/build/stable-macos-arm64/Daedalus.app",
    ]);
  });
});
