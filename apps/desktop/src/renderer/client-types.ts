import type {
  AppUpdateDto,
  KeybindingsDto,
  RendererCommandId,
  DesktopRpcSchema,
  ShutdownPlanDto,
  WorkspaceFileChangeDto,
} from "@daedalus/protocol";
import type { DataChange } from "./snapshot-parts";

type Requests = DesktopRpcSchema["bun"]["requests"];

export type DesktopRequests = {
  [Name in keyof Requests]: (
    params: Requests[Name]["params"],
  ) => Promise<Requests[Name]["response"]>;
};

export interface DesktopClient {
  request: DesktopRequests;
  /** Data changed; see `DataChange` for what the change says. */
  subscribe(listener: (change?: DataChange) => void): () => void;
  subscribeCommands(listener: (command: RendererCommandId) => void): () => void;
  subscribeWindowResize(listener: () => void): () => void;
  subscribeFocusSession(listener: (sessionId: string) => void): () => void;
  /** Optional so test clients need not stub it. */
  subscribeFocusTask?(listener: (taskId: string) => void): () => void;
  /**
   * A workspace's files changed on disk. Already coalesced and debounced by
   * the host; `overflow` means the batch was too large to describe and
   * `changes` is empty, so re-read whatever is on screen.
   */
  subscribeWorkspaceFiles(
    listener: (change: {
      workspaceId: string;
      changes: WorkspaceFileChangeDto[];
      overflow: boolean;
    }) => void,
  ): () => void;
  /** Quit was requested and something is still live. See `quitRequested`. */
  subscribeQuitRequest(listener: (plan: ShutdownPlanDto) => void): () => void;
  /** The update prompt changed. See `appUpdateChanged`. */
  subscribeAppUpdate?(
    listener: (update: AppUpdateDto | null) => void,
  ): () => void;
  /** `keybindings.json` changed. See `keybindingsChanged`. */
  subscribeKeybindings?(
    listener: (keybindings: KeybindingsDto) => void,
  ): () => void;
}
