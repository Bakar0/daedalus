import { dirname, join } from "node:path";
import {
  type FileTreeWatcher,
  canonicalPath,
  ensureDirectory,
  movePath,
  pathExists,
  readTextFile,
  removeFile,
  watchFile,
  writeFileAtomic,
  writeTextFile,
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

/** How many times a write starts over when another process wrote first. */
const WRITE_ATTEMPTS = 5;

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length &&
  a.every((key, index) => normalizeKey(key) === normalizeKey(b[index] ?? ""));

function parseFile(text: string | undefined): RawFile {
  if (text === undefined || !text.trim()) return { value: {} };
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

const fileText = (value: Record<string, unknown>) =>
  `${JSON.stringify(value, null, 2)}\n`;

export interface KeybindingServiceOptions {
  /**
   * Runs after a write is prepared and before it is committed. Only tests
   * set it, to write the file from "another process" in between.
   */
  beforeCommit?: () => Promise<void>;
}

export class KeybindingService {
  /** Writes in this process run one after another. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly options: KeybindingServiceOptions = {},
  ) {}

  /** The overrides that take effect, and what in the file was skipped. */
  async read(): Promise<KeybindingsDto> {
    const raw = parseFile(await this.currentText(await this.target()));
    if ("error" in raw)
      return {
        path: this.path,
        overrides: {},
        rejected: [{ id: "", reason: raw.error }],
      };
    const { overrides, rejected } = validateKeyOverrides(raw.value);
    return { path: this.path, overrides, rejected };
  }

  /**
   * Writes some commands' keys together. Every change is checked first, so a
   * bad one writes nothing. A command set back to its defaults leaves the
   * file; the rest of the file, hand-written entries included, is kept.
   */
  set(changes: readonly KeybindingChange[]): Promise<KeybindingsDto> {
    for (const change of changes) {
      if (!isCommandId(change.id))
        return Promise.reject(
          new DaedalusError(
            "VALIDATION",
            `Unknown command '${String(change.id)}'`,
          ),
        );
      for (const key of change.keys ?? []) {
        try {
          normalizeKey(key);
        } catch (error) {
          return Promise.reject(
            new DaedalusError(
              "VALIDATION",
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
        const reserved = reservedKeyReason(key);
        if (reserved)
          return Promise.reject(
            new DaedalusError("VALIDATION", `${key} is reserved: ${reserved}`),
          );
      }
    }
    return this.update((before) => {
      const raw = parseFile(before);
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
      return fileText(next);
    });
  }

  /**
   * Every command back to its default keys, whatever the file held, even
   * when it is not valid JSON. A file with anything in it is copied to
   * `keybindings.json.bak` first, so a hand-written file is never lost.
   */
  resetAll(): Promise<KeybindingsDto> {
    return this.update(async (before) => {
      const raw = parseFile(before);
      const empty = "value" in raw && Object.keys(raw.value).length === 0;
      if (before !== undefined && !empty)
        await writeFileAtomic(`${this.path}.bak`, before);
      return fileText({});
    });
  }

  /** The file, created empty when missing, so Finder has one to show. */
  async ensureFile(): Promise<string> {
    await this.update((before) => before ?? fileText({}));
    return this.path;
  }

  /**
   * Calls `onChange` after the file is written, replaced or removed. A file
   * that is a symlink (into a dotfiles folder, say) is watched where it
   * points too, since an edit there does not touch the link.
   */
  watch(
    onChange: () => void,
    onError?: (error: Error) => void,
  ): FileTreeWatcher {
    const watch = (path: string) =>
      watchFile({ path, onChange, ...(onError ? { onError } : {}) });
    const watchers = [watch(this.path)];
    let closed = false;
    void this.target().then((target) => {
      if (!closed && target !== this.path) watchers.push(watch(target));
    });
    return {
      close() {
        closed = true;
        for (const watcher of watchers) watcher.close();
      },
    };
  }

  /** Where writes go: through a symlink, so the link stays a link. */
  private target(): Promise<string> {
    return canonicalPath(this.path).catch(() => this.path);
  }

  private async currentText(path: string): Promise<string | undefined> {
    return (await pathExists(path)) ? readTextFile(path) : undefined;
  }

  /**
   * A read-modify-write that another process (`daedal keys`, an editor)
   * cannot interleave with: the new text goes to a temporary file, and is
   * renamed over the file only if the file still holds what was read;
   * otherwise the whole update starts over from the newer file.
   */
  private update(
    change: (before: string | undefined) => string | Promise<string>,
  ): Promise<KeybindingsDto> {
    return this.serial(async () => {
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
        const target = await this.target();
        const before = await this.currentText(target);
        const text = await change(before);
        if (await this.commit(target, before, text)) return this.read();
      }
      throw new DaedalusError(
        "CONFLICT",
        `${this.path} kept changing while it was being written; try again`,
      );
    });
  }

  private async commit(
    target: string,
    before: string | undefined,
    text: string,
  ): Promise<boolean> {
    if (text === before) return true;
    await ensureDirectory(dirname(target));
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await writeTextFile(temporary, text);
      await this.options.beforeCommit?.();
      if ((await this.currentText(target)) !== before) return false;
      await movePath(temporary, target);
      return true;
    } finally {
      await removeFile(temporary);
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
