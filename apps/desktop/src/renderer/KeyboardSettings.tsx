/**
 * Settings › Keyboard: every command with its keys, grouped and searchable
 * as the shortcuts sheet is, and a recorder to change them. The keys live in
 * `keybindings.json`, which the host owns: an edit here goes to the host by
 * RPC, the host writes the file and rebuilds the menu bar, and the window
 * takes the keys the host sends back, as it does for a hand edit.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type CommandGroup,
  type CommandId,
  type KeybindingChange,
  type KeybindingsDto,
  type RpcResult,
  commandSpec,
  formatKeyGlyphs,
  keyWarning,
  reservedKeyReason,
} from "@daedalus/protocol";
import {
  allCommands,
  applyKeybindings,
  clearedKeys,
  keyConflicts,
  keysWithout,
  recordKeyEvent,
  recordedKeys,
  suspendKeyDispatch,
  useKeybindings,
} from "./commands";
import type { DesktopClient } from "./client-types";
import { ConfirmButton } from "./ConfirmButton";
import { KeyGlyphs } from "./keyboard-ui";

/** A recorded key waiting for the person to accept what it costs. */
interface PendingKey {
  id: CommandId;
  key: string;
  conflicts: CommandId[];
  warning?: string;
  /** Why it cannot be bound at all; only Cancel is offered. */
  reserved?: string;
}

/** Puts focus back on a command's keys button, once its prompt is gone. */
const focusKeys = (id: CommandId) =>
  window.requestAnimationFrame(() =>
    document
      .querySelector<HTMLElement>(`[data-keys-for="${CSS.escape(id)}"]`)
      ?.focus(),
  );

