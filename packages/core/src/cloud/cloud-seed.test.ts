import { describe, expect, test } from "vitest";
import {
  awsSsoCopy,
  mergeAwsConfig,
  seedClaudeConsent,
  seedClaudeSettings,
  seedClaudeState,
} from "./cloud-seed";

const AWS_CONFIG = `# The user's own config
[default]
region = eu-west-1

[sso-session zenity]
sso_start_url = https://d-9a672d87aa.awsapps.com/start
sso_region = us-east-2
sso_registration_scopes = sso:account:access

[profile playground]
sso_session = zenity
sso_account_id = 111122223333
sso_role_name = PowerUser
region = eu-west-1
credential_process = /usr/local/bin/something --secret

[profile legacy]
sso_start_url = https://d-90663f591e.awsapps.com/start
sso_region = us-east-1
sso_account_id = 444455556666
sso_role_name = Admin

[profile keys]
aws_access_key_id = AKIAEXAMPLE
aws_secret_access_key = secret
region = us-east-1
`;

describe("seedClaudeState", () => {
  test("marks onboarding done and the workspace trusted, keeping the rest", () => {
    const seeded = seedClaudeState(
      JSON.stringify({
        oauthAccount: { emailAddress: "a@b.c" },
        projects: { "/workspace": { allowedTools: ["Bash"] }, "/other": {} },
      }),
    );
    expect(JSON.parse(seeded!)).toEqual({
      oauthAccount: { emailAddress: "a@b.c" },
      hasCompletedOnboarding: true,
      projects: {
        "/workspace": {
          allowedTools: ["Bash"],
          hasTrustDialogAccepted: true,
          hasClaudeMdExternalIncludesApproved: true,
          hasClaudeMdExternalIncludesWarningShown: true,
        },
        "/other": {},
      },
    });
    expect(seedClaudeState(seeded)).toBeUndefined();
  });

  test("starts a missing or broken file afresh", () => {
    for (const text of [undefined, "", "not json", "[1]"])
      expect(JSON.parse(seedClaudeState(text)!).hasCompletedOnboarding).toBe(
        true,
      );
  });
});

describe("seedClaudeSettings", () => {
  test("sets a theme once and keeps the user's own", () => {
    expect(JSON.parse(seedClaudeSettings(undefined, {})!)).toEqual({
      theme: "dark",
    });
    expect(seedClaudeSettings('{"theme":"light"}', {})).toBeUndefined();
  });

  test("a Bedrock launch adds the device-code sign-in renewal", () => {
    const seeded = JSON.parse(
      seedClaudeSettings('{"theme":"light","model":"opus"}', {
        bedrockProfile: "playground",
      })!,
    );
    expect(seeded).toEqual({
      theme: "light",
      model: "opus",
      awsAuthRefresh: "aws sso login --use-device-code --profile playground",
    });
  });
});

describe("awsSsoCopy", () => {
  test("copies the profile and its SSO session, with no credential keys", () => {
    const copy = awsSsoCopy(AWS_CONFIG, "playground");
    expect(copy.startUrlHost).toBe("d-9a672d87aa.awsapps.com");
    const merged = mergeAwsConfig(undefined, copy.sections)!;
    expect(merged).toBe(
      `[profile playground]
sso_session = zenity
sso_account_id = 111122223333
sso_role_name = PowerUser
region = eu-west-1

[sso-session zenity]
sso_start_url = https://d-9a672d87aa.awsapps.com/start
sso_region = us-east-2
sso_registration_scopes = sso:account:access
`,
    );
    expect(merged).not.toContain("credential_process");
  });

  test("a legacy SSO profile carries its own start URL", () => {
    const copy = awsSsoCopy(AWS_CONFIG, "legacy");
    expect(copy.startUrlHost).toBe("d-90663f591e.awsapps.com");
    expect(copy.sections).toHaveLength(1);
  });

  test("a profile without SSO, or one not there, is refused", () => {
    expect(() => awsSsoCopy(AWS_CONFIG, "keys")).toThrow(
      "does not sign in with AWS SSO",
    );
    expect(() => awsSsoCopy(AWS_CONFIG, "default")).toThrow(
      "does not sign in with AWS SSO",
    );
    expect(() => awsSsoCopy(AWS_CONFIG, "missing")).toThrow(
      "is not in this Mac's AWS config",
    );
    expect(() => awsSsoCopy("[profile p]\nsso_session = gone\n", "p")).toThrow(
      "names the SSO session 'gone'",
    );
    expect(() =>
      awsSsoCopy("[profile p]\nsso_start_url = http://x.test/start\n", "p"),
    ).toThrow("not an https address");
  });
});

describe("mergeAwsConfig", () => {
  test("replaces sections of the same name and keeps the pod's others", () => {
    const pod = `[profile mine]\nregion = us-west-2\n\n[profile playground]\nregion = old\n`;
    const merged = mergeAwsConfig(
      pod,
      awsSsoCopy(AWS_CONFIG, "playground").sections,
    )!;
    expect(merged.startsWith("[profile mine]\nregion = us-west-2\n")).toBe(
      true,
    );
    expect(merged).not.toContain("region = old");
    expect(merged).toContain("[sso-session zenity]");
    expect(
      mergeAwsConfig(merged, awsSsoCopy(AWS_CONFIG, "playground").sections),
    ).toBeUndefined();
  });
});

describe("seedClaudeConsent", () => {
  const record = {
    accountUuid: "acc-1",
    dangerousSettingsHash: "a".repeat(64),
    updatedAt: 1,
  };
  test("adds this Mac's approvals to the pod's, keeping only their known fields", () => {
    const mac = JSON.stringify({
      version: 1,
      records: { "org-1": { ...record, extra: "dropped" }, bad: { x: 1 } },
    });
    const pod = JSON.stringify({
      version: 1,
      records: { "org-2": { ...record, accountUuid: "acc-2" } },
    });
    expect(JSON.parse(seedClaudeConsent(pod, mac)!)).toEqual({
      version: 1,
      records: {
        "org-2": { ...record, accountUuid: "acc-2" },
        "org-1": record,
      },
    });
    expect(seedClaudeConsent(seedClaudeConsent(pod, mac), mac)).toBeUndefined();
  });

  test("nothing to copy writes nothing", () => {
    expect(seedClaudeConsent(undefined, undefined)).toBeUndefined();
    expect(seedClaudeConsent(undefined, "not json")).toBeUndefined();
  });
});
