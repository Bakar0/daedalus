import { describe, expect, test } from "vitest";
import { highestBeta } from "./beta-feed";

const beta = (tagName: string) => ({ tagName, isPrerelease: true });
const stable = (tagName: string) => ({ tagName, isPrerelease: false });

describe("highestBeta", () => {
  test("takes the highest beta by version, not by list order", () => {
    expect(
      highestBeta([
        beta("v0.32.0-beta.2"),
        beta("v0.32.0-beta.10"),
        stable("v0.31.0"),
        beta("v0.32.0-beta.9"),
      ]),
    ).toBe("v0.32.0-beta.10");
  });

  test("ignores stable releases and the feed release itself", () => {
    expect(
      highestBeta([stable("v0.33.0"), beta("beta"), beta("v0.32.0-beta.1")]),
    ).toBe("v0.32.0-beta.1");
    expect(highestBeta([stable("v0.31.0"), beta("beta")])).toBeUndefined();
  });

  test("ignores a prerelease whose tag is not a version", () => {
    expect(
      highestBeta([beta("v0.32.0-beta..1"), beta("nightly")]),
    ).toBeUndefined();
  });
});
