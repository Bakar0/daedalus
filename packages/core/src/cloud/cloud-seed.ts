import { DaedalusError } from "../errors";

/**
 * What a cloud Claude session finds in its pod before it starts, so it opens
 * on its prompt rather than on Claude's first-run screens
 * (artifacts/cloud-sessions/auth-spike.md, section 1). Nothing here is a
 * credential: a sign-in happens in the pod, or through AWS SSO there.
 *
 * Paths are relative to the workspace root; the pod's `HOME` is
 * `/workspace/.home`.
 */
export const CLOUD_SEED_PATHS = {
  claudeState: ".home/.claude.json",
  claudeSettings: ".home/.claude/settings.json",
  awsConfig: ".home/.aws/config",
} as const;

/** The workspace root as the pod's Claude records it in `.claude.json`. */
const POD_WORKSPACE = "/workspace";

/** As `CLAUDE_TRUST_FLAGS` in folder-trust.ts, for the pod's workspace. */
const TRUST_FLAGS = {
  hasTrustDialogAccepted: true,
  hasClaudeMdExternalIncludesApproved: true,
  hasClaudeMdExternalIncludesWarningShown: true,
} as const;

/**
 * The command Claude runs itself when its AWS credentials fail, as local
 * Bedrock accounts have (`bedrockSettings`), with the device code: it needs
 * no callback into the pod. It lives in the pod's user settings, the one
 * place Claude runs it without folder trust, so the last Bedrock profile
 * launched there is the one it renews.
 */
export const cloudAwsAuthRefresh = (profile: string): string =>
  `aws sso login --use-device-code --profile ${profile}`;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON object file, or an empty one when it is missing or not an object. */
function parseObject(text: string | undefined): Json {
  if (!text?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const render = (value: Json) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * `.claude.json` with onboarding done and the workspace trusted, or
 * undefined when it already says both. Every other key is kept, the account
 * Claude records after a sign-in among them.
 */
export function seedClaudeState(text: string | undefined): string | undefined {
  const state = parseObject(text);
  const projects = isObject(state.projects) ? state.projects : {};
  const project = isObject(projects[POD_WORKSPACE])
    ? projects[POD_WORKSPACE]
    : {};
  const done =
    state.hasCompletedOnboarding === true &&
    Object.entries(TRUST_FLAGS).every(([key, value]) => project[key] === value);
  if (done) return undefined;
  return render({
    ...state,
    hasCompletedOnboarding: true,
    projects: {
      ...projects,
      [POD_WORKSPACE]: { ...project, ...TRUST_FLAGS },
    },
  });
}

/**
 * `~/.claude/settings.json` with a theme, so the theme picker does not
 * show, and for Bedrock the command that renews an expired SSO sign-in.
 * Undefined when nothing changes. A theme the user picked stays.
 */
export function seedClaudeSettings(
  text: string | undefined,
  options: { bedrockProfile?: string },
): string | undefined {
  const settings = parseObject(text);
  const next: Json = { ...settings };
  if (typeof next.theme !== "string") next.theme = "dark";
  if (options.bedrockProfile)
    next.awsAuthRefresh = cloudAwsAuthRefresh(options.bedrockProfile);
  return JSON.stringify(next) === JSON.stringify(settings)
    ? undefined
    : render(next);
}

interface IniSection {
  /** As written between the brackets, such as `profile dev`. */
  name: string;
  values: Map<string, string>;
}

/** The sections of an AWS config file; comments and blank lines dropped. */
function parseIni(text: string): IniSection[] {
  const sections: IniSection[] = [];
  let current: IniSection | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      current = { name: header[1]!.replace(/\s+/g, " "), values: new Map() };
      sections.push(current);
      continue;
    }
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    // A nested value (an indented line under `s3 =`) belongs to keys this
    // never copies.
    if (pair && current && !/^\s/.test(raw))
      current.values.set(pair[1]!.toLowerCase(), pair[2]!.trim());
  }
  return sections;
}

/** What a profile may take into a pod: where and how to sign in, no keys. */
const PROFILE_KEYS = [
  "sso_session",
  "sso_account_id",
  "sso_role_name",
  "sso_start_url",
  "sso_region",
  "region",
  "output",
] as const;
const SSO_SESSION_KEYS = [
  "sso_start_url",
  "sso_region",
  "sso_registration_scopes",
] as const;

export interface AwsSsoCopy {
  /** The sections, ready to merge into the pod's config. */
  sections: IniSection[];
  /** The access portal's host, for the sign-in page allowlist. */
  startUrlHost: string;
}

const profileSection = (profile: string) =>
  profile === "default" ? "default" : `profile ${profile}`;

/**
 * The parts of this Mac's AWS config a cloud session's Bedrock profile
 * needs to sign in with SSO: its `[profile]` and its `[sso-session]`, with
 * only the SSO, region and output keys. A profile that does not sign in with
 * SSO is refused: its credentials would have to leave this Mac.
 */
export function awsSsoCopy(configText: string, profile: string): AwsSsoCopy {
  const sections = parseIni(configText);
  const wanted = profileSection(profile);
  const found = sections.find((section) => section.name === wanted);
  if (!found)
    throw new DaedalusError(
      "VALIDATION",
      `The AWS profile '${profile}' is not in this Mac's AWS config`,
    );
  const sessionName = found.values.get("sso_session");
  const session = sessionName
    ? sections.find((section) => section.name === `sso-session ${sessionName}`)
    : undefined;
  if (sessionName && !session)
    throw new DaedalusError(
      "VALIDATION",
      `The AWS profile '${profile}' names the SSO session '${sessionName}', which is not in this Mac's AWS config`,
    );
  const startUrl =
    session?.values.get("sso_start_url") ?? found.values.get("sso_start_url");
  if (!startUrl)
    throw new DaedalusError(
      "VALIDATION",
      `The AWS profile '${profile}' does not sign in with AWS SSO. A cloud session signs in to Bedrock only through SSO, so no credentials leave this Mac; pick a profile with sso_session or sso_start_url.`,
    );
  let startUrlHost: string;
  try {
    const url = new URL(startUrl);
    if (url.protocol !== "https:") throw new Error("not https");
    startUrlHost = url.hostname.toLowerCase();
  } catch {
    throw new DaedalusError(
      "VALIDATION",
      `The SSO start URL of the AWS profile '${profile}' is not an https address`,
    );
  }
  const pick = (section: IniSection, keys: readonly string[]): IniSection => ({
    name: section.name,
    values: new Map(
      keys
        .filter((key) => section.values.has(key))
        .map((key) => [key, section.values.get(key)!]),
    ),
  });
  return {
    sections: [
      pick(found, PROFILE_KEYS),
      ...(session ? [pick(session, SSO_SESSION_KEYS)] : []),
    ],
    startUrlHost,
  };
}

/**
 * The pod's AWS config with these sections in place: the ones of the same
 * name are replaced, the pod's others kept. Undefined when nothing changes.
 */
export function mergeAwsConfig(
  podText: string | undefined,
  sections: IniSection[],
): string | undefined {
  const pod = parseIni(podText ?? "");
  const byName = new Map(sections.map((section) => [section.name, section]));
  const merged = [
    ...pod.map((section) => byName.get(section.name) ?? section),
    ...sections.filter(
      (section) => !pod.some((existing) => existing.name === section.name),
    ),
  ];
  const text = merged
    .map(
      (section) =>
        `[${section.name}]\n${[...section.values]
          .map(([key, value]) => `${key} = ${value}\n`)
          .join("")}`,
    )
    .join("\n");
  return text === podText ? undefined : text;
}
