import type {
  AskDto,
  PlanMarkdownPartDto,
  PlanOwnerDto,
  PlanTaskDto,
  PlanTaskStateDto,
  PlanViewDto,
} from "@daedalus/protocol";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DesktopClient } from "../client-types";
import { OWNER_STATE_TEXT } from "./plan-owner";
import { markPlanTasks } from "../ActivityPage";

/**
 * A `.plan.md` file drawn as the document it describes: its markdown as
 * written, its tasks in place with their state, owner and details, and an
 * Ask on any selected text that goes to whoever owns that part.
 *
 * The parse is the core's (`planView`); this only draws it. Owners' live
 * states come with it, fetched again whenever `liveKey` says a session
 * moved.
 */

export interface PlanLive {
  /** Changes whenever a session's status, activity or attention does. */
  liveKey: string;
  workspaceName: string;
  openSession(sessionId: string): void;
}

export const isPlanPath = (path: string) => /\.plan\.md$/i.test(path);

interface PlanViewProps {
  client: DesktopClient;
  workspaceId: string;
  path: string;
  text: string;
  live?: PlanLive;
  /** The task's agent started; the file on disk now says so. */
  onFileChanged(content: string): void;
  onError(message: string): void;
  /** Drawn before the first parse comes back; tests render with it. */
  initialView?: PlanViewDto;
}

interface AskTarget {
  owner: string | null;
  quote: string;
  startLine: number;
  endLine: number;
  top: number;
  left: number;
}

const STATE_LABEL: Record<PlanTaskStateDto, string> = {
  todo: "To do",
  doing: "Doing",
  done: "Done",
  blocked: "Blocked",
  dropped: "Dropped",
};

function StateMark({ state }: { state: PlanTaskStateDto }) {
  const label = STATE_LABEL[state];
  return (
    <svg
      aria-label={label}
      className={`plan-mark plan-mark-${state}`}
      role="img"
      viewBox="0 0 14 14"
    >
      <title>{label}</title>
      {state === "done" ? (
        <>
          <circle cx="7" cy="7" r="7" className="fill" />
          <path d="M4 7.2l2 2 4-4.4" className="tick" />
        </>
      ) : state === "doing" ? (
        <>
          <circle cx="7" cy="7" r="6" className="ring" />
          {/* A still half circle: in progress, not a spinner. */}
          <path d="M7 1 A6 6 0 0 1 7 13 Z" className="fill" />
        </>
      ) : state === "blocked" ? (
        <>
          <circle cx="7" cy="7" r="6" className="ring" />
          <path d="M7 3.8v4M7 9.6v.6" className="bang" />
        </>
      ) : state === "dropped" ? (
        <>
          <circle cx="7" cy="7" r="6" className="ring" />
          <path d="M4 7h6" className="bang" />
        </>
      ) : (
        <circle cx="7" cy="7" r="6" className="ring" />
      )}
    </svg>
  );
}

function OwnerChip({ owner }: { owner: PlanOwnerDto }) {
  return (
    <span
      className={`plan-owner plan-owner-${owner.state}`}
      title={`@${owner.handle} · ${OWNER_STATE_TEXT[owner.state]}${owner.sessionName ? ` — ${owner.sessionName}` : ""}`}
    >
      <span aria-hidden="true" className="plan-owner-dot" />@{owner.handle}
    </span>
  );
}

type LinedProps = ExtraProps &
  HTMLAttributes<HTMLElement> & { children?: ReactNode };

const LINED_TAGS = [
  "p",
  "li",
  "pre",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
] as const;

/** Block elements carry their source lines, so a selection knows them. */
function lineComponents(startLine: number): Components {
  const out: Record<string, (props: LinedProps) => ReactNode> = {};
  for (const tag of LINED_TAGS) {
    const Tag = tag as ElementType;
    out[tag] = ({ node, ...props }: LinedProps) => {
      const position = node?.position;
      return (
        <Tag
          {...props}
          {...(position
            ? {
                "data-l0": startLine + position.start.line - 1,
                "data-l1": startLine + position.end.line - 1,
              }
            : {})}
        />
      );
    };
  }
  return out as Components;
}

