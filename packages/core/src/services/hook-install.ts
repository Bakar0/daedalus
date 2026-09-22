/**
 * Injecting the activity hooks into each provider at launch.
 *
 * Both providers are given the same event set pointing at the same sink,
 * `daedal agent event <Event>`, which reads `DAEDALUS_SESSION_ID` out of the
 * session environment exactly as the status-line sink already does. Nothing
 * here is installed globally: a hook that outlived the session that needed it
 * would fire for every session the user ever starts.
 */

/** Events worth a hook. Anything not listed is deliberately not observed. */
export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
  "PreCompact",
  "SessionEnd",
] as const;

/**
 * Teardown events get a shorter leash than the rest: a hook that delays an
 * exiting session is worse than a hook that misses it, and lifecycle
 * reconciliation clears activity for a session that is gone anyway.
 */
const SHORT_TIMEOUT_EVENTS = new Set(["SessionEnd", "Interrupt"]);

const timeoutFor = (event: string): number =>
  SHORT_TIMEOUT_EVENTS.has(event) ? 3 : 5;

export interface ClaudeHookEntry {
  matcher?: string;
  hooks: Array<{
    type: "command";
    command: string;
    args?: string[];
    timeout?: number;
    async?: boolean;
  }>;
}

export interface ClaudeSettings {
  statusLine?: unknown;
  hooks?: Record<string, ClaudeHookEntry[]>;
  outputStyle?: unknown;
  skillOverrides?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * How a Daedalus-owned entry is recognised on relaunch. There is no marker
 * field because an unknown key risks failing the provider's settings schema —
 * the command itself is the marker, which is also what dev-3.0 does.
 */
export const isDaedalusHookEntry = (entry: ClaudeHookEntry): boolean =>
  entry.hooks.some(
    (hook) => hook.args?.[0] === "agent" && hook.args?.[1] === "event",
  );

/**
 * The settings object Daedalus contributes: the existing status line plus one
 * hook per event.
 *
 * Every hook is `async` and every hook has an explicit timeout. Activity
 * reporting is strictly observational, so it may never block a turn, slow a
 * tool call, or surface a failure inside the agent's session — a hook that
 * fails because the control plane is down must be invisible.
 *
 * The exec form (`command` + `args`) is used rather than a shell string so a
 * `DAEDALUS_HOME` containing a space or a quote cannot turn into an injection.
 */
export function daedalusClaudeSettings(
  daedalExecutable: string,
): ClaudeSettings {
  const hooks: Record<string, ClaudeHookEntry[]> = {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    hooks[event] = [
      {
        hooks: [
          {
            type: "command",
            command: daedalExecutable,
            args: ["agent", "event", event],
            timeout: timeoutFor(event),
            async: true,
          },
        ],
      },
    ];
  }
  return {
    statusLine: {
      type: "command",
      command: `${daedalExecutable} agent telemetry`,
      padding: 0,
    },
    hooks,
  };
}

/**
 * Merges Daedalus's settings into whatever the user already passed, rather
 * than the previous all-or-nothing behaviour of injecting nothing when the
 * user supplied their own `--settings` — which silently cost them the status
 * line as well as activity.
 *
 * The user wins every conflict: their `statusLine` is never replaced and their
 * hook entries are kept and ordered first. Only Daedalus's own stale entries
 * are stripped, so relaunching never accumulates duplicates.
 */
export function mergeClaudeSettings(
  existing: ClaudeSettings,
  daedalus: ClaudeSettings,
): ClaudeSettings {
  const hooks: Record<string, ClaudeHookEntry[]> = {};
  const events = new Set([
    ...Object.keys(existing.hooks ?? {}),
    ...Object.keys(daedalus.hooks ?? {}),
  ]);
  for (const event of events) {
    const theirs = (existing.hooks?.[event] ?? []).filter(
      (entry) => !isDaedalusHookEntry(entry),
    );
    const ours = daedalus.hooks?.[event] ?? [];
    const merged = [...theirs, ...ours];
    if (merged.length) hooks[event] = merged;
  }
  // Merged key by key rather than replaced wholesale, so a user who turned one
  // skill off does not lose the entries Daedalus contributed, and Daedalus
  // never overrides a decision the user made about the same skill.
  const skillOverrides = {
    ...daedalus.skillOverrides,
    ...existing.skillOverrides,
  };
  return {
    ...daedalus,
    ...existing,
    ...(Object.keys(hooks).length ? { hooks } : {}),
    ...(Object.keys(skillOverrides).length ? { skillOverrides } : {}),
  };
}

/**
 * Reads whatever the user put behind `--settings`. Claude accepts either a
 * JSON literal or a path to a settings file, and both have to survive the
 * merge — silently dropping a settings file would be the same bug in a new
 * place.
 */
export async function parseClaudeSettingsArgument(
  value: string,
): Promise<ClaudeSettings | undefined> {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as ClaudeSettings;
    } catch {
      return undefined;
    }
  }
  try {
    const file = Bun.file(trimmed);
    return (await file.exists())
      ? ((await file.json()) as ClaudeSettings)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * dev-3.0's set, which is the one verified against a shipping Codex binary.
 * `request_user_input` is in the tool matcher on purpose: it is the only way
 * to tell "the agent is asking a question" from "the agent needs a tool
 * approved", and those are different things for the person being waited on.
 */
export const CODEX_TOOL_MATCHER =
  "Bash|Edit|Write|^apply_patch$|^mcp__.*|^(functions\\.)?request_user_input(_async)?$";

export const CODEX_HOOK_EVENTS: ReadonlyArray<{
  event: string;
  matcher?: string;
}> = [
  { event: "SessionStart", matcher: "startup|resume" },
  { event: "UserPromptSubmit" },
  { event: "PreToolUse", matcher: CODEX_TOOL_MATCHER },
  { event: "PermissionRequest", matcher: CODEX_TOOL_MATCHER },
  { event: "PostToolUse", matcher: CODEX_TOOL_MATCHER },
  { event: "Stop" },
  { event: "Interrupt" },
  { event: "SessionEnd" },
];

/**
 * Codex takes its hooks from configuration rather than from a flag, so unlike
 * Claude there is nowhere to put them except the user's own
 * `~/.codex/config.toml`. They go in a fenced block, the same shape other
 * tools use, for three reasons that all matter on a machine Daedalus does not
 * have to itself:
 *
 * - **Appending is what makes coexistence work.** Codex keys a hook's trust
 *   record to `<source>:<event>:<group index>:<hook index>`, so appending our
 *   matcher group *after* everyone else's leaves their indices — and therefore
 *   their existing approvals — untouched. Only our entries are ever new.
 * - **The fence is how we find our own entries again.** Rewriting it in place
 *   means a relaunch updates rather than accumulates, and everything outside it
 *   survives byte for byte, including other tools' blocks and comments.
 * - **A `-c` override cannot do this.** It replaces the whole `hooks.<Event>`
 *   key, so injecting that way would silently disable the hooks any other
 *   installed tool had registered for the same event.
 */
/**
 * The fence is named after the channel that owns it, because a machine can
 * have both builds installed and they are two applications sharing one Codex
 * configuration. A single shared block would be rewritten to whichever shim
 * launched last, and since Codex keys a hook's approval to a hash of its
 * definition, every switch between channels would invalidate the trust and
 * ask the user to review the hooks again.
 */
export const codexBlockMarkers = (channel: string) => ({
  begin: `# >>> daedalus activity hooks · ${channel} (generated — do not edit) >>>`,
  end: `# <<< daedalus activity hooks · ${channel} <<<`,
});

const tomlString = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The block Daedalus owns.
 *
 * Every hook is `async` and carries an explicit timeout, so activity reporting
 * can never block or slow a turn, and every command ends in `|| true` so that
 * a hook still exits 0 when the Daedalus CLI is missing or the control plane is
 * down. Codex's command handler takes a shell string rather than an argument
 * vector — verified against the binary, which rejects an array — so the
 * executable path is single-quoted.
 */
export function renderCodexHookBlock(
  daedalExecutable: string,
  channel = "stable",
  skillEntries: ReadonlyArray<{ path: string; enabled: boolean }> = [],
): string {
  const markers = codexBlockMarkers(channel);
  const quoted = `'${daedalExecutable.replace(/'/g, `'\\''`)}'`;
  const lines: string[] = [
    markers.begin,
    `# Delete this block to turn off Daedalus agent activity for Codex (${channel}).`,
  ];
  // Written before the hook tables so the hook groups keep the positions Codex
  // keyed their approval to. Codex reads these only at startup, so a change
  // here reaches a session that has not begun yet.
  for (const entry of skillEntries)
    lines.push(
      "",
      "[[skills.config]]",
      `path = ${tomlString(entry.path)}`,
      `enabled = ${entry.enabled}`,
    );
  for (const { event, matcher } of CODEX_HOOK_EVENTS) {
    lines.push("", `[[hooks.${event}]]`);
    if (matcher) lines.push(`matcher = ${tomlString(matcher)}`);
    lines.push(
      "",
      `[[hooks.${event}.hooks]]`,
      'type = "command"',
      `command = ${tomlString(`${quoted} agent event ${event} || true`)}`,
      `timeout = ${timeoutFor(event)}`,
      "async = true",
    );
  }
  lines.push("", markers.end);
  return lines.join("\n");
}

