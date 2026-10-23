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
      kind: "text";
      title: string;
      message: string;
      initial: string;
      confirmLabel: string;
      resolve: (answer: string | null) => void;
    }
  | {
      kind: "choose";
      title: string;
      message: string;
      options: ChooseOption[];
      initial: string[];
      /** At most this many may be chosen. */
      limit?: number;
      confirmLabel: string;
      resolve: (answer: string[] | null) => void;
    }
  | {
      kind: "choice";
      title: string;
      message: string;
      lines: string[];
      choices: { id: string; label: string; danger?: boolean }[];
      resolve: (answer: string | null) => void;
    }
);

export interface ChooseOption {
  id: string;
  label: string;
  /** A second, quieter part of the row, such as a size. */
  detail?: string;
}

/**
 * Text that may come from outside this Mac, such as a pod, cut to a length
 * the dialog can hold. React renders it as text, never as markup.
 */
export const plainLine = (text: string, max = 160): string => {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

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

/**
 * Resolves to the ids chosen, or `null` when cancelled. With `limit`, the
 * confirm button stays off while more than that are chosen.
 */
export function askChoose(options: {
  title: string;
  message: string;
  options: ChooseOption[];
  initial?: string[];
  limit?: number;
  confirmLabel?: string;
}): Promise<string[] | null> {
  return new Promise((resolve) => {
    queue.push({
      id: nextId++,
      kind: "choose",
      title: options.title,
      message: options.message,
      options: options.options,
      initial: options.initial ?? [],
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      confirmLabel: options.confirmLabel ?? "OK",
      resolve,
    });
    announce();
  });
}

/** One of several answers, by id, or `null` when cancelled. */
export function askChoice(options: {
  title: string;
  message: string;
  /** Listed under the message, one per line, as plain text. */
  lines?: string[];
  choices: { id: string; label: string; danger?: boolean }[];
}): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push({
      id: nextId++,
      kind: "choice",
      title: options.title,
      message: options.message,
      lines: options.lines ?? [],
      choices: options.choices,
      resolve,
    });
    announce();
  });
}

export function DialogHost() {
  const [request, setRequest] = useState<Request | undefined>(queue[0]);
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
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
    if (request?.kind === "choose") setChosen(new Set(request.initial));
  }, [request]);
  if (!request) return null;

  const answer = (accepted: boolean) => {
    queue.shift();
    if (request.kind === "confirm") request.resolve(accepted);
    else if (request.kind === "text") request.resolve(accepted ? text : null);
    else if (request.kind === "choose")
      request.resolve(
        accepted
          ? request.options
              .map((option) => option.id)
              .filter((id) => chosen.has(id))
          : null,
      );
    else request.resolve(null);
    announce();
  };
  const choose = (id: string) => {
    if (request.kind !== "choice") return;
    queue.shift();
    request.resolve(id);
    announce();
  };
  const overLimit =
    request.kind === "choose" &&
    request.limit !== undefined &&
    chosen.size > request.limit;

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
          {request.kind === "choose" && (
            <div className="app-dialog-options" data-testid="dialog-options">
              {request.options.map((option) => (
                <label className="app-dialog-option" key={option.id}>
                  <input
                    checked={chosen.has(option.id)}
                    data-option={option.id}
                    onChange={(event) =>
                      setChosen((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(option.id);
                        else next.delete(option.id);
                        return next;
                      })
                    }
                    type="checkbox"
                  />
                  <span className="app-dialog-option-label">
                    {plainLine(option.label, 80)}
                  </span>
                  {option.detail && (
                    <small>{plainLine(option.detail, 40)}</small>
                  )}
                </label>
              ))}
              {request.limit !== undefined && (
                <small
                  className="app-dialog-count"
                  data-over={overLimit ? "true" : undefined}
                >
                  {chosen.size} of at most {request.limit} chosen
                </small>
              )}
            </div>
          )}
          {request.kind === "choice" && request.lines.length > 0 && (
            <ul className="app-dialog-lines" data-testid="dialog-lines">
              {request.lines.map((line, index) => (
                <li key={index}>{plainLine(line)}</li>
              ))}
            </ul>
          )}
          {request.kind === "choice" ? (
            <div className="modal-actions">
              <button
                className="quiet"
                data-dialog-answer="cancel"
                onClick={() => answer(false)}
                type="button"
              >
                Cancel
              </button>
              {request.choices.map((choice, index) => (
                <button
                  autoFocus={index === 0 && !choice.danger}
                  className={choice.danger ? "danger-action" : undefined}
                  data-dialog-answer={choice.id}
                  key={choice.id}
                  onClick={() => choose(choice.id)}
                  type="button"
                >
                  {choice.label}
                </button>
              ))}
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
                disabled={overLimit}
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
