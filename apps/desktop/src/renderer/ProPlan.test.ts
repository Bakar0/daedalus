import { describe, expect, test } from "bun:test";
import type { RemoteStateDto } from "@daedalus/protocol";
import { showsPro } from "./ProPlan";

const state = (patch: Partial<RemoteStateDto>): RemoteStateDto => ({
  enabled: false,
  keepAwake: false,
  status: "off",
  relay: "wss://relay.example.dev",
  macName: "Mac",
  connectedPhones: 0,
  signedIn: true,
  phones: [],
  ...patch,
});

const plan = { name: "pro", expiresAt: null };

describe("showsPro", () => {
  test("shows Pro to an account with a plan or on the admin list", () => {
    expect(showsPro(state({ plan }))).toBe(true);
    expect(showsPro(state({ admin: true }))).toBe(true);
  });

  test("hides it from everyone else, signed in or not", () => {
    expect(showsPro(undefined)).toBe(false);
    expect(showsPro(state({}))).toBe(false);
    expect(showsPro(state({ signedIn: false, plan }))).toBe(false);
    // A plan the relay refuses (it ended) counts as none.
    expect(showsPro(state({ plan, lockedBy: "no_plan" }))).toBe(false);
  });
});
