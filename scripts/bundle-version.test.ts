import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bundleVersion, writeBundleVersion } from "./bundle-version";

describe("bundleVersion", () => {
  test("keeps a release and drops a beta's suffix", () => {
    expect(bundleVersion("0.31.0")).toBe("0.31.0");
    expect(bundleVersion("0.32.0-beta.1")).toBe("0.32.0");
    expect(bundleVersion("1.0.0-rc.2")).toBe("1.0.0");
  });

  test("refuses anything else", () => {
    expect(() => bundleVersion("0.32")).toThrow("Not a release version");
    expect(() => bundleVersion("v0.32.0")).toThrow("Not a release version");
  });

  test("writes both keys, adding the one Electrobun leaves out", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bundle-version-"));
    try {
      const plist = join(directory, "Info.plist");
      await Bun.write(
        plist,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleVersion</key><string>0.32.0-beta.1</string></dict></plist>
`,
      );
      expect(writeBundleVersion(plist, "0.32.0-beta.1")).toBe("0.32.0");
      const read = Bun.spawnSync([
        "plutil",
        "-convert",
        "json",
        "-o",
        "-",
        plist,
      ]);
      expect(JSON.parse(read.stdout.toString())).toEqual({
        CFBundleShortVersionString: "0.32.0",
        CFBundleVersion: "0.32.0",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
