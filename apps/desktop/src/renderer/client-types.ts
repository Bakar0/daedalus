import type { DesktopCommand, DesktopRpcSchema } from "@daedalus/protocol";

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
}
