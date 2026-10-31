import {
  DaedalusError,
  localTime,
  SESSION_COLORS,
  ABILITY_IDS,
  type AgentSession,
  type ApplicationContext,
  type SessionAbility,
} from "@daedalus/core";
import { expectPositionals, parseArguments, printResult } from "./arguments";

export const sessionHelp = `Session commands:
  daedal session rename <session> <name>
  daedal session pin|unpin <session>
  daedal session color <session> <${SESSION_COLORS.join("|")}|#rrggbb|none>
  daedal session rebirth-at <session> <percent>|off|default
  daedal session abilities <session>
  daedal session grant <session> <ability>
  daedal session revoke <session> <ability>

<session> is a session id, or a session's name when only one live session
has it. Pinned sessions sit at the top of their workspace's list. The color
marks the session's card, its World figure and the tasks its routines file.
'rebirth-at' sets the context percent (10 to 100) at which this session is
asked for a rebirth, or turns it off for this session; 'default' takes its
workspace's setting (see 'daedal workspace --help').

Abilities: ${ABILITY_IDS.join(", ")}. 'grant' gives a running session an
ability. Routines say nothing to the session: ask it for a routine. For
orchestration, the app sends one note: through a Claude session's inbox,
with nothing typed, or typed into a Codex session once it is idle, its
input box is empty and nobody typed in it for 2 minutes. To start a session that holds
one, use 'daedal agent spawn --ability <ability>'. 'revoke' stops what the
ability does and keeps its data, so a later grant brings it back. A rebirth
moves the abilities, the pin and the color to the successor; a session with
routines keeps its exact name, any other gets ' · 2'.
Archiving a session pauses its abilities; restoring it resumes them.`;

const sessionLine = (session: AgentSession) =>
  `${session.id}\t${session.name}\t${session.pinnedAt ? "pinned" : "—"}\t${session.color ?? "—"}`;

const abilityLine = (ability: SessionAbility) =>
  `${ability.ability}\t${ability.enabled ? (ability.paused ? "paused" : "on") : "revoked"}\tgranted ${localTime(ability.grantedAt)}${ability.pendingNote ? "\tnote waiting to be typed" : ""}`;

export async function sessionCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help") {
    console.log(sessionHelp);
    return 0;
  }
  const parsed = parseArguments(args, []);
  const reference = parsed.positionals[0];
  if (action === "rename") {
    const usage = "daedal session rename <session> <name>";
    expectPositionals(parsed.positionals, 2, usage);
    const session = await context.agents.rename(
      context.agents.resolve(reference!).id,
      parsed.positionals[1]!,
    );
    printResult({ session }, json, () => console.log(sessionLine(session)));
    return 0;
  }
  if (action === "pin" || action === "unpin") {
    expectPositionals(
      parsed.positionals,
      1,
      `daedal session ${action} <session>`,
    );
    const session = await context.agents.setPinned(
      context.agents.resolve(reference!).id,
      action === "pin",
    );
    printResult({ session }, json, () => console.log(sessionLine(session)));
    return 0;
  }
  if (action === "color") {
    const usage = `daedal session color <session> <${SESSION_COLORS.join("|")}|#rrggbb|none>`;
    expectPositionals(parsed.positionals, 2, usage);
    const value = parsed.positionals[1]!;
    const session = await context.agents.setColor(
      context.agents.resolve(reference!).id,
      value === "none" ? null : value,
    );
    printResult({ session }, json, () => console.log(sessionLine(session)));
    return 0;
  }
  if (action === "rebirth-at") {
    const usage = "daedal session rebirth-at <session> <percent>|off|default";
    expectPositionals(parsed.positionals, 2, usage);
    const value = parsed.positionals[1]!;
    if (value !== "off" && value !== "default" && !/^\d+$/.test(value))
      throw new DaedalusError(
        "VALIDATION",
        "The rebirth threshold must be a percent from 10 to 100, 'off' or 'default'",
      );
    const session = await context.agents.setAutoRebirth(
      context.agents.resolve(reference!).id,
      value === "default" ? null : value === "off" ? "off" : Number(value),
    );
    printResult({ session }, json, () => console.log(sessionLine(session)));
    return 0;
  }
  if (action === "abilities") {
    expectPositionals(
      parsed.positionals,
      1,
      "daedal session abilities <session>",
    );
    const session = context.agents.resolve(reference!);
    const abilities = context.abilities.list(session.id);
    printResult({ abilities }, json, () => {
      if (!abilities.length) console.log("No abilities.");
      for (const ability of abilities) console.log(abilityLine(ability));
    });
    return 0;
  }
  if (action === "grant" || action === "revoke") {
    const usage = `daedal session ${action} <session> <ability>`;
    expectPositionals(parsed.positionals, 2, usage);
    const session = context.agents.resolve(reference!);
    const ability =
      action === "grant"
        ? context.abilities.grant(session.id, parsed.positionals[1]!, {
            live: true,
          })
        : context.abilities.revoke(session.id, parsed.positionals[1]!);
    printResult({ ability }, json, () =>
      console.log(
        `${action === "grant" ? "Granted" : "Revoked"} ${ability.ability} ${action === "grant" ? "to" : "from"} ${session.name}${ability.pendingNote ? "; the app tells the session once it is idle and nobody is typing" : ""}`,
      ),
    );
    return 0;
  }
  throw new DaedalusError("VALIDATION", `Unknown session command '${action}'`);
}
