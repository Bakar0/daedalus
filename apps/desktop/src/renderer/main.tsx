import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createElectrobunClient } from "./rpc-client";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing renderer root");

const client = createElectrobunClient();

// The World window loads this same page and learns its role by asking: a
// `views://` URL carries no parameters. Anything but a clear "world" is the
// main app, so a failed question never leaves a window blank.
void client.request
  .windowRole({})
  .then(
    (response) => (response.ok ? response.data.role : "main"),
    () => "main" as const,
  )
  .then(async (role) => {
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