/**
 * Splices the Daedalus block into a config, replacing any previous one.
 *
 * Returns the input unchanged when nothing would differ, because every rewrite
 * of a hook definition invalidates its trust record and makes Codex ask the
 * user to approve it again.
 */
export function mergeCodexConfigToml(
  existing: string,
  block: string,
  channel = "stable",
): string {
  const markers = codexBlockMarkers(channel);
  const begin = existing.indexOf(markers.begin);
  const end = existing.indexOf(markers.end);
  // Replaced where it already sits, never lifted to the end. Codex keys a
  // hook's approval to its *position* among the groups for that event, so
  // moving this block past somebody else's would silently invalidate their
  // approval — the other channel's, or another tool's — and make Codex ask
  // about hooks that had not changed at all.
  const merged =
    begin !== -1 && end > begin
      ? `${existing.slice(0, begin)}${block}${existing.slice(end + markers.end.length)}`
      : (() => {
          const body = existing.replace(/\s+$/, "");
          return body ? `${body}\n\n${block}\n` : `${block}\n`;
        })();
  return merged === existing ? existing : merged;
}

const snakeEvent = (event: string): string =>
  event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * The `[hooks.state]` keys Codex will use for Daedalus's own entries, so the
 * CLI can tell "installed and approved" from "installed, waiting for you".
 *
 * The group index is counted from the merged config rather than assumed,
 * because it depends on how many groups other tools registered first.
 */
