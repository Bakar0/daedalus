import { createRoot } from "react-dom/client";
import { sodiumReady } from "@daedalus/remote-protocol";
import { App } from "./App";
import "./styles.css";

// The device key and every message need libsodium loaded first.
await sodiumReady();
createRoot(document.getElementById("root")!).render(<App />);
