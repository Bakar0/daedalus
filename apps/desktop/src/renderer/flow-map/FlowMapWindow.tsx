import { useEffect, useState } from "react";
import type { DesktopSnapshotDto } from "@daedalus/protocol";
import type { DesktopClient } from "../client-types";
import { FlowMapPanel } from "./FlowMapPanel";
import { stageSessionsFrom } from "./model";

/**
 * A flow map in a window of its own (#65), to keep beside the main window
 * or on another screen. It reads the same snapshot and hears the same change
 * notices as the main window. A stage's session or a task opens in the main
 * window, which comes forward.
 */
export function FlowMapWindow(props: { client: DesktopClient; mapId: string }) {
  const { client, mapId } = props;
  const [snapshot, setSnapshot] = useState<DesktopSnapshotDto | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
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
    let cancelled = false;
    const refresh = async () => {
      const response = await client.request.snapshot({});
      if (cancelled || !response.ok) return;
      setSnapshot(response.data);
      setRevision((value) => value + 1);
    };
    void refresh();
    const unsubscribe = client.subscribe(() => void refresh());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client]);

  const map = snapshot?.flowMaps.find((item) => item.id === mapId);
  return (
    <main className="app flow-map-window" data-theme={theme}>
      {!snapshot ? (
        <div className="empty large">Loading the map…</div>
      ) : !map ? (
        <div className="empty large">This map was deleted.</div>
      ) : (
        <FlowMapPanel
          client={client}
          dataRevision={revision}
          mapId={map.id}
          maps={[map]}
          onError={setError}
          onOpenSession={(session) =>
            void client.request.sessionFocus({ sessionId: session.id })
          }
          onOpenTask={(task) =>
            void client.request.taskFocus({ taskId: task.id })
          }
          onSelectMap={() => {}}
          sessions={stageSessionsFrom(snapshot)}
          tasks={new Map(snapshot.tasks.map((task) => [task.id, task]))}
          windowed
        />
      )}
      {error ? <p className="flow-map-window-error">{error}</p> : null}
    </main>
  );
}
