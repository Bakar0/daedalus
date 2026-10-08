import { describe, expect, test } from "vitest";
import { SecretMasker } from "./secret-mask";

const run = (values: string[], chunks: string[]) => {
  const masker = new SecretMasker(values);
  const out = chunks.map((chunk) => masker.push(Buffer.from(chunk)));
  return Buffer.concat([...out, masker.flush()]).toString();
};

describe("SecretMasker", () => {
  test("replaces every occurrence of a value", () => {
    expect(run(["s3cret-token"], ["a s3cret-token b s3cret-token\n"])).toBe(
      "a *** b ***\n",
    );
  });

  test("masks a value split across chunks", () => {
    expect(run(["s3cret-token"], ["token=s3cr", "et-to", "ken done"])).toBe(
      "token=*** done",
    );
  });

  test("holds back only what could still start a value", () => {
    const masker = new SecretMasker(["s3cret-token"]);
    expect(masker.push(Buffer.from("plain output s3")).toString()).toBe(
      "plain output ",
    );
    expect(masker.push(Buffer.from("x")).toString()).toBe("s3x");
    expect(masker.flush().toString()).toBe("");
  });

  test("lets a partial value through when the stream ends", () => {
    expect(run(["s3cret-token"], ["ends with s3cr"])).toBe("ends with s3cr");
  });

  test("masks the longer of two overlapping values whole", () => {
    expect(run(["abcd", "abcdefgh"], ["x abcdefgh y abcd"])).toBe(
      "x *** y ***",
    );
  });

  test("leaves values shorter than four characters alone", () => {
    expect(run(["abc"], ["abc abc"])).toBe("abc abc");
  });

  test("works on multibyte values split inside a character", () => {
    const value = "pässwörd-é";
    const bytes = Buffer.from(`x ${value} y`);
    const masker = new SecretMasker([value]);
    const out = [
      masker.push(bytes.subarray(0, 5)),
      masker.push(bytes.subarray(5)),
      masker.flush(),
    ];
    expect(Buffer.concat(out).toString()).toBe("x *** y");
  });

  test("passes output through untouched with no values", () => {
    expect(run([], ["anything ", "at all"])).toBe("anything at all");
  });
});
