import {
  watchFileTree,
  type FileChange,
  type FileTreeWatcher,
} from "@daedalus/platform";
import { EventBus } from "../events";
import type { WorkspaceService } from "./workspaces";

export const WORKSPACE_FILES_CHANGED = "workspace.files.changed";

export interface WorkspaceFilesChanged {
  workspaceId: string;
  changes: FileChange[];
  /** The batch was too large to describe; re-read whatever is on screen. */
  overflow: boolean;
}

/**
 * One filesystem watcher per workspace the user actually has open, published
 * on the domain event bus.
 *
 * Deliberately not one per *existing* workspace. A watcher is a kernel
 * resource and a workspace nobody is looking at has no tree to keep fresh, so
 * the adapter says which one is open and this owns exactly that one. The
 * explorer is the only consumer today; `watch` is written to take more than
 * one so a second surface does not have to reopen this question.
 */
export class WorkspaceWatchService {
  readonly #watchers = new Map<string, FileTreeWatcher>();

  constructor(
    private readonly workspaces: WorkspaceService,
    readonly events: EventBus,
    private readonly onError?: (workspaceId: string, error: Error) => void,
  ) {}

  /** The workspace ids currently watched. Ordering is not meaningful. */
  get watching(): string[] {
    return [...this.#watchers.keys()];
  }

  /**
   * Makes the named workspaces — and only them — the watched set. Passing
   * nothing stops watching altogether, which is what a switch to the board or
   * a closed window does.
   */
  async watchOnly(references: readonly string[]): Promise<string[]> {
    const wanted = new Map<string, string>();
    for (const reference of references) {
      const workspace = await this.workspaces.get(reference);
      wanted.set(workspace.id, workspace.path);
    }
    for (const [workspaceId, watcher] of this.#watchers)
      if (!wanted.has(workspaceId)) {
        watcher.close();
        this.#watchers.delete(workspaceId);
      }
    for (const [workspaceId, path] of wanted) {
      if (this.#watchers.has(workspaceId)) continue;
      this.#watchers.set(
        workspaceId,
        watchFileTree({
          root: path,
          onChanges: ({ changes, overflow }) =>
            this.events.publish({
              id: crypto.randomUUID(),
              type: WORKSPACE_FILES_CHANGED,
              occurredAt: new Date().toISOString(),
              payload: {
                workspaceId,
                changes,
                overflow,
              } satisfies WorkspaceFilesChanged,
            }),
          // A watcher that fails is a tree that silently stops refreshing, so
          // the failure is reported rather than swallowed. The watcher is not
          // torn down: `fs.watch` raises transient errors (a directory
          // replaced under it, for one) that it recovers from on its own.
          onError: (error) => this.onError?.(workspaceId, error),
        }),
      );
    }
    return this.watching;
  }

  close(): void {
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
  }
}
