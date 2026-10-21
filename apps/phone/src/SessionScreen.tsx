import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalServerMessage } from "@daedalus/protocol";
import type { PhoneConnection, PhoneTerminal } from "@daedalus/remote-protocol";
import { AgentStatusDot } from "../../desktop/src/renderer/session-view";
import { type SessionRow, statusText } from "./sessions";
import { Shell } from "./Shell";
import {
  BACKSPACE,
  phoneTerminalInput,
  typingDiff,
  wheelReports,
} from "./terminal-input";

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

/** Rows a finger moves for one wheel notch. Three felt slow in Claude. */
const ROWS_PER_NOTCH = 1;
/** How much of a fling's speed is left after each 16 ms frame. */
const FLING_DECAY = 0.95;
/** Below this speed, in notches per millisecond, a fling stops. */
const FLING_STOP = 0.002;
/** Ctrl+End, which Claude's fullscreen view reads as "scroll to the bottom". */
const CTRL_END = "\u001b[1;5F";

/** The terminal's colours, on the theme's terminal background. */
const terminalTheme = () => ({
  background:
    getComputedStyle(document.documentElement)
      .getPropertyValue("--terminal-bg")
      .trim() || "#111112",
  foreground: "#e6e9ef",
  cursor: "#e6e9ef",
  selectionBackground: "#2a3a55",
});

/**
 * Answers an agent asks for most, one tap each: the words, then Enter. They
 * replace whatever is in the message box.
 */
const QUICK_REPLIES = ["Continue", "Yes", "No"];

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
  const [scrolledBack, setScrolledBack] = useState(false);
  const jumpToBottom = useRef<() => void>(undefined);

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
      theme: terminalTheme(),
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

    // A finger dragged up or down scrolls. tmux has the mouse, so the
    // terminal's own scrollback stays empty: the drag goes to tmux as wheel
    // reports, one for every ROWS_PER_NOTCH rows the finger moves, and a
    // quick drag keeps going after the finger lifts, slowing down.
    const screen = host.current;
    const cells = () => {
      const rect = xterm.element
        ?.querySelector(".xterm-screen")
        ?.getBoundingClientRect();
      return rect?.height ? rect : undefined;
    };
    // Notches scrolled back from the bottom, so Bottom knows how far to go.
    let back = 0;
    let at = { column: 1, row: 1 };
    const scroll = (steps: number) => {
      remote.write(wheelReports(steps, at.column, at.row));
      back = Math.max(0, back + steps);
      setScrolledBack(back > 0);
    };
    let drag: { y: number; notch: number } | undefined;
    // Recent finger positions, for the speed of a fling.
    let trail: Array<{ y: number; t: number }> = [];
    let fling = 0;
    const stopFling = () => {
      cancelAnimationFrame(fling);
      fling = 0;
    };
    const touchStart = (event: TouchEvent) => {
      stopFling();
      const finger = event.touches[0];
      const rect = cells();
      drag =
        event.touches.length === 1 && finger && rect
          ? {
              y: finger.clientY,
              notch: (rect.height / xterm.rows) * ROWS_PER_NOTCH,
            }
          : undefined;
      trail = finger ? [{ y: finger.clientY, t: event.timeStamp }] : [];
    };
    const touchMove = (event: TouchEvent) => {
      const finger = event.touches[0];
      const rect = cells();
      if (!drag || !finger || !rect) return;
      event.preventDefault();
      event.stopPropagation();
      trail = [
        ...trail.filter((point) => event.timeStamp - point.t < 100),
        { y: finger.clientY, t: event.timeStamp },
      ];
      const cell = (offset: number, size: number, count: number) =>
        Math.min(count, Math.max(1, Math.floor((offset / size) * count) + 1));
      at = {
        column: cell(finger.clientX - rect.left, rect.width, xterm.cols),
        row: cell(finger.clientY - rect.top, rect.height, xterm.rows),
      };
      const steps = Math.trunc((finger.clientY - drag.y) / drag.notch);
      if (!steps) return;
      drag.y += steps * drag.notch;
      scroll(steps);
    };
    const touchEnd = (event: TouchEvent) => {
      const first = trail[0];
      const last = trail.at(-1);
      const notch = drag?.notch;
      drag = undefined;
      trail = [];
      if (
        !first ||
        !last ||
        !notch ||
        last.t <= first.t ||
        event.timeStamp - last.t > 100
      )
        return;
      let speed = (last.y - first.y) / (last.t - first.t) / notch;
      let carried = 0;
      let then = performance.now();
      const frame = (now: number) => {
        const elapsed = now - then;
        then = now;
        carried += speed * elapsed;
        const steps = Math.trunc(carried);
        if (steps) {
          carried -= steps;
          scroll(steps);
        }
        speed *= FLING_DECAY ** (elapsed / 16);
        fling = Math.abs(speed) > FLING_STOP ? requestAnimationFrame(frame) : 0;
      };
      if (Math.abs(speed) > FLING_STOP) fling = requestAnimationFrame(frame);
    };
    // Claude's fullscreen view goes to the bottom on Ctrl+End. Anything else
    // scrolled in tmux's history, which closes once scrolled back to the
    // bottom, so the notches scrolled back go forward again too.
    jumpToBottom.current = () => {
      stopFling();
      remote.write(CTRL_END + wheelReports(-(back + 5), at.column, at.row));
      back = 0;
      setScrolledBack(false);
    };
    const capture = { capture: true, passive: false };
    screen.addEventListener("touchstart", touchStart, capture);
    screen.addEventListener("touchmove", touchMove, capture);
    screen.addEventListener("touchend", touchEnd, capture);
    screen.addEventListener("touchcancel", touchEnd, capture);

    // The keyboard opening and the phone turning both change the size.
    const resize = () => {
      fit.fit();
      remote.resize(Math.max(20, xterm.cols), Math.max(5, xterm.rows));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      stopFling();
      jumpToBottom.current = undefined;
      screen.removeEventListener("touchstart", touchStart, capture);
      screen.removeEventListener("touchmove", touchMove, capture);
      screen.removeEventListener("touchend", touchEnd, capture);
      screen.removeEventListener("touchcancel", touchEnd, capture);
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
  const reply = (words: string) => {
    type("");
    terminal.current?.write(`${words}\r`);
  };
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
        <div className="terminal-frame">
          <div className="terminal" ref={host} />
          {scrolledBack ? (
            <button
              className="jump-bottom"
              onClick={() => jumpToBottom.current?.()}
              type="button"
            >
              ↓ Bottom
            </button>
          ) : undefined}
        </div>
        {ended ? <p className="ended">{ended}</p> : undefined}
        <div
          className="quick-replies"
          role="toolbar"
          aria-label="Quick replies"
        >
          {QUICK_REPLIES.map((words) => (
            <button
              key={words}
              // No focus change on press, so the phone keyboard stays open.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => reply(words)}
              type="button"
            >
              {words}
            </button>
          ))}
        </div>
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
