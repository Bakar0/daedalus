import { useEffect, useState } from "react";
import type { DesktopClient } from "../client-types";
import { useRpcQuery } from "../use-rpc";
import WorldView from "./WorldView";
import { buildWorldModel, worldInputFromSnapshot } from "./world-model";

/**
 * The World in a window of its own (#44): every workspace's agents, nothing
 * else, to keep open beside the main window or on another screen. It reads
 * the same snapshot and hears the same change notices as the main window.
 * A click on an agent brings the main window forward on that session,
 * where its terminal lives.
 */
export function WorldWindow(props: { client: DesktopClient }) {
  const { client } = props;
  const { data: snapshot = null } = useRpcQuery(
    () => client.request.snapshot({}),
    { onDataChanged: (listener) => client.subscribe(listener), deps: [client] },
  );
  const [now, setNow] = useState(Date.now());
  const [theme] = useState<"dark" | "light">(() => {
    try {
      return window.localStorage.getItem("daedalus.theme") === "light"
        ? "light"
        : "dark";
    } catch {
      return "dark";
    }
  });

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  // Active workspaces in the order the sidebar keeps them.
  const workspaces = (snapshot?.workspaces ?? [])
    .filter((item) => !item.archivedAt)
    .sort((left, right) => left.position - right.position);

  return (
    <main className="app world-window" data-theme={theme}>
      <WorldView
        appearance={theme}
        model={buildWorldModel(
          worldInputFromSnapshot(snapshot, workspaces, now),
        )}
        now={now}
        onOpenSession={(sessionId) =>
          void client.request.sessionFocus({ sessionId })
        }
        preview={!!snapshot && snapshot.settings.channel !== "stable"}
      />
    </main>
  );
}
