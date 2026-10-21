import { describe, expect, test } from "vitest";
import { deleteKeychainPassword } from "./keychain";

const exiting =
  (exitCode: number, stderr = "") =>
  async () => ({ exitCode, stdout: "", stderr, timedOut: false });

describe("deleteKeychainPassword", () => {
  test("a removed or missing item is done", async () => {
    await deleteKeychainPassword("s", "a", exiting(0));
    // security's code for an item that is not there.
    await deleteKeychainPassword("s", "a", exiting(44));
  });

  test("any other failure throws, with what security said", async () => {
    await expect(
      deleteKeychainPassword(
        "s",
        "a",
        exiting(51, "User interaction is not allowed."),
      ),
    ).rejects.toThrow("User interaction is not allowed.");
    await expect(
      deleteKeychainPassword("s", "a", exiting(124)),
    ).rejects.toThrow("The Keychain did not remove the password");
  });
});
