import { join } from "node:path";
import {
  type FileTreeWatcher,
  pathExists,
  readTextFile,
  watchFile,
  writeFileAtomic,
} from "@daedalus/platform";
import {
  type KeybindingChange,
  type KeybindingsDto,
  commandSpec,
  isCommandId,
  normalizeKey,
  reservedKeyReason,
  validateKeyOverrides,
} from "@daedalus/protocol";
import { DaedalusError } from "../errors";

/**
 * The person's own keys: `keybindings.json` in the Daedalus home, so each
 * channel has its own. It maps a command id to the keys that replace that
 * command's defaults; an empty list unbinds it:
 *
 *     { "palette.open": ["mod+shift+p"], "tab.close": [] }
 *
 * The desktop host reads it at start, watches it so a hand edit applies at
 * once, and writes it for Settings › Keyboard; `daedal keys` writes it from a
 * terminal. Anything in it that does not parse, names no command or binds a
 * reserved key is reported and skipped, never fatal.
 */
export const KEYBINDINGS_FILE = "keybindings.json";

export const keybindingsPath = (home: string): string =>
  join(home, KEYBINDINGS_FILE);

type RawFile = { value: Record<string, unknown> } | { error: string };

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length &&
  a.every((key, index) => normalizeKey(key) === normalizeKey(b[index] ?? ""));

export class KeybindingService {
  /** Writes run one after another, so two edits never lose one. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  /** The overrides that take effect, and what in the file was skipped. */
  async read(): Promise<KeybindingsDto> {
    const raw = await this.readRaw();
    if ("error" in raw)
      return {
        path: this.path,
        overrides: {},
        rejected: [{ id: "", reason: raw.error }],
      };
    const { overrides, rejected } = validateKeyOverrides(raw.value);
    return { path: this.path, overrides, rejected };
  }

  private async readRaw(): Promise<RawFile> {
    if (!(await pathExists(this.path))) return { value: {} };
    const text = await readTextFile(this.path);
    if (!text.trim()) return { value: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        error: `${KEYBINDINGS_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {
        error: `${KEYBINDINGS_FILE} must be an object of command ids to lists of keys`,
      };
    return { value: parsed as Record<string, unknown> };
  }

  /**
   * Writes some commands' keys together. Every change is checked first, so a
   * bad one writes nothing. A command set back to its defaults leaves the
   * file; the rest of the file, hand-written entries included, is kept.
   */
  set(changes: readonly KeybindingChange[]): Promise<KeybindingsDto> {
    return this.serial(async () => {
      for (const change of changes) {
        if (!isCommandId(change.id))
          throw new DaedalusError(
            "VALIDATION",
            `Unknown command '${String(change.id)}'`,
          );
        for (const key of change.keys ?? []) {
          try {
            normalizeKey(key);
          } catch (error) {
            throw new DaedalusError(
              "VALIDATION",
              error instanceof Error ? error.message : String(error),
            );
          }
          const reserved = reservedKeyReason(key);
          if (reserved)
            throw new DaedalusError(
              "VALIDATION",
              `${key} is reserved: ${reserved}`,
            );
        }
      }
      const raw = await this.readRaw();
      if ("error" in raw)
        throw new DaedalusError(
          "VALIDATION",
          `${raw.error}. Fix ${this.path} or reset all keys first.`,
        );
      const next: Record<string, unknown> = { ...raw.value };
      for (const { id, keys } of changes) {
        if (keys === null || sameKeys(keys, commandSpec(id).keys))
          delete next[id];
        else next[id] = keys.map((key) => key.trim());
      }
      await this.write(next);
      return this.read();
    });
  }

  /** Every command back to its default keys. */
  resetAll(): Promise<KeybindingsDto> {
    return this.serial(async () => {
      await this.write({});
      return this.read();
    });
  }

  /** The file, created empty when missing, so Finder has one to show. */
  ensureFile(): Promise<string> {
    return this.serial(async () => {
      if (!(await pathExists(this.path))) await this.write({});
      return this.path;
    });
  }

  /** Calls `onChange` after the file is written, replaced or removed. */
  watch(onChange: () => void, onError?: (error: Error) => void) {
    return watchFile({
      path: this.path,
      onChange,
      ...(onError ? { onError } : {}),
    }) satisfies FileTreeWatcher;
  }

  private write(value: Record<string, unknown>): Promise<void> {
    return writeFileAtomic(this.path, `${JSON.stringify(value, null, 2)}\n`, {
      ensureDir: true,
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
