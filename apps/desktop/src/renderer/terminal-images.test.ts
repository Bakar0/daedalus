import { describe, expect, test } from "bun:test";
import {
  fileBase64,
  pastedImagePaths,
  shellQuote,
  transferImages,
} from "./terminal-images";

const transfer = (files: File[], text = "") => ({
  files,
  getData: (format: string) => (format === "text/plain" ? text : ""),
});
const png = new File([new Uint8Array([137, 80, 78, 71])], "image.png", {
  type: "image/png",
});
const pdf = new File(["%PDF"], "notes.pdf", { type: "application/pdf" });

describe("transferImages", () => {
  test("a paste of only a screenshot is an image", () => {
    expect(transferImages(transfer([png]), "paste")).toEqual([png]);
  });

  test("a paste with text in it is left to the terminal", () => {
    expect(transferImages(transfer([png], "caption"), "paste")).toEqual([]);
  });

  test("a drop keeps its images and skips other files", () => {
    expect(transferImages(transfer([pdf, png], "x"), "drop")).toEqual([png]);
  });

  test("an image type the agents cannot read is left to the terminal", () => {
    const tiff = new File(["II*"], "scan.tiff", { type: "image/tiff" });
    expect(transferImages(transfer([tiff]), "paste")).toEqual([]);
  });
});

describe("shellQuote", () => {
  test("a plain path is left as it is", () => {
    expect(shellQuote("/var/folders/ab/T/x/image.png")).toBe(
      "/var/folders/ab/T/x/image.png",
    );
  });

  test("spaces and quotes are quoted", () => {
    expect(shellQuote("/tmp/Screen Shot's.png")).toBe(
      `'/tmp/Screen Shot'\\''s.png'`,
    );
  });
});

test("several images paste as their paths a space apart", () => {
  expect(pastedImagePaths(["/tmp/a.png", "/tmp/b c.png"])).toBe(
    "/tmp/a.png '/tmp/b c.png'",
  );
});

test("fileBase64 encodes a file's bytes", async () => {
  expect(await fileBase64(png)).toBe(btoa("\x89PNG"));
});
