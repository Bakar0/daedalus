import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createElectrobunClient } from "./rpc-client";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing renderer root");

createRoot(root).render(
  <StrictMode>
    <App injectedClient={createElectrobunClient()} />
  </StrictMode>,
);
