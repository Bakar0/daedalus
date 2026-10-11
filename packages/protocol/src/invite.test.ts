import { describe, expect, test } from "bun:test";
import { formatInviteCode, inviteCodeComplete } from "./index";

describe("formatInviteCode", () => {
  test("adds the dash after the fifth character as the user types", () => {
    expect(formatInviteCode("6m7q")).toBe("6M7Q");
    expect(formatInviteCode("6m7qp")).toBe("6M7QP");
    expect(formatInviteCode("6m7qps")).toBe("6M7QP-S");
    expect(formatInviteCode("6m7qpsfv8e")).toBe("6M7QP-SFV8E");
  });

  test("keeps a pasted code with or without the dash, and drops the rest", () => {
    expect(formatInviteCode(" 6M7QP-SFV8E ")).toBe("6M7QP-SFV8E");
    expect(formatInviteCode("6M7QP SFV8E")).toBe("6M7QP-SFV8E");
    expect(formatInviteCode("6M7QP-SFV8E-EXTRA")).toBe("6M7QP-SFV8E");
  });

  test("deleting back over the dash removes it", () => {
    expect(formatInviteCode("6M7QP-")).toBe("6M7QP");
  });

  test("is complete only with all ten characters", () => {
    expect(inviteCodeComplete("6M7QP-SFV8E")).toBe(true);
    expect(inviteCodeComplete("6M7QP-SFV8")).toBe(false);
    expect(inviteCodeComplete("6M7QPSFV8E")).toBe(false);
  });
});
