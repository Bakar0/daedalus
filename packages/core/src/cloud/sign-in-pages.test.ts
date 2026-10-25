import { describe, expect, test } from "vitest";
import {
  checkSignInUrl,
  pasteCodeUrl,
  SIGN_IN_OFFER_MS,
  SignInOffers,
  type CheckedSignInUrl,
} from "./sign-in-pages";

const SSO = ["d-9a672d87aa.awsapps.com"];
const claude = (redirect: string, state = "s1") =>
  `https://claude.com/cai/oauth/authorize?code=true&client_id=c&response_type=code&redirect_uri=${encodeURIComponent(redirect)}&scope=user&code_challenge=x&code_challenge_method=S256&state=${state}`;

describe("checkSignInUrl", () => {
  test("Claude's page with a localhost listener names its port, path and state", () => {
    expect(
      checkSignInUrl(claude("http://localhost:42431/callback"), SSO),
    ).toMatchObject({
      kind: "claude",
      host: "claude.com",
      callback: { port: 42431, path: "/callback", state: "s1" },
    });
  });

  test("Codex's ChatGPT page with its listener on 127.0.0.1:1455", () => {
    const codex = (redirect: string, extra = "") =>
      `https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=x&code_challenge_method=S256&state=s1&originator=codex-tui${extra}`;
    expect(
      checkSignInUrl(codex("http://127.0.0.1:1455/auth/callback"), SSO),
    ).toMatchObject({
      kind: "codex",
      host: "auth.openai.com",
      callback: { port: 1455, path: "/auth/callback", state: "s1" },
    });
    for (const refused of [
      // Claude's listeners are not Codex's, nor the other way round.
      codex("http://localhost:1455/callback"),
      codex("http://localhost:1455/auth/callback"),
      codex("https://evil.test/auth/callback"),
      codex("http://127.0.0.1:1455/auth/callback", "&state=s2"),
      claude("http://127.0.0.1:1455/auth/callback"),
      "https://auth.openai.com/oauth/authorize?state=s1",
      "https://auth.openai.com/codex/device",
      "https://chatgpt.com/oauth/authorize?redirect_uri=x&state=s1",
    ])
      expect(typeof checkSignInUrl(refused, SSO)).toBe("string");
  });

  test("the paste-code page has no callback", () => {
    const checked = checkSignInUrl(
      claude("https://platform.claude.com/oauth/code/callback"),
      SSO,
    );
    expect(checked).toMatchObject({ kind: "claude" });
    expect((checked as CheckedSignInUrl).callback).toBeUndefined();
  });

  test("the copied AWS portal's device page, and no other portal", () => {
    expect(
      checkSignInUrl(
        "https://d-9a672d87aa.awsapps.com/start/#/device?user_code=ABCD-EFGH",
        SSO,
      ),
    ).toMatchObject({ kind: "aws", host: "d-9a672d87aa.awsapps.com" });
    expect(
      checkSignInUrl(
        "https://d-0000000000.awsapps.com/start/#/device?user_code=ABCD-EFGH",
        SSO,
      ),
    ).toBe("a page on d-0000000000.awsapps.com that is not a sign-in page");
  });

  test("refuses anything else", () => {
    for (const [url, reason] of [
      ["http://claude.com/cai/oauth/authorize", "a URL that is not https"],
      [
        "https://claude.com/other",
        "a page on claude.com that is not a sign-in page",
      ],
      [
        "https://evil.test/cai/oauth/authorize",
        "a page on evil.test that is not a sign-in page",
      ],
      [
        "https://user:pw@claude.com/cai/oauth/authorize",
        "a URL with a user name",
      ],
      ["https://claude.com:8443/cai/oauth/authorize", "a URL with a port"],
      ["not a url", "the URL"],
      [
        `https://claude.com/cai/oauth/authorize?x=${"a".repeat(5000)}`,
        "the URL",
      ],
      [
        claude("http://evil.test:4000/callback"),
        "a redirect to somewhere other than a sign-in listener",
      ],
      [
        claude("http://localhost:80/callback"),
        "a redirect to somewhere other than a sign-in listener",
      ],
      [
        claude("http://localhost:4000/other"),
        "a redirect to somewhere other than a sign-in listener",
      ],
      [
        claude("http://localhost:4000/callback", ""),
        "a redirect without a state",
      ],
    ] as const)
      expect(checkSignInUrl(url, SSO)).toBe(reason);
  });

  test("refuses a repeated parameter, and a Claude page without its redirect and state (S-1)", () => {
    expect(
      checkSignInUrl(
        `${claude("http://localhost:4000/callback")}&scope=other`,
        SSO,
      ),
    ).toBe("a URL that repeats a parameter");
    expect(
      checkSignInUrl(
        "https://claude.com/cai/oauth/authorize?client_id=c&state=s",
        SSO,
      ),
    ).toBe("a sign-in page without a redirect_uri and a state");
    expect(
      checkSignInUrl(
        `https://claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent("http://localhost:4000/callback")}`,
        SSO,
      ),
    ).toBe("a sign-in page without a redirect_uri and a state");
  });

  test("the paste-code version keeps everything but the redirect", () => {
    const pasted = new URL(
      pasteCodeUrl(claude("http://localhost:4000/callback")),
    );
    expect(pasted.searchParams.get("redirect_uri")).toBe(
      "https://platform.claude.com/oauth/code/callback",
    );
    expect(pasted.searchParams.get("state")).toBe("s1");
    expect(pasted.searchParams.get("code_challenge")).toBe("x");
  });
});

describe("SignInOffers", () => {
  const checked = checkSignInUrl(
    claude("http://localhost:4000/callback"),
    SSO,
  ) as CheckedSignInUrl;

  test("one sign-in per session; a window sees no URL; a page opens once", () => {
    const offers = new SignInOffers();
    let changes = 0;
    offers.onChange(() => changes++);
    offers.begin("ws:a", "s", "claude");
    expect(offers.get("s")).toMatchObject({ phase: "starting" });
    const first = offers.offer("ws:a", "s", checked);
    const second = offers.offer("ws:a", "s", checked);
    expect(offers.list()).toEqual([second]);
    expect(second).toMatchObject({ phase: "waiting", host: "claude.com" });
    expect(JSON.stringify(offers.list())).not.toContain("localhost");
    expect(offers.open(first.requestId!, () => false)).toBeUndefined();
    expect(offers.open(second.requestId!, () => true)?.checked.url).toBe(
      checked.url,
    );
    expect(offers.get("s")).toMatchObject({ phase: "pasting" });
    expect(offers.get("s")?.requestId).toBeUndefined();
    expect(offers.open(second.requestId!, () => false)).toBeUndefined();
    offers.fail("s", "why");
    expect(offers.get("s")).toMatchObject({ phase: "failed", message: "why" });
    offers.finish("s");
    expect(offers.list()).toEqual([]);
    expect(changes).toBe(6);
  });

  test("sign-ins expire, go with their host, and can be dismissed", () => {
    let now = 1_000;
    const offers = new SignInOffers(() => now);
    const old = offers.offer("ws:a", "s1", checked);
    offers.offer("ws:b", "s2", checked);
    offers.dropHost("ws:b");
    expect(offers.list().map((offer) => offer.sessionId)).toEqual(["s1"]);
    now += SIGN_IN_OFFER_MS;
    expect(offers.list()).toEqual([]);
    expect(offers.open(old.requestId!, () => false)).toBeUndefined();
    offers.begin("ws:a", "s3", "claude");
    offers.dismiss({ sessionId: "s3" });
    expect(offers.list()).toEqual([]);
  });
});