function PlanMarkdown({ part }: { part: PlanMarkdownPartDto }) {
  const components = useMemo(
    () => lineComponents(part.startLine),
    [part.startLine],
  );
  return (
    <div
      className="markdown-body plan-markdown"
      data-l0={part.startLine}
      data-l1={part.endLine}
    >
      <Markdown components={components} remarkPlugins={[remarkGfm]}>
        {part.text}
      </Markdown>
    </div>
  );
}

const INLINE: Components = {
  p: ({ children }) => <>{children}</>,
};

function InlineMarkdown({ text }: { text: string }) {
  return (
    <Markdown components={INLINE} remarkPlugins={[remarkGfm]}>
      {text}
    </Markdown>
  );
}

function walkTasks(
  parts: PlanViewDto["blocks"] | PlanTaskDto["body"],
  owner: string | null,
  visit: (task: PlanTaskDto, owner: string | null) => void,
) {
  for (const part of parts) {
    if (part.kind !== "task") continue;
    const answers = part.task.owner ?? owner;
    visit(part.task, answers);
    walkTasks(part.task.body, answers, visit);
  }
}

interface Question {
  task: PlanTaskDto;
  text: string;
  line: number;
  owner: string | null;
}

interface TaskActions {
  owners: Map<string, PlanOwnerDto>;
  folded: Set<string>;
  toggle(key: string): void;
  starting: string | undefined;
  start(task: PlanTaskDto): void;
  open(sessionId: string): void;
  /** Tasks an open ask is pinned to, and those held behind them, by id. */
  waits: Map<string, { mark: "wait" | "held"; ask: number }>;
}

function TaskItem({
  task,
  owner,
  actions,
}: {
  task: PlanTaskDto;
  /** Who answers for the task: its own owner, else its parent's or the plan's. */
  owner: string | null;
  actions: TaskActions;
}) {
  const own = task.owner ? actions.owners.get(task.owner) : undefined;
  const hasBody = task.body.length > 0;
  const folded = actions.folded.has(task.key);
  const finished = task.state === "done" || task.state === "dropped";
  const waiting = task.id ? actions.waits.get(task.id) : undefined;
  const canStart =
    !finished &&
    (!own || own.state === "none" || own.state === "stopped") &&
    actions.starting !== task.key;
  return (
    <li
      className={`plan-task plan-task-${task.state} ${task.depth ? "plan-subtask" : ""} ${waiting ? `plan-task-${waiting.mark}` : ""}`}
      data-owner={owner ?? ""}
      data-task={task.key}
    >
      <div className="plan-task-line" data-l0={task.line} data-l1={task.line}>
        <button
          aria-expanded={hasBody ? !folded : undefined}
          aria-hidden={hasBody ? undefined : true}
          aria-label={hasBody ? (folded ? "Unfold" : "Fold") : undefined}
          className={`plan-fold ${hasBody ? "" : "none"}`}
          onClick={() => hasBody && actions.toggle(task.key)}
          tabIndex={hasBody ? 0 : -1}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 10 10">
            <path d="M2 3.5l3 3 3-3" />
          </svg>
        </button>
        <StateMark state={task.state} />
        <span className="plan-task-title">
          <InlineMarkdown text={task.title} />
        </span>
        {waiting && (
          <span
            className={`plan-wait-tag ${waiting.mark}`}
            title={
              waiting.mark === "wait"
                ? "A question waits on you under Activity"
                : "Waits for the answer above it"
            }
          >
            {waiting.mark === "wait"
              ? `#${waiting.ask} waits on you`
              : `held by #${waiting.ask}`}
          </span>
        )}
        {own && <OwnerChip owner={own} />}
        {task.id && <span className="plan-task-id">^{task.id}</span>}
        <span className="plan-task-actions">
          {own?.sessionId && (
            <button
              className="plan-act"
              onClick={() => actions.open(own.sessionId!)}
              title={`Open ${own.sessionName ?? `@${own.handle}`}`}
              type="button"
            >
              Open
            </button>
          )}
          {(canStart || actions.starting === task.key) && (
            <button
              className="plan-act go"
              disabled={actions.starting !== undefined}
              onClick={() => actions.start(task)}
              title="Start an agent on this task, on the workspace's default provider"
              type="button"
            >
              {actions.starting === task.key ? "Starting…" : "Start agent"}
            </button>
          )}
        </span>
      </div>
      {hasBody && !folded && (
        <div className="plan-task-body">
          {task.body.map((part) =>
            part.kind === "markdown" ? (
              <PlanMarkdown key={`m${part.startLine}`} part={part} />
            ) : part.kind === "question" ? (
              <p
                className="plan-question"
                data-l0={part.line}
                data-l1={part.line}
                key={`q${part.line}`}
              >
                <InlineMarkdown text={part.text} />
              </p>
            ) : (
              <ul className="plan-tasks" key={part.task.key}>
                <TaskItem
                  actions={actions}
                  owner={part.task.owner ?? owner}
                  task={part.task}
                />
              </ul>
            ),
          )}
        </div>
      )}
    </li>
  );
}

