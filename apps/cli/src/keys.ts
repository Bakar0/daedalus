import { DaedalusError, type ApplicationContext } from "@daedalus/core";
import {
  COMMAND_SPECS,
  type CommandId,
  formatKeyGlyphs,
  isCommandId,
  keyWarning,
  keysOf,
} from "@daedalus/protocol";
import { expectPositionals, parseArguments, printResult } from "./arguments";

export const keysHelp = `Keyboard shortcut commands:
  daedal keys list
  daedal keys set <command-id> [<key>...]
  daedal keys reset [<command-id>]

The desktop app's keys, kept in keybindings.json in the Daedalus home
(~/.daedalus, or ~/.daedalus-dev for the dev app). The app watches the file,
so a change applies at once. Settings › Keyboard edits the same file.

A key is written as the file writes it: mod is ⌘, then ctrl, alt (⌥) and
shift, joined by +, as in mod+shift+p or ctrl+\`. A sequence is two chords
separated by a space, as in "mod+k mod+s".

'set' with no key unbinds the command. 'reset' puts one command, or every
command, back to its default keys. Keys macOS or the Edit menu own (⌘Tab,
⌘Space, ⌘H, ⌘M, ⌘C, ⌘V, ⌘X, ⌘A, ⌘Z and the like) are refused.`;

const commandRows = (
  overrides: Partial<Record<CommandId, readonly string[]>>,
) =>
  COMMAND_SPECS.map((spec) => ({
    id: spec.id,
    title: spec.title,
    keys: [...keysOf(spec, overrides)],
    changed: overrides[spec.id] !== undefined,
  }));

export async function keysCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "help") {
    console.log(keysHelp);
    return 0;
  }
  const parsed = parseArguments(rest, []);
  const command = (reference: string | undefined): CommandId => {
    if (!isCommandId(reference))
      throw new DaedalusError(
        "VALIDATION",
        `Unknown command '${reference ?? ""}'; 'daedal keys list' shows them`,
      );
    return reference;
  };
  const show = (state: Awaited<ReturnType<typeof context.keybindings.read>>) =>
    printResult(
      {
        path: state.path,
        commands: commandRows(state.overrides),
        rejected: state.rejected,
      },
      json,
      () => {
        for (const row of commandRows(state.overrides))
          console.log(
            `${row.id}\t${row.keys.map(formatKeyGlyphs).join(", ") || "-"}${row.changed ? "\t(changed)" : ""}`,
          );
        for (const item of state.rejected)
          console.error(
            `Skipped in ${state.path}: ${[item.id || "file", item.key, item.reason].filter(Boolean).join(" ")}`,
          );
      },
    );
  if (action === "list") {
    expectPositionals(parsed.positionals, 0, "daedal keys list");
    show(await context.keybindings.read());
    return 0;
  }
  if (action === "set") {
    const [reference, ...keys] = parsed.positionals;
    const id = command(reference);
    const state = await context.keybindings.set([{ id, keys }]);
    printResult(state, json, () => {
      console.log(
        keys.length
          ? `${id}: ${keys.map(formatKeyGlyphs).join(", ")}`
          : `${id}: unbound`,
      );
      for (const key of keys) {
        const warning = keyWarning(key);
        if (warning) console.error(`Note: ${warning}`);
      }
    });
    return 0;
  }
  if (action === "reset") {
    if (parsed.positionals.length > 1)
      throw new DaedalusError(
        "VALIDATION",
        "Usage: daedal keys reset [<command-id>]",
      );
    const [reference] = parsed.positionals;
    const state = reference
      ? await context.keybindings.set([{ id: command(reference), keys: null }])
      : await context.keybindings.resetAll();
    printResult(state, json, () =>
      console.log(
        reference
          ? `${reference}: default keys`
          : "Every command has its default keys",
      ),
    );
    return 0;
  }
  throw new DaedalusError("VALIDATION", `Unknown keys command '${action}'`);
}