export function codexHookTrustKeys(
  configToml: string,
  configPath: string,
): string[] {
  let parsed: { hooks?: Record<string, unknown> };
  try {
    parsed = Bun.TOML.parse(configToml) as { hooks?: Record<string, unknown> };
  } catch {
    return [];
  }
  const keys: string[] = [];
  for (const { event } of CODEX_HOOK_EVENTS) {
    const groups = parsed.hooks?.[event];
    if (!Array.isArray(groups) || groups.length === 0) continue;
    // Daedalus always appends, so its group is the last one for that event.
    keys.push(`${configPath}:${snakeEvent(event)}:${groups.length - 1}:0`);
  }
  return keys;
}

/** Which of those keys Codex has recorded an approval for. */
export function codexTrustedHookKeys(configToml: string): Set<string> {
  try {
    const parsed = Bun.TOML.parse(configToml) as {
      hooks?: { state?: Record<string, { trusted_hash?: unknown }> };
    };
    return new Set(
      Object.entries(parsed.hooks?.state ?? {})
        .filter(([, value]) => typeof value?.trusted_hash === "string")
        .map(([key]) => key),
    );
  } catch {
    return new Set();
  }
}

/**
 * Which hook events other tools have registered. Used for reporting only —
 * Daedalus coexists with them rather than standing aside, so this no longer
 * decides whether anything is installed. `[hooks.state]` is Codex's own trust
 * bookkeeping, not a hook.
 */
