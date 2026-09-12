import { describe, expect, test } from "vitest";
import { decodeControlOutput } from "./tmux";

describe("decodeControlOutput", () => {
  test("decodes tmux octal control bytes and keeps Unicode", () => {
    const decoded = new TextDecoder().decode(
      decodeControlOutput("\u001b[31mשלום \\015\\012"),
    );
    expect(decoded).toBe("\u001b[31mשלום \r\n");
  });
});
