import type {
  DesktopCommand,
  DesktopRpcSchema,
  ShutdownPlanDto,
  WorkspaceFileChangeDto,
} from "@daedalus/protocol";

type Requests = DesktopRpcSchema["bun"]["requests"];

export type DesktopRequests = {
  [Name in keyof Requests]: (
    params: Requests[Name]["params"],
  ) => Promise<Requests[Name]["response"]>;
};

export interface DesktopClient {
  request: DesktopRequests;
  subscribe(listener: () => void): () => void;
  subscribeCommands(listener: (command: DesktopCommand) => void): () => void;
  subscribeWindowResize(listener: () => void): () => void;
  subscribeFocusSession(listener: (sessionId: string) => void): () => void;
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
}