export function codexConfiguredHookEvents(
  configToml: string,
  channel = "stable",
): string[] {
  const markers = codexBlockMarkers(channel);
  const withoutOurs = (() => {
    const begin = configToml.indexOf(markers.begin);
    const end = configToml.indexOf(markers.end);
    return begin !== -1 && end > begin
      ? `${configToml.slice(0, begin)}${configToml.slice(end + markers.end.length)}`
      : configToml;
  })();
  let parsed: { hooks?: Record<string, unknown> };
  try {
    parsed = Bun.TOML.parse(withoutOurs) as { hooks?: Record<string, unknown> };
  } catch {
    return [];
  }
  return Object.entries(parsed.hooks ?? {})
    .filter(([key, value]) => key !== "state" && Array.isArray(value))
    .map(([key]) => key);
}

/** Codex hooks are stable and on by default from 0.145. */
export const CODEX_HOOKS_MINIMUM = [0, 145, 0] as const;

/**
 * Older Codex builds ignore hooks silently — no error, no log line — so the
 * version has to be established rather than assumed.
 *
 * The output must actually look like Codex's. Anything else is some other
 * program answering `--version`, and reading its number as a Codex version
 * would install hooks that can never fire while reporting that they can.
 */
export function codexSupportsHooks(version: string): boolean {
  const match = /codex[\w-]*\s+v?(\d+)\.(\d+)\.(\d+)/i.exec(version);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < 3; index += 1) {
    const left = actual[index] ?? 0;
    const right = CODEX_HOOKS_MINIMUM[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

export interface CodexActivityTier {
  /** `hook` once trusted, `transcript` until then, `none` when unusable. */
  tier: "hook" | "transcript" | "none";
  installed: boolean;
  trusted: boolean;
  detail: string;
}

/**
 * Which Codex activity tier this machine is actually on, and why.
 *
 * Worth reporting rather than leaving the user to infer from a blank
 * indicator, because every way of losing the hook tier is invisible from the
 * outside: an old build ignores hooks silently, and an approved-but-not-yet
 * hook set never runs.
 */
export function codexActivityTier(input: {
  version?: string;
  configToml?: string;
  configPath?: string;
  channel?: string;
}): CodexActivityTier {
  if (!input.version || !codexSupportsHooks(input.version))
    return {
      tier: "transcript",
      installed: false,
      trusted: false,
      detail:
        "Codex is older than 0.145, which ignores hooks silently; activity falls back to the rollout",
    };
  const configToml = input.configToml ?? "";
  const channel = input.channel ?? "stable";
  const installed = configToml.includes(codexBlockMarkers(channel).begin);
  if (!installed)
    return {
      tier: "transcript",
      installed: false,
      trusted: false,
      detail:
        "hooks are installed into ~/.codex/config.toml the next time a Codex session starts",
    };
  const expected = codexHookTrustKeys(configToml, input.configPath ?? "");
  const approved = codexTrustedHookKeys(configToml);
  const trusted =
    expected.length > 0 && expected.every((key) => approved.has(key));
  const alongside = codexConfiguredHookEvents(configToml, channel).length > 0;
  const coexist = alongside
    ? " They are installed alongside another tool's hooks; both run."
    : "";
  return {
    tier: trusted ? "hook" : "transcript",
    installed: true,
    trusted,
    detail: trusted
      ? `hooks are installed and approved.${coexist}`
      : `hooks are installed but not yet approved — choose "Trust all and continue" at Codex's one-time "Hooks need review" prompt to enable them. Until then activity falls back to the rollout.${coexist}`,
  };
}