/** Commands grouped by their table group, matching every word of `query`. */
export function keyboardSettingsGroups(
  commands: readonly {
    id: CommandId;
    title: string;
    group: CommandGroup;
    keys: readonly string[];
  }[],
  query: string,
) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map<CommandGroup, typeof commands>();
  for (const command of commands) {
    const haystack =
      `${command.title} ${command.group} ${command.id} ${command.keys.map(formatKeyGlyphs).join(" ")}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) continue;
    groups.set(command.group, [...(groups.get(command.group) ?? []), command]);
  }
  return [...groups.entries()].map(([group, rows]) => ({ group, rows }));
}

export function KeyboardSettings({
  client,
  perform,
}: {
  client: DesktopClient;
  perform: <T>(operation: Promise<RpcResult<T>>) => Promise<T | undefined>;
}) {
  const keybindings = useKeybindings();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<CommandId>();
  const [pending, setPending] = useState<PendingKey>();
  const commands = useMemo(
    // Recomputed when the keys change.
    () => (keybindings ? allCommands() : []),
    [keybindings],
  );
  const groups = keyboardSettingsGroups(commands, query);

  const save = async (changes: KeybindingChange[]) => {
    const state = await perform<KeybindingsDto>(
      client.request.keybindingsSet({ changes }),
    );
    if (state) applyKeybindings(state);
  };

  const accept = (next: PendingKey) =>
    void save([
      {
        id: next.id,
        keys: recordedKeys(next.id, next.key, keybindings.overrides),
      },
      ...next.conflicts.map((other) => ({
        id: other,
        keys: keysWithout(other, next.key, keybindings.overrides),
      })),
    ]).then(() => {
      setPending(undefined);
      focusKeys(next.id);
    });

  const cancel = (id: CommandId) => {
    setPending(undefined);
    focusKeys(id);
  };

  // While recording, every key press is the key being bound: the command
  // dispatcher is suspended, and the press is stopped before the dialog's
  // Escape, its Tab trap or the menu bar (WebKit hands a key the page
  // handled no further) can act on it.
  // The listeners below live as long as one recording; they read the keys
  // and the actions as they are when a key comes, not as they were when it
  // started.
  const latest = useRef({ keybindings, save, accept });
  latest.current = { keybindings, save, accept };
  useEffect(() => {
    if (!recording) return;
    const resume = suspendKeyDispatch();
    const onKey = (event: KeyboardEvent) => {
      const recorded = recordKeyEvent(event);
      // Text an input method is still composing is left to it.
      if (
        recorded.kind === "ignore" &&
        (event.isComposing || event.keyCode === 229)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (recorded.kind === "ignore") return;
      setRecording(undefined);
      if (recorded.kind === "cancel") return;
      const { keybindings, save, accept } = latest.current;
      if (recorded.kind === "clear") {
        void save([
          {
            id: recording,
            keys: clearedKeys(recording, keybindings.overrides),
          },
        ]);
        return;
      }
      const conflicts = keyConflicts(
        recording,
        recorded.key,
        keybindings.overrides,
      );
      // The host refuses a reserved key too; this says why before asking.
      const reserved = reservedKeyReason(recorded.key);
      const warning = keyWarning(recorded.key);
      const next: PendingKey = {
        id: recording,
        key: recorded.key,
        conflicts,
        ...(warning ? { warning } : {}),
        ...(reserved ? { reserved } : {}),
      };
      if (!conflicts.length && !warning && !reserved) accept(next);
      else setPending(next);
    };
    // A press anywhere else ends it; on its own button, the click does.
    const onPointer = (event: Event) => {
      const button =
        event.target instanceof Element
          ? event.target.closest("[data-keys-for]")
          : null;
      if (button?.getAttribute("data-keys-for") === recording) return;
      setRecording(undefined);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onPointer, true);
    window.addEventListener("blur", onPointer);
    return () => {
      resume();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("blur", onPointer);
    };
    // Only `recording` starts and ends it; the rest is read when a key comes.
  }, [recording]);

  return (
    <div className="keyboard-settings">
      <p className="settings-note">
        Click a shortcut, or focus it and press Enter, then press the new keys.
        The new key replaces the first one shown; a command&apos;s other keys
        stay. ⎋ cancels, ⌫ removes that first key. Your keys are kept in{" "}
        <code>keybindings.json</code>, which you can also edit by hand; a change
        there applies at once.
      </p>
      {keybindings.rejected.length > 0 && (
        <div className="error-banner" role="alert">
          <span>
            Skipped in keybindings.json:{" "}
            {keybindings.rejected
              .map((item) =>
                [item.id || "file", item.key, item.reason]
                  .filter(Boolean)
                  .join(" — "),
              )
              .join("; ")}
          </span>
        </div>
      )}
      <div className="keyboard-settings-actions">
        <input
          aria-label="Search shortcuts"
          className="shortcuts-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name or key"
          type="search"
          value={query}
        />
        <button
          className="quiet"
          onClick={() => void perform(client.request.keybindingsReveal({}))}
          type="button"
        >
          Show keybindings.json
        </button>
        <ConfirmButton
          armedLabel="Reset all"
          armedTitle="Put every shortcut back to its default"
          className="quiet"
          // Also for a file with entries that were skipped, or that is not
          // valid JSON: resetting is how the error goes away.
          disabled={
            Object.keys(keybindings.overrides).length === 0 &&
            keybindings.rejected.length === 0
          }
          onConfirm={() =>
            void perform<KeybindingsDto>(
              client.request.keybindingsReset({}),
            ).then((state) => state && applyKeybindings(state))
          }
          type="button"
        >
          Reset all
        </ConfirmButton>
      </div>
      {groups.map(({ group, rows }) => (
        <section
          aria-label={group}
          className="keyboard-settings-group"
          key={group}
        >
          <h3>{group}</h3>
          {rows.map((command) => {
            const changed = keybindings.overrides[command.id] !== undefined;
            const isRecording = recording === command.id;
            return (
              <div className="keyboard-settings-row" key={command.id}>
                <span className="keyboard-settings-title">
                  {command.title}
                  {changed && (
                    <span className="keyboard-settings-changed">Changed</span>
                  )}
                </span>
                <button
                  aria-label={`${command.title}: ${
                    command.keys.length
                      ? command.keys.map(formatKeyGlyphs).join(" or ")
                      : "no shortcut"
                  }. Press Enter to record a key in place of ${
                    command.keys.length ? "the first" : "none"
                  }.`}
                  aria-pressed={isRecording}
                  className="quiet keyboard-settings-keys"
                  data-keys-for={command.id}
                  onClick={() => {
                    setPending(undefined);
                    setRecording(isRecording ? undefined : command.id);
                  }}
                  type="button"
                >
                  {isRecording ? (
                    <span className="keyboard-settings-recording">
                      Press keys…
                    </span>
                  ) : command.keys.length ? (
                    command.keys.map((key, index) => (
                      <span key={key}>
                        {index > 0 && <span className="shortcuts-or"> / </span>}
                        <KeyGlyphs glyphs={formatKeyGlyphs(key)} />
                      </span>
                    ))
                  ) : (
                    <span className="keyboard-settings-none">None</span>
                  )}
                </button>
                {changed ? (
                  <button
                    className="quiet keyboard-settings-reset"
                    onClick={() => void save([{ id: command.id, keys: null }])}
                    type="button"
                  >
                    Reset to default
                  </button>
                ) : (
                  <span className="keyboard-settings-reset" />
                )}
                {pending?.id === command.id && (
                  <div
                    className="keyboard-settings-pending"
                    onKeyDown={(event) => {
                      // Escape cancels the prompt, not the whole dialog.
                      if (event.key !== "Escape") return;
                      event.preventDefault();
                      cancel(pending.id);
                    }}
                    role="alert"
                  >
                    {pending.reserved ? (
                      <p>
                        <KeyGlyphs glyphs={formatKeyGlyphs(pending.key)} /> is
                        reserved: {pending.reserved}. Pick another key.
                      </p>
                    ) : null}
                    {!pending.reserved && pending.conflicts.length > 0 && (
                      <p>
                        <KeyGlyphs glyphs={formatKeyGlyphs(pending.key)} />{" "}
                        clashes with{" "}
                        {pending.conflicts
                          .map((other) => commandSpec(other).title)
                          .join(" and ")}
                        , which has that key, a key it starts, or a menu key
                        that fires first. Replacing takes those keys from{" "}
                        {pending.conflicts.length > 1 ? "them" : "it"}.
                      </p>
                    )}
                    {!pending.reserved && pending.warning && (
                      <p>{pending.warning}</p>
                    )}
                    {!pending.reserved &&
                      command.keys.length > 1 &&
                      command.keys[0] && (
                        <p>
                          It replaces{" "}
                          <KeyGlyphs
                            glyphs={formatKeyGlyphs(command.keys[0])}
                          />
                          ; the other keys stay.
                        </p>
                      )}
                    <div className="keyboard-settings-pending-actions">
                      {!pending.reserved && (
                        <button
                          autoFocus
                          onClick={() => accept(pending)}
                          type="button"
                        >
                          {pending.conflicts.length ? "Replace" : "Use it"}
                        </button>
                      )}
                      <button
                        autoFocus={Boolean(pending.reserved)}
                        className="quiet"
                        onClick={() => cancel(pending.id)}
                        type="button"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ))}
      {groups.length === 0 && (
        <p className="palette-empty" role="status">
          No command matches.
        </p>
      )}
    </div>
  );
}
