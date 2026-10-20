import { describe, expect, test } from "vitest";
import { isAppTheme } from "./theme";
import { isLocalWebUrl } from "./WorkspaceApp";

describe("themes", () => {
  test("only Dark and Light are read back from storage", () => {
    expect(isAppTheme("light")).toBe(true);
    expect(isAppTheme("owl")).toBe(false);
    expect(isAppTheme(null)).toBe(false);
  });
});

describe("terminal links", () => {
  test("a page served from this Mac opens in a web tab", () => {
    expect(isLocalWebUrl("http://localhost:3000/checkout")).toBe(true);
    expect(isLocalWebUrl("http://127.0.0.1:5173")).toBe(true);
    expect(isLocalWebUrl("https://github.com/stablyai/orca")).toBe(false);
    expect(isLocalWebUrl("file:///tmp/a.html")).toBe(false);
    expect(isLocalWebUrl("not a url")).toBe(false);
  });
});
