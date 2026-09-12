import { FitAddon, init, Terminal } from "ghostty-web";
import { useEffect, useRef, useState } from "react";
import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@daedalus/protocol";

export function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("connecting");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let terminal: Terminal | undefined;
    let socket: WebSocket | undefined;

    void (async () => {
      await init();
      if (disposed) return;
      terminal = new Terminal({
        cursorBlink: true,
        fontFamily: "SFMono-Regular, Menlo, Monaco, monospace",
        fontSize: 14,
        scrollback: 10_000,
        theme: {
          background: "#10131a",
          foreground: "#e6edf3",
          cursor: "#7ee787",
          selectionBackground: "#264f78",
        },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(container);
      fit.observeResize();
      fit.fit();

      const params = new URLSearchParams(window.location.search);
      const endpoint = params.get("terminal");
      if (!endpoint) {
        terminal.writeln(
          "\u001b[31mMissing terminal bridge endpoint. Start with Electrobun.\u001b[0m",
        );
        setStatus("offline");
        return;
      }

      socket = new WebSocket(endpoint);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        setStatus("connected");
        const resize: TerminalClientMessage = {
          type: "resize",
          cols: terminal?.cols ?? 80,
          rows: terminal?.rows ?? 24,
        };
        socket?.send(JSON.stringify(resize));
        terminal?.focus();
      };
      socket.onclose = () => setStatus("disconnected — reload to reconnect");
      socket.onerror = () => setStatus("connection error");
      socket.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          terminal?.write(new Uint8Array(event.data));
          return;
        }
        const message = JSON.parse(String(event.data)) as TerminalServerMessage;
        if (message.type === "status") setStatus(message.status);
        if (message.type === "error")
          terminal?.writeln(`\r\n\u001b[31m${message.message}\u001b[0m`);
      };
      terminal.onData((data) => {
        if (socket?.readyState !== WebSocket.OPEN) return;
        const input: TerminalClientMessage = { type: "input", data };
        socket.send(JSON.stringify(input));
      });
      terminal.onResize(({ cols, rows }) => {
        if (socket?.readyState !== WebSocket.OPEN) return;
        const resize: TerminalClientMessage = { type: "resize", cols, rows };
        socket.send(JSON.stringify(resize));
      });
    })();

    return () => {
      disposed = true;
      socket?.close();
      terminal?.dispose();
    };
  }, []);

  return (
    <main>
      <header>
        <div>
          <strong>Daedalus</strong>
          <span>Phase 0 terminal spike</span>
        </div>
        <output data-status={status}>{status}</output>
      </header>
      <div aria-label="tmux terminal" className="terminal" ref={containerRef} />
    </main>
  );
}