/** The lines of the plan a DOM node sits in, from the nearest marked element. */
function linesOf(node: Node | null): [number, number] | undefined {
  const element =
    node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
  const marked = (element as Element | null)?.closest<HTMLElement>("[data-l0]");
  if (!marked) return undefined;
  return [Number(marked.dataset.l0), Number(marked.dataset.l1)];
}

export function PlanView({
  client,
  workspaceId,
  path,
  text,
  live,
  onFileChanged,
  onError,
  initialView,
}: PlanViewProps) {
  const [view, setView] = useState<PlanViewDto | undefined>(initialView);
  const [failure, setFailure] = useState<string>();
  const [folded, setFolded] = useState<Set<string>>();
  const [starting, setStarting] = useState<string>();
  const [ask, setAsk] = useState<AskTarget>();
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const [askError, setAskError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ to: string; message: string }>();
  const scroller = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  // A plan changes under the user as agents write to it: parse it again
  // after a moment's quiet. The last view stays up meanwhile.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void client.request
        .planView({ workspace: workspaceId, path, text })
        .then((response) => {
          if (cancelled) return;
          if (response.ok) {
            setView(response.data);
            setFailure(undefined);
          } else setFailure(response.error.message);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, workspaceId, path, text, live?.liveKey]);

  // Finished tasks start folded; the rest open. Kept per task afterwards.
  useEffect(() => {
    if (!view || folded) return;
    const initial = new Set<string>();
    walkTasks(view.blocks, null, (task) => {
      if (task.state === "done" || task.state === "dropped")
        initial.add(task.key);
    });
    setFolded(initial);
  }, [view, folded]);

  const owners = useMemo(
    () => new Map((view?.owners ?? []).map((owner) => [owner.handle, owner])),
    [view],
  );

  // Open asks pinned to this plan's tasks, from Activity.
  const [asks, setAsks] = useState<AskDto[]>([]);
  useEffect(() => {
    let live = true;
    const read = () =>
      void client.request.askList({ plan: { workspaceId, path } }).then(
        (response) => {
          if (!live || !response.ok) return;
          setAsks(response.data.filter((ask) => ask.state === "open"));
        },
        () => undefined,
      );
    read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, 10_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [client, workspaceId, path]);
  const waits = useMemo(() => {
    const out = new Map<string, { mark: "wait" | "held"; ask: number }>();
    if (!view || !asks.length) return out;
    const flat: PlanTaskDto[] = [];
    walkTasks(view.blocks, view.owner, (task) => flat.push(task));
    const marks = markPlanTasks(flat, asks);
    flat.forEach((task, index) => {
      const mark = marks[index]!;
      if (task.id && mark.mark && mark.ask !== undefined)
        out.set(task.id, { mark: mark.mark, ask: mark.ask });
    });
    return out;
  }, [view, asks]);

  const { questions, done, total } = useMemo(() => {
    const questions: Question[] = [];
    let done = 0;
    let total = 0;
    if (view)
      walkTasks(view.blocks, view.owner, (task, owner) => {
        if (task.state !== "dropped") total += 1;
        if (task.state === "done") done += 1;
        if (task.state === "done" || task.state === "dropped") return;
        for (const part of task.body)
          if (part.kind === "question" && part.text)
            questions.push({ task, text: part.text, line: part.line, owner });
      });
    return { questions, done, total };
  }, [view]);

  const toggle = useCallback(
    (key: string) =>
      setFolded((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );

  const jump = (task: PlanTaskDto) => {
    setFolded((current) => {
      const next = new Set(current);
      next.delete(task.key);
      return next;
    });
    requestAnimationFrame(() =>
      article.current
        ?.querySelector(`[data-task="${CSS.escape(task.key)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  };

  const start = (task: PlanTaskDto) => {
    if (starting) return;
    setStarting(task.key);
    void client.request
      .planTaskStart({ workspace: workspaceId, path, task: task.key })
      .then((response) => {
        setStarting(undefined);
        if (!response.ok) {
          onError(response.error.message);
          return;
        }
        onFileChanged(response.data.content);
      });
  };

  const actions: TaskActions = {
    waits,
    owners,
    folded: folded ?? new Set(),
    toggle,
    starting,
    start,
    open: (sessionId) => live?.openSession(sessionId),
  };

  // Ask: any selection inside the document offers it, addressed to the
  // owner of the part the selection sits in.
  useEffect(() => {
    const onSelection = () => {
      if (asking) return;
      const selection = document.getSelection();
      const root = article.current;
      const box = scroller.current;
      const quote = selection?.toString().trim();
      if (
        !selection ||
        !quote ||
        selection.rangeCount === 0 ||
        !root ||
        !box ||
        !root.contains(selection.anchorNode) ||
        !root.contains(selection.focusNode)
      ) {
        setAsk(undefined);
        return;
      }
      const range = selection.getRangeAt(0);
      const from = linesOf(range.startContainer);
      const to = linesOf(range.endContainer);
      const common = range.commonAncestorContainer;
      const holder = (
        common.nodeType === Node.ELEMENT_NODE
          ? (common as Element)
          : common.parentElement
      )?.closest<HTMLElement>("[data-owner]");
      const rect = range.getBoundingClientRect();
      const frame = box.getBoundingClientRect();
      setAsk({
        owner: holder?.dataset.owner || null,
        quote,
        startLine: Math.min(from?.[0] ?? to?.[0] ?? 1, to?.[0] ?? Infinity),
        endLine: Math.max(from?.[1] ?? 1, to?.[1] ?? 1),
        top: rect.top - frame.top + box.scrollTop,
        left: Math.max(8, rect.left - frame.left + box.scrollLeft),
      });
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, [asking]);

  const openAsk = useCallback(() => {
    if (!ask) return;
    setAsking(true);
    setQuestion("");
    setAskError(undefined);
    requestAnimationFrame(() => textarea.current?.focus());
  }, [ask]);

  const closeAsk = useCallback(() => {
    setAsking(false);
    setAsk(undefined);
    setAskError(undefined);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "l" &&
        ask &&
        !asking
      ) {
        event.preventDefault();
        event.stopPropagation();
        openAsk();
      } else if (event.key === "Escape" && (ask || asking)) {
        closeAsk();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [ask, asking, openAsk, closeAsk]);

  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => setSent(undefined), 6000);
    return () => clearTimeout(timer);
  }, [sent]);

  const send = () => {
    if (!ask || sending) return;
    if (!question.trim()) {
      setAskError("Write a question first.");
      return;
    }
    setSending(true);
    void client.request
      .planAsk({
        workspace: workspaceId,
        path,
        owner: ask.owner,
        question,
        startLine: ask.startLine,
        endLine: ask.endLine,
        quote: ask.quote,
      })
      .then((response) => {
        setSending(false);
        if (!response.ok) {
          setAskError(response.error.message);
          return;
        }
        setSent({
          to: `@${ask.owner ?? view?.owner ?? ""}`,
          message: response.data.message,
        });
        closeAsk();
        document.getSelection()?.removeAllRanges();
      });
  };

  // Keeps the box inside the panel when the selection is near its edge.
  const [boxLeft, setBoxLeft] = useState(0);
  useLayoutEffect(() => {
    if (!ask || !scroller.current) return;
    const width = Math.min(420, scroller.current.clientWidth - 32);
    setBoxLeft(
      Math.max(
        16,
        Math.min(ask.left, scroller.current.clientWidth - width - 16),
      ),
    );
  }, [ask]);

  if (!view)
    return (
      <div className="editor-loading">{failure ?? "Reading the plan…"}</div>
    );

  const planOwner = view.owner ? owners.get(view.owner) : undefined;
  const askTo = ask ? (ask.owner ?? view.owner) : null;
  const askOwner = askTo ? owners.get(askTo) : undefined;
  const percent = total ? Math.round((done / total) * 100) : 0;
  const lines =
    ask && ask.endLine > ask.startLine
      ? `${ask.startLine}-${ask.endLine}`
      : `${ask?.startLine ?? ""}`;

  const blocks: ReactNode[] = [];
  let run: ReactNode[] = [];
  const flushTasks = () => {
    if (!run.length) return;
    blocks.push(
      <ul className="plan-tasks plan-tasks-top" key={`t${blocks.length}`}>
        {run}
      </ul>,
    );
    run = [];
  };
  for (const block of view.blocks) {
    if (block.kind === "task")
      run.push(
        <TaskItem
          actions={actions}
          key={block.task.key}
          owner={block.task.owner ?? view.owner}
          task={block.task}
        />,
      );
    else {
      flushTasks();
      blocks.push(<PlanMarkdown key={`m${block.startLine}`} part={block} />);
    }
  }
  flushTasks();

  return (
    <div className="plan-scroll" ref={scroller}>
      <article className="plan-doc" data-owner={view.owner ?? ""} ref={article}>
        <header className="plan-bar">
          <span className="plan-progress" title={`${done} of ${total} done`}>
            <span className="plan-progress-track" aria-hidden="true">
              <i style={{ width: `${percent}%` }} />
            </span>
            {percent}% · {done} of {total} tasks done
          </span>
          {planOwner && <OwnerChip owner={planOwner} />}
          <span className="plan-where">
            {live?.workspaceName ? `${live.workspaceName} · ` : ""}
            {path}
          </span>
        </header>
        {questions.length + asks.length > 0 && (
          <section className="plan-needs" aria-label="Waiting on you">
            <b>Waiting on you · {questions.length + asks.length}</b>
            {asks.map((item) => (
              <div key={`ask${item.id}`}>
                {item.sessionName ? `${item.sessionName}: ` : ""}
                <a
                  href={`#${item.taskKey ?? ""}`}
                  onClick={(event) => {
                    event.preventDefault();
                    let found: PlanTaskDto | undefined;
                    walkTasks(view.blocks, view.owner, (task) => {
                      if (task.id === item.taskKey) found = task;
                    });
                    if (found) jump(found);
                  }}
                >
                  #{item.id} {item.title}
                </a>{" "}
                <span className="plan-needs-where">answer under Activity</span>
              </div>
            ))}
            {questions.map((item) => (
              <div key={item.line}>
                {item.owner ? `@${item.owner}: ` : ""}
                <a
                  href={`#${item.task.key}`}
                  onClick={(event) => {
                    event.preventDefault();
                    jump(item.task);
                  }}
                >
                  {item.text}
                </a>
              </div>
            ))}
          </section>
        )}
        {!view.hasTasksSection && (
          <p className="plan-hint">
            Add a <code>## Tasks</code> section with lines like{" "}
            <code>- [ ] Title @owner ^id</code> to track work here.
          </p>
        )}
        {blocks.map((block, index) => (
          <Fragment key={index}>{block}</Fragment>
        ))}
      </article>

      {ask && !asking && (
        <button
          className="plan-ask-button"
          onClick={openAsk}
          onMouseDown={(event) => event.preventDefault()}
          style={{ top: Math.max(4, ask.top - 34), left: ask.left }}
          type="button"
        >
          Ask {askTo ? `@${askTo}` : "the owner"} <kbd>⌘L</kbd>
        </button>
      )}
      {ask && asking && (
        <div
          className="plan-ask-box"
          role="dialog"
          aria-label="Ask the owner"
          style={{ top: ask.top + 22, left: boxLeft }}
        >
          <div className="plan-ask-to">
            To <b>{askTo ? `@${askTo}` : "nobody"}</b>
            {askOwner && askOwner.state !== "none"
              ? ` (${OWNER_STATE_TEXT[askOwner.state]})`
              : ""}{" "}
            · {path.split("/").pop()}:{lines}
          </div>
          <div className="plan-ask-quote">{ask.quote}</div>
          <textarea
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            placeholder="Your question or instruction"
            ref={textarea}
            value={question}
          />
          {askError && <div className="plan-ask-error">{askError}</div>}
          <div className="plan-ask-row">
            <span className="plan-ask-to">Enter sends · Esc cancels</span>
            <button
              className="plan-send"
              disabled={sending || !askTo || askOwner?.state === "none"}
              onClick={send}
              type="button"
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      )}
      {sent && (
        <div className="plan-sent" role="status">
          Sent to {sent.to}. What it receives:
          <pre>{sent.message}</pre>
        </div>
      )}
    </div>
  );
}
