import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { RpcResult, TerminalServerMessage } from "@daedalus/protocol";
import type { PhoneConnection, PhoneTerminal } from "@daedalus/remote-protocol";
import { ACTIVITY_LABEL, type SessionRow } from "./Home";
import { Shell } from "./Shell";
import { phoneTerminalInput } from "./terminal-input";

/**
 * Keys a phone keyboard does not have, or hides. They go to the terminal as
 * the bytes a real keyboard would send. 1, 2 and 3 answer the permission
 * menus Claude and Codex show.
 */
const KEYS: Array<{ label: string; data: string; aria?: string }> = [
  { label: "Esc", data: "\u001b" },
  { label: "Tab", data: "\t" },
  { label: "⇧Tab", data: "\u001b[Z", aria: "Shift Tab" },
  { label: "↑", data: "\u001b[A", aria: "Up" },
  { label: "↓", data: "\u001b[B", aria: "Down" },
  { label: "1", data: "1" },
  { label: "2", data: "2" },
  { label: "3", data: "3" },
  { label: "^C", data: "\u0003", aria: "Control C" },
  { label: "⏎", data: "\r", aria: "Enter" },
];

const DARK = {
  background: "#0b0f17",
  foreground: "#e6e9ef",
  cursor: "#e6e9ef",
  selectionBackground: "#2a3a55",
};

export function SessionScreen({
  connection,
  row,
  onBack,
}: {
  connection: PhoneConnection;
  row: SessionRow;
  onBack: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<PhoneTerminal>(undefined);
  const [ended, setEnded] = useState<string>();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!host.current) return;
    const xterm = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: false,
      fontFamily: "ui-monospace, Menlo, monospace",
      fontSize: 11,
      scrollback: 2_000,
      theme: DARK,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(host.current);
    fit.fit();

    const remote = connection.openTerminal(
      row.session.id,
      { cols: Math.max(20, xterm.cols), rows: Math.max(5, xterm.rows) },
      (data) => xterm.write(data),
      (message: TerminalServerMessage) => {
        if (
          message.type === "status" &&
          (message.status === "exited" || message.status === "lost")
        )
          setEnded(
            message.status === "exited"
              ? "This session ended."
              : "This session was lost.",
          );
        else if (message.type === "error") setEnded(message.message);
      },
    );
    terminal.current = remote;
    const typing = xterm.onData((data) => {
      const input = phoneTerminalInput(data);
      if (input) remote.write(input);
    });

    // The keyboard opening and the phone turning both change the size.
    const resize = () => {
      fit.fit();
      remote.resize(Math.max(20, xterm.cols), Math.max(5, xterm.rows));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      typing.dispose();
      remote.close();
      terminal.current = undefined;
      xterm.dispose();
    };
  }, [connection, row.session.id]);

  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError(undefined);
    const result = (await connection.request("agentSend", {
      id: row.session.id,
      text: message,
    })) as RpcResult<unknown>;
    setSending(false);
    if (result.ok) setText("");
    else setError(result.error.message);
  };

  const clearAttention = () =>
    void connection.request("attentionClear", { sessionId: row.session.id });

  return (
    <Shell onBack={onBack} title={row.session.name}>
      <div className="session">
        <p className="session-meta">
          <span className="row-dot" data-activity={row.activity} />
          {ACTIVITY_LABEL[row.activity]}
          <span className="session-where">{row.task ?? row.workspace}</span>
        </p>
        {row.reason ? (
          <div className="reason">
            <p>{row.reason}</p>
            <button className="link" onClick={clearAttention}>
              Dismiss
            </button>
          </div>
        ) : undefined}
        <div className="terminal" ref={host} />
        {ended ? <p className="ended">{ended}</p> : undefined}
        <div className="keys" role="toolbar" aria-label="Keys">
          {KEYS.map((key) => (
            <button
              aria-label={key.aria ?? key.label}
              key={key.label}
              // Pointer down, not click, and no focus change: the phone
              // keyboard stays where it is.
              onPointerDown={(event) => {
                event.preventDefault();
                terminal.current?.write(key.data);
              }}
            >
              {key.label}
            </button>
          ))}
        </div>
        <form
          className="compose"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            aria-label="Message to the agent"
            enterKeyHint="send"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="Message the agent"
            rows={1}
            value={text}
          />
          <button className="button primary" disabled={!text.trim() || sending}>
            Send
          </button>
        </form>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : undefined}
      </div>
    </Shell>
  );
}
