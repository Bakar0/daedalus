import { describe, expect, test } from "vitest";
import { caskSource } from "./homebrew-cask";

const sha256 = { arm64: "a".repeat(64), x64: "b".repeat(64) };

describe("caskSource", () => {
  test("describes both architectures of one release", () => {
    const cask = caskSource({ version: "0.9.0", sha256, notarized: true });
    expect(cask).toContain('version "0.9.0"');
    expect(cask).toContain(`arm:   "${sha256.arm64}"`);
    expect(cask).toContain(`intel: "${sha256.x64}"`);
    expect(cask).toContain(
      "releases/download/v#{version}/stable-macos-#{arch}-Daedalus.dmg",
    );
    expect(cask).toContain("auto_updates true");
    // Linked from inside the app, so `daedal` is on PATH after install.
    expect(cask).toContain(
      'binary "#{appdir}/Daedalus.app/Contents/Resources/bin/daedal"',
    );
  });

  test("only an unnotarized build is taken out of quarantine", () => {
    expect(
      caskSource({ version: "0.9.0", sha256, notarized: true }),
    ).not.toContain("com.apple.quarantine");
    expect(
      caskSource({ version: "0.9.0", sha256, notarized: false }),
    ).toContain("com.apple.quarantine");
  });

  test("never deletes the Daedalus home", () => {
    const cask = caskSource({ version: "0.9.0", sha256, notarized: false });
    expect(cask).not.toMatch(/"~\/\.daedalus/);
  });

  test("refuses values that would publish a broken cask", () => {
    expect(() =>
      caskSource({ version: "v0.9.0", sha256, notarized: true }),
    ).toThrow("Not a release version");
    expect(() =>
      caskSource({
        version: "0.9.0",
        sha256: { ...sha256, x64: "abc" },
        notarized: true,
      }),
    ).toThrow("Not a SHA-256 for x64");
  });
});
