import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createElectrobunClient } from "./rpc-client";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing renderer root");

const client = createElectrobunClient();

// The World and map windows load this same page and learn their role by
// asking: a `views://` URL carries no parameters. Anything but a clear "world" is the
// main app, so a failed question never leaves a window blank.
void client.request
  .windowRole({})
  .then(
    (response) =>
      response.ok ? response.data : { role: "main" as const, mapId: undefined },
    () => ({ role: "main" as const, mapId: undefined }),
  )
  .then(async ({ role, mapId }) => {
    if (role === "map" && mapId) {
      const { FlowMapWindow } = await import("./flow-map/FlowMapWindow");
      createRoot(root).render(
        <StrictMode>
          <FlowMapWindow client={client} mapId={mapId} />
        </StrictMode>,
      );
      return;
    }
    if (role === "world") {
      const { WorldWindow } = await import("./world/WorldWindow");
      createRoot(root).render(
        <StrictMode>
          <WorldWindow client={client} />
        </StrictMode>,
      );
      return;
    }
    createRoot(root).render(
      <StrictMode>
        <App injectedClient={client} />
      </StrictMode>,
    );
  });
