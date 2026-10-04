import { describe, expect, test } from "vitest";
import { cliShimContents } from "./cli-shim";

describe("bundled CLI shim", () => {
  test("launches the CLI with Bun instead of the long-lived desktop runtime", () => {
    expect(
      cliShimContents(
        "/opt/homebrew/bin/bun",
        "/Applications/Daedalus.app/Contents/Resources/app/cli/daedal.js",
      ),
    ).toBe(
      "#!/bin/sh\nexec '/opt/homebrew/bin/bun' '/Applications/Daedalus.app/Contents/Resources/app/cli/daedal.js' \"$@\"\n",
    );
  });

  test("pins its own home, whatever DAEDALUS_HOME it inherits", () => {
    expect(
      cliShimContents("/bun", "/app/cli/daedal.js", "/Users/me/.daedalus-dev"),
    ).toBe(
      "#!/bin/sh\nDAEDALUS_HOME='/Users/me/.daedalus-dev' exec '/bun' '/app/cli/daedal.js' \"$@\"\n",
    );
  });

  test("quotes paths without allowing shell interpolation", () => {
    expect(cliShimContents("/tmp/bun's", "/tmp/app's/cli.js")).toContain(
      "'/tmp/bun'\\''s' '/tmp/app'\\''s/cli.js'",
    );
  });
});
