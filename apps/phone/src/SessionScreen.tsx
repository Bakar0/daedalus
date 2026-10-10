import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalServerMessage } from "@daedalus/protocol";
import type { PhoneConnection, PhoneTerminal } from "@daedalus/remote-protocol";
import { AgentStatusDot } from "../../desktop/src/renderer/session-view";
import { type SessionRow, statusText } from "./sessions";
import { Shell } from "./Shell";
import { BACKSPACE, phoneTerminalInput, typingDiff } from "./terminal-input";

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
  { label: "⌫", data: BACKSPACE, aria: "Backspace" },
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

  useEffect(() => {
    if (!host.current) return;
    const xterm = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: false,
      fontFamily:
        '"Daedalus Terminal Symbols", ui-monospace, Menlo, "Roboto Mono", monospace',
      fontSize: 11,
      scrollback: 2_000,
      theme: DARK,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(host.current);
    // Typing goes through the message box, which keeps the box and the
    // agent's input line the same; a tap on the terminal opens no keyboard.
    xterm.textarea?.setAttribute("inputmode", "none");
    xterm.textarea?.setAttribute("readonly", "");
    // The symbol font arrives after the first paint; redraw once it is in.
    void document.fonts
      .load('11px "Daedalus Terminal Symbols"', "\u23fa")
      .then(() => xterm.refresh(0, xterm.rows - 1))
      .catch(() => undefined);
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

  // The message box types into the terminal as it changes, so the agent's
  // own input line always shows what is in the box. `typed` is what the
  // terminal has been sent since the last Send or Clear.
  const typed = useRef("");
  const type = (value: string) => {
    const keys = typingDiff(typed.current, value);
    if (keys) terminal.current?.write(keys);
    typed.current = value.replaceAll(/\r?\n/g, " ");
    setText(typed.current);
  };
  const send = () => {
    terminal.current?.write("\r");
    typed.current = "";
    setText("");
  };
  const clear = () => type("");
  const press = (data: string) => {
    // Backspace from the keys row deletes from the box too, so the two stay
    // the same; any other key edits only the terminal.
    if (data === BACKSPACE && typed.current) {
      type(Array.from(typed.current).slice(0, -1).join(""));
      return;
    }
    terminal.current?.write(data);
  };
  // A key fires on lifting a finger that did not move, so scrolling the row
  // presses nothing.
  const touch = useRef<{ x: number; y: number } | undefined>(undefined);

  const clearAttention = () =>
    void connection.request("attentionClear", { sessionId: row.session.id });

  return (
    <Shell onBack={onBack} title={row.session.name}>
      <div className="session">
        <p className="session-meta">
          <AgentStatusDot count={row.view.reasons.length} view={row.view} />
          {/* The reason has its own box below. */}
          {statusText({ ...row.view, detail: null })}
          <span className="session-where">
            {row.task ?? row.workspace?.name}
          </span>
        </p>
        {row.view.attention && row.view.reasons.length > 0 ? (
          <div className="reason">
            <p>{row.view.reasons.at(-1)?.text}</p>
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
              // No focus change on press, so the phone keyboard stays open.
              onMouseDown={(event) => event.preventDefault()}
              onPointerCancel={() => {
                touch.current = undefined;
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                touch.current = { x: event.clientX, y: event.clientY };
              }}
              onPointerMove={(event) => {
                const start = touch.current;
                if (
                  start &&
                  Math.hypot(event.clientX - start.x, event.clientY - start.y) >
                    8
                )
                  touch.current = undefined;
              }}
              onPointerUp={() => {
                if (touch.current) press(key.data);
                touch.current = undefined;
              }}
              type="button"
            >
              {key.label}
            </button>
          ))}
        </div>
        <form
          className="compose"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <textarea
            aria-label="Message to the agent"
            enterKeyHint="send"
            onChange={(event) => type(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            placeholder="Type to the agent"
            rows={1}
            value={text}
          />
          {text ? (
            <button className="button" onClick={clear} type="button">
              Clear
            </button>
          ) : undefined}
          <button className="button primary">Send</button>
        </form>
      </div>
    </Shell>
  );
}
