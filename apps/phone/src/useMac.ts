import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopSnapshotDto, RpcResult } from "@daedalus/protocol";
import {
  type PairedMac,
  PhoneConnection,
  RELAY_CLOSE,
  RelayError,
} from "@daedalus/remote-protocol";
import { phoneIdentity } from "./storage";

export type MacState =
  | { kind: "connecting" }
  | { kind: "online"; connection: PhoneConnection }
  /** Retrying on its own: the Mac is closed or asleep, or the network is. */
  | { kind: "offline"; reason: string }
  /** Needs the user: signed out, no access, or this phone was removed. */
  | {
      kind: "blocked";
      code: "signed_out" | "no_access" | "removed";
      reason: string;
    };

const RETRY_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

/**
 * Keeps one end-to-end encrypted connection to a paired Mac, and its
 * snapshot fresh: re-read whenever the Mac says data changed.
 */
export function useMac(mac: PairedMac, token: string) {
  const [state, setState] = useState<MacState>({ kind: "connecting" });
  const [snapshot, setSnapshot] = useState<DesktopSnapshotDto>();
  const attempt = useRef(0);

  const load = useCallback(async (connection: PhoneConnection) => {
    const result = (await connection.request(
      "snapshot",
    )) as RpcResult<DesktopSnapshotDto>;
    if (result.ok) setSnapshot(result.data);
  }, []);

  useEffect(() => {
    let stopped = false;
    let current: PhoneConnection | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let waiting = false;

    const retry = (reason: string) => {
      if (stopped) return;
      setState({ kind: "offline", reason });
      const delay = RETRY_MS[Math.min(attempt.current, RETRY_MS.length - 1)]!;
      attempt.current += 1;
      waiting = true;
      timer = setTimeout(open, delay);
    };

    const open = async () => {
      if (stopped) return;
      waiting = false;
      try {
        const connection = await PhoneConnection.connect(
          phoneIdentity(),
          mac,
          token,
        );
        if (stopped) {
          connection.close();
          return;
        }
        current = connection;
        attempt.current = 0;
        connection.setVisible(document.visibilityState === "visible");
        setState({ kind: "online", connection });
        connection.onDataChanged(() => {
          if (refresh) clearTimeout(refresh);
          refresh = setTimeout(() => void load(connection), 250);
        });
        connection.onClose((reason) => retry(reason));
        await load(connection);
      } catch (error) {
        const code = error instanceof RelayError ? Number(error.code) : 0;
        const message = error instanceof Error ? error.message : String(error);
        if (code === RELAY_CLOSE.unauthorized)
          setState({ kind: "blocked", code: "signed_out", reason: message });
        else if (code === RELAY_CLOSE.noEntitlement)
          setState({ kind: "blocked", code: "no_access", reason: message });
        else if (
          code === RELAY_CLOSE.forbidden ||
          message.includes("not paired")
        )
          setState({ kind: "blocked", code: "removed", reason: message });
        else
          retry(
            message.includes("handshake")
              ? "Your Mac is not answering. Is Daedalus open with phone access on?"
              : message,
          );
      }
    };

    void open();
    // Coming back to the app after the phone slept: reconnect at once.
    // While on screen the app keeps telling the Mac so, which is how the Mac
    // knows not to push to a phone the user is already looking at.
    const report = () =>
      current?.setVisible(document.visibilityState === "visible");
    const heartbeat = setInterval(() => {
      if (document.visibilityState === "visible") report();
    }, 20_000);
    const wake = () => {
      report();
      if (document.visibilityState !== "visible" || stopped) return;
      if (waiting) {
        clearTimeout(timer);
        attempt.current = 0;
        void open();
      }
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (refresh) clearTimeout(refresh);
      document.removeEventListener("visibilitychange", wake);
      clearInterval(heartbeat);
      current?.close();
    };
  }, [mac, token, load]);

  return { state, snapshot };
}
