/**
 * Confirm and prompt, drawn by the page instead of the browser.
 *
 * `window.confirm` and `window.prompt` do nothing in the app. WKWebView only
 * shows them when its UI delegate implements the matching panel methods, and
 * Electrobun 1.18.1's delegate implements neither, so `confirm` answers
 * `false` and `prompt` answers `null` at once, with nothing on screen. Every
 * delete that asked first was therefore a button that did nothing (#40). The
 * browser checks never saw it: Chrome shows the native dialog and CDP accepts
 * it.
 *
 * One `DialogHost` is mounted by the app. Anything in the renderer can ask,
 * including components that have no route to the app's state, and gets a
 * promise for the answer. Requests queue, so two at once are asked in turn.
 */
import { useEffect, useState } from "react";

type Request = { id: number } & (
  | {
      kind: "confirm";
      title: string;
      message: string;
      confirmLabel: string;
      danger: boolean;
      enterConfirms: boolean;
      resolve: (answer: boolean) => void;
    }
  | {
      kind: "notice";
      title: string;
      message: string;
      resolve: (answer: "ok" | "never") => void;
    }
  | {
      kind: "text";
      title: string;
      message: string;
      initial: string;
      confirmLabel: string;
      resolve: (answer: string | null) => void;
    }
);

const queue: Request[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const announce = () => listeners.forEach((listener) => listener());

export function askConfirm(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  /** Styles the button as destructive and leaves focus on Cancel. */
  danger?: boolean;
  /**
   * Focuses the confirm button even when `danger` is set, so Enter answers
   * yes. For a request the user just made on purpose, like a delete key.
   */
  enterConfirms?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({
      id: nextId++,
      kind: "confirm",
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? "OK",
      danger: options.danger ?? false,
      enterConfirms: options.enterConfirms ?? false,
      resolve,
    });
    announce();
  });
}

/**
 * A hint with Got it and Don't show again. Resolves to `never` when the user
 * asked not to see it again; dismissing it any other way is `ok`.
 */
export function askNotice(options: {
  title: string;
  message: string;
}): Promise<"ok" | "never"> {
  return new Promise((resolve) => {
    queue.push({
      id: nextId++,
      kind: "notice",
      title: options.title,
      message: options.message,
      resolve,
    });
    announce();
  });
}

/** Resolves to the text entered, or `null` when cancelled. */
export function askText(options: {
  title: string;
  message: string;
  initial?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push({
      id: nextId++,
      kind: "text",
      title: options.title,
      message: options.message,
      initial: options.initial ?? "",
      confirmLabel: options.confirmLabel ?? "OK",
      resolve,
    });
    announce();
  });
}

export function DialogHost() {
  const [request, setRequest] = useState<Request | undefined>(queue[0]);
  const [text, setText] = useState("");
  useEffect(() => {
    const listener = () => setRequest(queue[0]);
    listeners.add(listener);
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (request?.kind === "text") setText(request.initial);
  }, [request]);
  if (!request) return null;

  const answer = (accepted: boolean) => {
    queue.shift();
    if (request.kind === "confirm") request.resolve(accepted);
    else if (request.kind === "notice") request.resolve("ok");
    else request.resolve(accepted ? text : null);
    announce();
  };
  const never = () => {
    queue.shift();
    if (request.kind === "notice") request.resolve("never");
    announce();
  };

  return (
    <div
      className="modal-backdrop app-dialog-backdrop"
      key={request.id}
      role="presentation"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        answer(false);
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) answer(false);
      }}
    >
      <section
        aria-label={request.title}
        aria-modal="true"
        className="modal app-dialog"
        data-dialog-kind={request.kind}
        role="alertdialog"
      >
        <div className="detail-title">
          <div>
            <span className="eyebrow">Daedalus</span>
            <h2>{request.title}</h2>
          </div>
        </div>
        <form
          className="confirmation-content"
          onSubmit={(event) => {
            event.preventDefault();
            answer(true);
          }}
        >
          <p className="app-dialog-message">{request.message}</p>
          {request.kind === "text" && (
            <input
              aria-label={request.title}
              autoFocus
              onChange={(event) => setText(event.target.value)}
              value={text}
            />
          )}
          {request.kind === "notice" ? (
            <div className="modal-actions">
              <button
                className="quiet"
                data-dialog-answer="never"
                onClick={never}
                type="button"
              >
                Don't show again
              </button>
              <button autoFocus data-dialog-answer="confirm" type="submit">
                Got it
              </button>
            </div>
          ) : (
            <div className="modal-actions">
              <button
                autoFocus={
                  request.kind === "confirm" &&
                  request.danger &&
                  !request.enterConfirms
                }
                className="quiet"
                data-dialog-answer="cancel"
                onClick={() => answer(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                autoFocus={
                  request.kind === "confirm" &&
                  (!request.danger || request.enterConfirms)
                }
                className={
                  request.kind === "confirm" && request.danger
                    ? "danger-action"
                    : undefined
                }
                data-dialog-answer="confirm"
                type="submit"
              >
                {request.confirmLabel}
              </button>
            </div>
          )}
        </form>
      </section>
    </div>
  );
}
