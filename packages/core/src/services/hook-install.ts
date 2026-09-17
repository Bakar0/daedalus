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
  return {
    ...daedalus,
    ...existing,
    ...(Object.keys(hooks).length ? { hooks } : {}),
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

const tomlString = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Codex takes its hooks from configuration rather than from a flag, but `-c`
 * overrides are a configuration source, so the whole set can be supplied per
 * session without ever writing to the user's `~/.codex/config.toml`.
 *
 * That matters more than convenience. Codex gates hooks behind a one-time
 * "Hooks need review" trust prompt keyed by a hash of the hook definition and
 * a source label that, for `-c` overrides, is the constant
 * `/<session-flags>/config.toml` — so the user's single approval carries to
 * every later Daedalus session, and declining leaves their own configuration
 * exactly as it was.
 *
 * Codex's command handler takes a shell string rather than an argument vector,
 * so the executable path is quoted, and the whole command is made
 * offline-tolerant with a trailing `|| true`: when the control plane is down
 * the hook must still exit 0.
 */
export function codexDaedalusHookArgs(
  daedalExecutable: string,
  userConfiguredEvents: readonly string[] = [],
): string[] {
  const quoted = `'${daedalExecutable.replace(/'/g, `'\\''`)}'`;
  const args: string[] = [];
  for (const { event, matcher } of CODEX_HOOK_EVENTS) {
    // A `-c` override replaces the key rather than extending it, so an event
    // the user has already hooked is left entirely alone. Stomping their hook
    // to gain a status indicator is not a trade Daedalus gets to make.
    if (userConfiguredEvents.includes(event)) continue;
    const command = `${quoted} agent event ${event} || true`;
    const group = [
      matcher ? `matcher=${tomlString(matcher)}` : undefined,
      `hooks=[{type="command",command=${tomlString(command)},timeout_sec=${timeoutFor(event)}}]`,
    ]
      .filter(Boolean)
      .join(",");
    args.push("-c", `hooks.${event}=[{${group}}]`);
  }
  return args;
}

/**
 * Which hook events the user configured themselves, so Daedalus can stay out
 * of their way. `[hooks.state]` is Codex's own trust bookkeeping, not a hook.
 */
export function codexConfiguredHookEvents(configToml: string): string[] {
  let parsed: { hooks?: Record<string, unknown> };
  try {
    parsed = Bun.TOML.parse(configToml) as { hooks?: Record<string, unknown> };
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
 * would inject hooks that can never fire while reporting that they can.
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
  /** `hook` once trusted, `transcript` while it is not, `none` when unusable. */
  tier: "hook" | "transcript" | "none";
  detail: string;
}

/**
 * Which Codex activity tier this machine is actually on, and why.
 *
 * Worth reporting rather than inferring from a blank indicator, because every
 * way of losing the hook tier is invisible from the outside: an old build
 * ignores hooks silently, an untrusted hook set never runs, and a hook event
 * another tool already owns is one Daedalus deliberately declines to take.
 */
export function codexActivityTier(input: {
  version?: string;
  configToml?: string;
}): CodexActivityTier {
  if (!input.version || !codexSupportsHooks(input.version))
    return {
      tier: "transcript",
      detail:
        "Codex is older than 0.145, which ignores hooks silently; activity falls back to the rollout",
    };
  const taken = codexConfiguredHookEvents(input.configToml ?? "");
  const ours = CODEX_HOOK_EVENTS.map((entry) => entry.event);
  const available = ours.filter((event) => !taken.includes(event));
  if (available.length === 0)
    return {
      tier: "transcript",
      detail:
        "every hook event is already configured in ~/.codex/config.toml, and Daedalus will not override your hooks; activity falls back to the rollout",
    };
  if (available.length < ours.length)
    return {
      tier: "hook",
      detail: `${available.length} of ${ours.length} hook events are Daedalus's; the rest are already yours and were left alone`,
    };
  return {
    tier: "hook",
    detail:
      "hooks are injected per session; approve Codex's one-time 'Hooks need review' prompt to enable them",
  };
}
