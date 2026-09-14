import { Electroview } from "electrobun/browser";
import type { DesktopRpcSchema } from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";

function defineRendererRpc() {
  return Electroview.defineRPC<DesktopRpcSchema>({
    handlers: {},
    maxRequestTime: 120_000,
  });
}

export function createElectrobunClient(): DesktopClient {
  const rpc = defineRendererRpc();
  new Electroview({ rpc });
  return {
    request: rpc.request,
    subscribe(listener) {
      rpc.addMessageListener("dataChanged", listener);
      return () => rpc.removeMessageListener("dataChanged", listener);
    },
    subscribeCommands(listener) {
      const receive = ({
        command,
      }: {
        command: Parameters<typeof listener>[0];
      }) => listener(command);
      rpc.addMessageListener("command", receive);
      return () => rpc.removeMessageListener("command", receive);
    },
    subscribeWindowResize(listener) {
      rpc.addMessageListener("windowResized", listener);
      return () => rpc.removeMessageListener("windowResized", listener);
    },
  };
}
