/**
 * The factory page: every plan of a workspace as a row of blocks. A block is
 * a task with one owner. A block that holds nested tasks, or whose session
 * is in a workflow run, opens in place as another row under its parent,
 * indented, so the path from the plan down stays on screen.
 *
 * The core builds the model (`factoryView`) and this draws it. Over the
 * plans float the chats (`FactoryChats`), one per agent: a box's chat icon
 * or its owner's chip opens one, and several stay open at once.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type {
  FactoryAgentRowDto,
  FactoryBlockDto,
  FactoryLevelDto,
  FactoryPageDto,
  FactoryPlanDto,
  PlanOwnerDto,
  ProviderModelCatalogDto,
  WorkflowFileDto,
} from "@daedalus/protocol";
import { accountModelKey } from "./account-models";
import {
  agentRowKey,
  factoryWhere,
  planRowKey,
  type FactoryWhere,
} from "./factory-where";
import { ToolIcon, providerLabel } from "./session-view";
import type { DesktopClient } from "./client-types";
import { MarkdownPreview } from "./markdown-preview";
import {
  CHAT_HEIGHT,
  CHAT_WIDTH,
  ChatLinks,
  FactoryChats,
  placeChat,
  useWorkspaceThreads,
  waitingBySession,
  type AgentLive,
  type ChatTabId,
  type ChatWindow,
  type FactoryAgent,
} from "./FactoryChats";

/** Opens an agent's chat on the page; a new `nonce` asks again. */
export interface ChatRequest {
  sessionId: string;
  handle: string;
  tab: ChatTabId;
  /** Direct's view to open on, when the asker knows it. */
  view?: "thread" | "terminal" | undefined;
  /** The agent's window is a tab: the request is for that tab, not the page. */
  docked?: boolean | undefined;
  nonce: number;
}
import { PLANS_CHANGED } from "./files/plan-actions";
import { OWNER_STATE_TEXT } from "./files/plan-owner";
import { blockTip } from "./factory-tip";
import { useBlockCard } from "./FactoryTip";
import { LayerWires, StepWires } from "./FactoryWires";
import "./factory.css";

/** How often the page reads again while shown: sessions move on their own. */
const REFRESH_MS = 5_000;

const isPlanChange = (path: string) =>
  path.endsWith(".plan.md") || /(^|\/)plans$/.test(path);

function useFactoryPage(
  client: DesktopClient,
  workspaceId: string,
  onError: (message: string) => void,
): FactoryPageDto | undefined {
  const [page, setPage] = useState<FactoryPageDto>();
  useEffect(() => {
    setPage(undefined);
    let live = true;
    const read = () =>
      void client.request.factoryView({ workspace: workspaceId }).then(
        (response) => {
          if (!live) return;
          if (response.ok) setPage(response.data);
          else onError(response.error.message);
        },
        () => undefined,
      );
    read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, REFRESH_MS);
    const unsubscribe = client.subscribeWorkspaceFiles(
      ({ workspaceId: changed, changes, overflow }) => {
        if (changed !== workspaceId) return;
        if (overflow || changes.some((change) => isPlanChange(change.path)))
          read();
      },
    );
    window.addEventListener("focus", read);
    window.addEventListener(PLANS_CHANGED, read);
    return () => {
      live = false;
      window.clearInterval(timer);
      unsubscribe();
      window.removeEventListener("focus", read);
      window.removeEventListener(PLANS_CHANGED, read);
    };
    // `onError` is the app's setter; a new identity must not restart reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId]);
  return page;
}

const PLAN_NOTE: Record<FactoryPlanDto["state"], string> = {
  waiting: "waits for you",
  working: "in progress",
  idle: "not started",
  done: "finished",
};

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** What a block says under its title. */
function blockNote(block: FactoryBlockDto): string {
  if (
    (block.kind === "plan" || block.kind === "agent") &&
    block.state !== "waiting"
  )
    return block.detail ?? block.kind;
  switch (block.state) {
    case "waiting":
      return "waits for you";
    case "doing":
      // What the agent said it would do in the step, or where it is.
      return block.detail ?? "in progress";
    case "done":
      return (
        (block.kind === "step" && block.detail) ||
        // What came out, without the lines that only name an output.
        block.result
          ?.split("\n")
          .find((line) => line.trim() && !/^[A-Za-z][\w-]* = /.test(line)) ||
        "done"
      );
    case "blocked":
      return "blocked";
    case "dropped":
      return block.kind === "step" ? "skipped" : "dropped";
    case "draft":
      return "draft, not ready";
    case "todo":
      return block.kind === "task" && block.owner
        ? `@${block.owner.handle}`
        : "not started";
  }
}

const counted = (level: FactoryLevelDto) => {
  const blocks = level.blocks.filter((block) => block.state !== "dropped");
  return {
    done: blocks.filter((block) => block.state === "done").length,
    total: blocks.length,
  };
};

/** How long ago, in the fewest words: "now", "4m", "1h 5m". */
function elapsed(since: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(since)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The time, read again every half minute while something shows it. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/** The agents at work inside a box, other than its own, once each. */
function membersOf(block: FactoryBlockDto): PlanOwnerDto[] {
  const found = new Map<string, PlanOwnerDto>();
  const walk = (level: FactoryLevelDto) => {
    for (const owner of [level.owner, ...level.blocks.map((b) => b.owner)])
      if (
        owner?.sessionId &&
        owner.sessionId !== block.owner?.sessionId &&
        !found.has(owner.sessionId)
      )
        found.set(owner.sessionId, owner);
    for (const inner of level.blocks) if (inner.inside) walk(inner.inside);
  };
  if (block.inside) walk(block.inside);
  return [...found.values()];
}

function Segments({ blocks }: { blocks: FactoryBlockDto[] }) {
  return (
    <span aria-hidden="true" className="factory-segs">
      {blocks.map((block) => (
        <span className={`factory-seg is-${block.state}`} key={block.key} />
      ))}
    </span>
  );
}

/** Opens an agent's chat, and how many of its asks wait for the user. */
const ChatContext = createContext<{
  client: DesktopClient;
  /** `draft` is put in the chat's typing box for the user to send. */
  open: (agent: FactoryAgent, about: string, draft?: string) => void;
  waiting: ReadonlyMap<string, { count: number; blocking: boolean }>;
} | null>(null);

/** Only a session that is there can be talked to. */
const canAsk = (owner: PlanOwnerDto | null): owner is PlanOwnerDto =>
  !!owner?.sessionId && owner.state !== "none" && owner.state !== "stopped";

/** On a box: opens its agent's chat, with a count when the agent asks. */
function ChatButton({
  about,
  owner,
  quiet,
}: {
  about: string;
  owner: PlanOwnerDto;
  /**
   * The agent is not at this box: its ask is counted on the box it is at,
   * not on every box it owns.
   */
  quiet?: boolean;
}) {
  const chats = useContext(ChatContext);
  if (!chats || !canAsk(owner)) return null;
  const waiting = quiet ? undefined : chats.waiting.get(owner.sessionId!);
  return (
    <button
      aria-label={`Open @${owner.handle}'s threads`}
      className={`factory-chat-button ${waiting ? "is-waiting" : ""}`}
      onClick={() =>
        chats.open({ sessionId: owner.sessionId!, handle: owner.handle }, about)
      }
      title={
        waiting
          ? `@${owner.handle} asks you something`
          : `Talk to @${owner.handle} while it works`
      }
      type="button"
    >
      <svg aria-hidden="true" viewBox="0 0 16 16">
        <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
      </svg>
      {waiting && <span>{waiting.count}</span>}
    </button>
  );
}

/** Every agent on the page that can be asked, once each. */
function agentsOf(page: FactoryPageDto | undefined): FactoryAgent[] {
  const found = new Map<string, FactoryAgent>();
  const walk = (level: FactoryLevelDto) => {
    for (const owner of [
      level.owner,
      ...level.blocks.map((block) => block.owner),
    ])
      if (canAsk(owner) && !found.has(owner.sessionId!))
        found.set(owner.sessionId!, {
          sessionId: owner.sessionId!,
          handle: owner.handle,
        });
    for (const block of level.blocks) if (block.inside) walk(block.inside);
  };
  for (const agent of page?.agents ?? []) walk(agent.level);
  for (const plan of page?.plans ?? []) walk(plan.level);
  return [...found.values()];
}

/**
 * Under a blocked box: the last thing its agent wrote, which is where it
 * said what stopped it, and a way to ask it. The plan's `[!]` holds no
 * reason of its own.
 */
function WhyBlocked({ block }: { block: FactoryBlockDto }) {
  const chats = useContext(ChatContext);
  const owner = block.owner;
  const sessionId = owner?.sessionId ?? null;
  const [last, setLast] = useState<string | null>();
  const client = chats?.client;
  useEffect(() => {
    setLast(undefined);
    if (!client || !sessionId) return;
    let live = true;
    void client.request.sessionMessages({ sessionId }).then(
      (response) => {
        if (!live) return;
        const messages = response.ok ? response.data : [];
        setLast(
          messages.filter((message) => message.role === "agent").at(-1)?.text ??
            null,
        );
      },
      () => {
        if (live) setLast(null);
      },
    );
    return () => {
      live = false;
    };
  }, [client, sessionId]);
  if (!owner) return null;
  return (
    <div className="factory-blocked">
      <span className="factory-kind">Why it is blocked</span>
      {last ? (
        <>
          <p className="factory-blocked-from">
            The last thing @{owner.handle} wrote:
          </p>
          <div className="factory-blocked-text">
            <MarkdownPreview
              source={last.length > 900 ? `${last.slice(0, 900)}…` : last}
            />
          </div>
        </>
      ) : (
        <p className="factory-detail-text">
          {last === undefined
            ? "Reading what the agent last wrote…"
            : `The plan gives no reason, and @${owner.handle} left no message.`}
        </p>
      )}
      {chats && canAsk(owner) && (
        <button
          className="factory-text-button"
          onClick={() =>
            chats.open(
              { sessionId: owner.sessionId!, handle: owner.handle },
              block.title,
              "Why is this blocked, and what do you need from me to continue?",
            )
          }
          type="button"
        >
          Ask @{owner.handle} why
        </button>
      )}
    </div>
  );
}

type StartProvider = "claude" | "codex";

/** What the start box offers: the workspace's agents and its defaults. */
export interface StartOptions {
  providers: readonly { id: StartProvider; available: boolean }[];
  defaultProvider: StartProvider;
  /** The account a session of each provider starts on. */
  accounts: Readonly<Record<StartProvider, string>>;
  /** The workspace's model per provider account (`accountModelKey`). */
  accountModels: Readonly<Record<string, string>>;
}

/** What the user chose in the start box; no model means the default. */
export interface StartChoice {
  provider: StartProvider;
  model?: string;
}

const CHEVRON = (
  <svg aria-hidden="true" viewBox="0 0 16 16">
    <path d="M4.5 6.5 8 10l3.5-3.5" />
  </svg>
);

/** A chip that opens a menu of choices over the page, one of them checked. */
function StartPick({
  children,
  disabled,
  label,
  options,
  onPick,
  value,
}: {
  /** What the chip shows. */
  children: React.ReactNode;
  disabled?: boolean | undefined;
  label: string;
  options: readonly {
    id: string;
    label: string;
    note?: string | undefined;
    icon?: React.ReactNode;
    disabled?: boolean | undefined;
  }[];
  onPick: (id: string) => void;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  // The menu closes on Escape and on a press anywhere outside it.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    const onPress = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPress, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPress, true);
    };
  }, [open]);
  return (
    <span className="factory-start-pick" ref={box}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className="chat-pick"
        disabled={disabled}
        onClick={() => setOpen((before) => !before)}
        title={label}
        type="button"
      >
        {children}
        {CHEVRON}
      </button>
      {open && (
        <div aria-label={label} className="chat-menu" role="menu">
          {options.map((option) => (
            <button
              aria-checked={option.id === value}
              disabled={option.disabled}
              key={option.id}
              onClick={() => {
                onPick(option.id);
                setOpen(false);
              }}
              role="menuitemradio"
              type="button"
            >
              {option.icon}
              <span className="chat-menu-name">{option.label}</span>
              {option.note && <small>{option.note}</small>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * The empty Factory: one box to say what the work is, with the agent and
 * the model that start on it. Sending starts that agent with those words
 * and opens its window.
 */
function StartPrompt({
  client,
  compact,
  onStart,
  onStartTerminal,
  options,
  workspaceName,
}: {
  /** Over the rows of a page that has some: one line, no question over it. */
  compact?: boolean | undefined;
  client: DesktopClient;
  onStart: (text: string, choice?: StartChoice) => Promise<boolean>;
  onStartTerminal?: (() => void) | undefined;
  options?: StartOptions | undefined;
  workspaceName: string;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const usable = options?.providers.filter((item) => item.available) ?? [];
  const [picked, setPicked] = useState<StartProvider | undefined>(undefined);
  const provider: StartProvider | undefined = usable.some(
    (item) => item.id === picked,
  )
    ? picked
    : usable.some((item) => item.id === options?.defaultProvider)
      ? options?.defaultProvider
      : usable[0]?.id;
  /** The model chosen per provider; none is the default. */
  const [models, setModels] = useState<Partial<Record<StartProvider, string>>>(
    {},
  );
  const [catalogs, setCatalogs] = useState<
    Partial<Record<string, ProviderModelCatalogDto | "failed">>
  >({});
  const account = provider ? (options?.accounts[provider] ?? "default") : "";
  const key = provider ? accountModelKey(provider, account) : "";
  const loaded = catalogs[key];
  const catalog = loaded === "failed" ? undefined : loaded;
  // Read for the account the agent would start on, once per account.
  useEffect(() => {
    if (!provider || loaded) return;
    let stale = false;
    void client.request
      .agentModels({
        provider,
        ...(account !== "default" ? { account } : {}),
      })
      .then(
        (response) => {
          if (!stale)
            setCatalogs((before) => ({
              ...before,
              [key]: response.ok ? response.data : "failed",
            }));
        },
        () => {
          if (!stale) setCatalogs((before) => ({ ...before, [key]: "failed" }));
        },
      );
    return () => {
      stale = true;
    };
  }, [account, client, key, loaded, provider]);
  const model = provider ? (models[provider] ?? "") : "";
  const labelOf = (id: string | undefined) =>
    id
      ? (catalog?.models.find(
          (item) => item.id === id || item.resolvedModel === id,
        )?.label ?? id)
      : undefined;
  const workspaceModel = options?.accountModels[key];
  const defaultLabel =
    labelOf(workspaceModel) ?? labelOf(catalog?.defaultModel) ?? "Automatic";
  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const started = await onStart(
        value,
        provider ? { provider, ...(model ? { model } : {}) } : undefined,
      );
      if (started) {
        setText("");
        // The new agent's row shows without waiting for the next read.
        window.dispatchEvent(new Event(PLANS_CHANGED));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`factory-start ${compact ? "is-compact" : ""}`}>
      {!compact && <strong>What do you want to do in {workspaceName}?</strong>}
      {/* While the agent is made, the words sent and what is happening. */}
      {busy && (
        <div aria-live="polite" className="factory-start-sent">
          <div className="chat-row is-you">
            <div className="chat-bubble">{text.trim()}</div>
          </div>
          <div className="chat-working">
            <span aria-hidden="true" className="chat-spin" />
            <span>
              Starting {provider ? providerLabel(provider) : "an agent"} on
              this. Its window opens here.
            </span>
          </div>
        </div>
      )}
      <div className="chat-foot" hidden={busy}>
        <textarea
          aria-label="Describe the work"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          // Over the rows it waits to be clicked: the page's keys stay free.
          autoFocus={!compact}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={
            compact
              ? "Start more work: describe it and press Enter. An agent starts on it."
              : "Describe the work. An agent starts on it and you talk here."
          }
          rows={Math.min(8, Math.max(compact ? 1 : 3, text.split("\n").length))}
          value={text}
        />
        <div className="chat-foot-row">
          {provider && options && (
            <>
              <StartPick
                label="Agent"
                onPick={(id) => setPicked(id as StartProvider)}
                options={options.providers.map((item) => ({
                  id: item.id,
                  label: providerLabel(item.id),
                  note: item.available ? undefined : "Unavailable",
                  disabled: !item.available,
                  icon: (
                    <span className={`factory-start-tool tool-${item.id}`}>
                      <ToolIcon tool={item.id} />
                    </span>
                  ),
                }))}
                value={provider}
              >
                <span className={`factory-start-tool tool-${provider}`}>
                  <ToolIcon tool={provider} />
                </span>
                <span>{providerLabel(provider)}</span>
              </StartPick>
              <StartPick
                disabled={!catalog}
                label="Model"
                onPick={(id) =>
                  setModels((before) => ({ ...before, [provider]: id }))
                }
                options={[
                  {
                    id: "",
                    label: "Default",
                    note: `${defaultLabel} · ${workspaceModel ? "this workspace's" : `${providerLabel(provider)}'s`}`,
                  },
                  ...(catalog?.models ?? []).map((item) => ({
                    id: item.id,
                    label: item.label,
                    note:
                      item.resolvedModel && item.resolvedModel !== item.label
                        ? item.resolvedModel
                        : undefined,
                  })),
                ]}
                value={model}
              >
                <span>
                  {!loaded
                    ? "Loading models…"
                    : model
                      ? labelOf(model)
                      : defaultLabel}
                </span>
              </StartPick>
            </>
          )}
          {compact && onStartTerminal && (
            <button
              className="chat-link factory-start-more"
              onClick={onStartTerminal}
              type="button"
            >
              More options
            </button>
          )}
          <button
            aria-label="Start"
            className="chat-send"
            disabled={busy || !text.trim()}
            onClick={() => void send()}
            title="Start an agent on this"
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16">
              <path d="M8 12.5v-9M4 7.5l4-4 4 4" />
            </svg>
          </button>
        </div>
      </div>
      {!compact && (
        <span className="factory-start-note">
          Enter sends, Shift+Enter is a new line
          {onStartTerminal && (
            <>
              {" · "}
              <button
                className="chat-link"
                onClick={onStartTerminal}
                type="button"
              >
                More options, or a terminal
              </button>
            </>
          )}
        </span>
      )}
    </div>
  );
}

const CHATS_KEY = "daedalus.factory.chats:";

/** The chat windows as the user left them in this workspace. */
function storedChats(workspaceId: string): ChatWindow[] {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(CHATS_KEY + workspaceId) ?? "[]",
    );
    if (!Array.isArray(stored)) return [];
    // A window left at the first default size, made for messages alone,
    // opens at the size that also fits the terminal.
    return (stored as ChatWindow[]).map((chat) =>
      chat.width === 400 && chat.height === 460
        ? { ...chat, width: CHAT_WIDTH, height: CHAT_HEIGHT }
        : chat,
    );
  } catch {
    return [];
  }
}

function OwnerChip({
  about,
  owner,
  onOpenSession,
}: {
  /** The box or level the owner is shown on: what its chat is about. */
  about: string;
  owner: PlanOwnerDto;
  onOpenSession: (sessionId: string) => void;
}) {
  const chats = useContext(ChatContext);
  const chat = chats && canAsk(owner);
  const label = `@${owner.handle}, ${OWNER_STATE_TEXT[owner.state]}`;
  const body = (
    <>
      <span className="factory-owner-dot" />
      <span className="factory-owner-handle">@{owner.handle}</span>
      <span className="factory-owner-state">
        {OWNER_STATE_TEXT[owner.state]}
      </span>
    </>
  );
  // A session that is gone has no window to open. Opening one would show
  // whichever session was on screen last.
  const there = owner.state !== "none" && owner.state !== "stopped";
  return owner.sessionId && there ? (
    <button
      aria-label={`${chat ? "Open the threads of" : "Open"} ${label}`}
      className={`factory-owner is-${owner.state}`}
      onClick={() =>
        chat
          ? chats.open(
              { sessionId: owner.sessionId!, handle: owner.handle },
              about,
            )
          : onOpenSession(owner.sessionId!)
      }
      title={
        chat
          ? `Open @${owner.handle}'s threads`
          : (owner.sessionName ?? undefined)
      }
      type="button"
    >
      {body}
    </button>
  ) : (
    <span
      className={`factory-owner is-${owner.state}`}
      title={
        owner.sessionId
          ? `@${owner.handle} finished and its session is archived. Restore it from the workspace's archived sessions to open it.`
          : undefined
      }
    >
      {body}
    </span>
  );
}

function Block({
  block,
  front,
  needs,
  open,
  selected,
  onClick,
}: {
  block: FactoryBlockDto;
  /** The titles of the boxes it waits for. */
  needs: readonly string[];
  /** The agent whose window is in front is at this box. */
  front: boolean;
  open: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const current = block.state === "doing" || block.state === "waiting";
  // Moving only while its agent works: a step an agent stopped in is still.
  const live =
    block.state === "doing" &&
    (block.owner ? block.owner.state === "working" : true);
  const timed = current && block.kind === "step" && !!block.startedAt;
  const now = useNow(timed);
  // A step shows what came out of it under the row; a task or an agent is
  // where a team works, so it names the team.
  const members = block.kind === "step" ? [] : membersOf(block);
  const hover = useBlockCard(() =>
    blockTip(
      block,
      needs,
      block.startedAt
        ? new Date(block.startedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : null,
    ),
  );
  return (
    <div className="factory-block-wrap">
      {hover.card}
      <button
        aria-expanded={block.inside ? open : undefined}
        aria-pressed={block.inside ? undefined : selected}
        className={`factory-block is-${block.state} ${live ? "is-live" : ""} ${open ? "is-open" : ""} ${selected ? "is-picked" : ""} ${front ? "is-front" : ""} ${block.inside ? "is-stack" : ""}`}
        data-block={block.key}
        onClick={onClick}
        {...hover.handlers}
        type="button"
      >
        <span className="factory-block-head">
          {block.state === "done" ? (
            <svg
              aria-hidden="true"
              className="factory-check"
              viewBox="0 0 10 10"
            >
              <path d="M2 5.2l2.1 2.1L8 3.1" />
            </svg>
          ) : (
            <span className="factory-dot" />
          )}
          <span className="factory-block-title">{block.title}</span>
          {timed && (
            <span
              className="factory-block-time"
              title={`Started ${new Date(block.startedAt!).toLocaleTimeString()}`}
            >
              {elapsed(block.startedAt!, now)}
            </span>
          )}
          {block.threads > 0 && (
            <span
              className="factory-threads"
              title={plural(block.threads, "open thread", "open threads")}
            >
              {block.threads}
            </span>
          )}
        </span>
        <span className="factory-block-note">{blockNote(block)}</span>
        {members.length > 0 && (
          <span className="factory-members">
            {members.slice(0, 4).map((member) => (
              <span
                className={`factory-member is-${member.state}`}
                key={member.sessionId}
                title={`@${member.handle}, ${OWNER_STATE_TEXT[member.state]}`}
              >
                <span className="factory-owner-dot" />
                {member.handle}
              </span>
            ))}
            {members.length > 4 && (
              <span className="factory-member">+{members.length - 4}</span>
            )}
          </span>
        )}
        <span className="factory-block-foot">
          {block.inside ? (
            <>
              <Segments blocks={block.inside.blocks} />
              <span className="factory-block-opens">
                {plural(counted(block.inside).total, "step", "steps")}
              </span>
              <svg
                aria-hidden="true"
                className="factory-block-open"
                viewBox="0 0 10 10"
              >
                <path d="M1.5 3l3.5 4 3.5-4" />
              </svg>
            </>
          ) : (
            <>
              <span className="factory-block-opens">details</span>
              <svg
                aria-hidden="true"
                className="factory-block-facts"
                viewBox="0 0 10 10"
              >
                <path d="M1.5 2.5h7M1.5 5h7M1.5 7.5h4.5" />
              </svg>
            </>
          )}
        </span>
      </button>
      {block.owner && (
        <ChatButton
          about={block.title}
          owner={block.owner}
          quiet={(block.kind === "step" || block.kind === "task") && !current}
        />
      )}
    </div>
  );
}

/** A level's blocks by column, left to right. */
function columnsOf(level: FactoryLevelDto): FactoryBlockDto[][] {
  const columns = new Map<number, FactoryBlockDto[]>();
  for (const block of level.blocks)
    columns.set(block.column, [...(columns.get(block.column) ?? []), block]);
  return [...columns.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, blocks]) => blocks);
}

/** The block picked in a plan, with nothing inside: its facts, under the rows. */
function Detail({
  block,
  file,
  step,
  onClose,
  onOpenPlan,
  onOpenSession,
  onOpenStep,
}: {
  block: FactoryBlockDto;
  /** The saved step the block ran, when its name is one. */
  step: WorkflowFileDto | undefined;
  onOpenStep?: ((name: string) => void) | undefined;
  /** The plan file the block is in; none for a step of an agent's own run. */
  file: string | undefined;
  onClose: () => void;
  onOpenPlan: (path: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <article className="factory-detail">
      <div className="factory-detail-head">
        <span className="factory-kind">
          {block.kind === "step"
            ? "Step"
            : block.kind === "plan"
              ? "Plan"
              : block.kind === "agent"
                ? "Agent"
                : "Task"}
        </span>
        <span className={`factory-state is-${block.state}`}>
          <span className="factory-dot" />
          {block.state === "waiting" ? "waits for you" : block.state}
        </span>
        {block.owner && (
          <OwnerChip
            about={block.title}
            onOpenSession={onOpenSession}
            owner={block.owner}
          />
        )}
        <button
          aria-label="Close"
          className="factory-icon-button factory-detail-close"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </div>
      <h2 className="factory-detail-title">{block.title}</h2>
      {block.description && (
        <p className="factory-detail-text">{block.description}</p>
      )}
      {block.questions.length > 0 && (
        <div className="factory-questions">
          <span className="factory-kind">
            {plural(block.questions.length, "Question", "Questions")} for you
          </span>
          {block.questions.map((question) => (
            <p className="factory-detail-text" key={question}>
              {question}
            </p>
          ))}
        </div>
      )}
      {block.state === "blocked" && <WhyBlocked block={block} />}
      {block.result && (
        <div className="factory-result">
          <span className="factory-kind">Result</span>
          <p className="factory-detail-text">{block.result}</p>
        </div>
      )}
      {block.detail && (
        <p className="factory-detail-text factory-detail-result">
          {block.detail}
        </p>
      )}
      {step && (step.tools ?? []).length > 0 && (
        <div className="factory-step-tools">
          <span className="factory-kind">Tools the step suggests</span>
          <span className="factory-step-tool-list">
            {(step.tools ?? []).map((tool) => (
              <span className="factory-step-tool" key={tool}>
                {tool}
              </span>
            ))}
          </span>
        </div>
      )}
      <div className="factory-detail-links">
        {step && onOpenStep && (
          <button
            className="factory-text-button factory-step-link"
            onClick={() => onOpenStep(step.name)}
            type="button"
          >
            Open the {step.name} step
          </button>
        )}
        {block.threads > 0 && (
          <span>{plural(block.threads, "open thread", "open threads")}</span>
        )}
        {file && (
          <button
            className="factory-text-button"
            onClick={() => onOpenPlan(file)}
            type="button"
          >
            {block.line ? `${file}:${block.line}` : file}
          </button>
        )}
      </div>
    </article>
  );
}

/** Whether something in the level is being worked on or waits. */
const lively = (level: FactoryLevelDto): boolean =>
  level.blocks.some(
    (block) =>
      block.state === "doing" ||
      block.state === "waiting" ||
      (block.inside ? lively(block.inside) : false),
  );

/**
 * The blocks a row opens by itself, from the top down: at each level the
 * one holding work that is going on, and in a workflow, failing that, the
 * last step that holds anything. It stops at a plan, whose tasks the user
 * opens.
 */
function openedAtFirst(root: FactoryLevelDto): string[] {
  const path: string[] = [];
  let level: FactoryLevelDto | null = root;
  while (level && level.kind !== "plan" && level.kind !== "tasks") {
    const holding: FactoryBlockDto[] = level.blocks.filter(
      (block) => block.inside,
    );
    const open: FactoryBlockDto | undefined =
      holding.find((block) => lively(block.inside!)) ??
      (level.kind === "workflow" ? holding.at(-1) : undefined);
    if (!open) break;
    path.push(open.key);
    level = open.inside;
  }
  return path;
}

/**
 * One row of the page and what is opened under it: an agent with its
 * workflow, or a plan no agent on the page owns.
 */
function Row({
  focus,
  front,
  level: root,
  state,
  title,
  waiting,
  steps,
  onOpenPlan,
  onOpenSession,
  onOpenStep,
}: {
  /** The saved steps by name, for the link from a step's box to its file. */
  steps: ReadonlyMap<string, WorkflowFileDto>;
  onOpenStep?: ((name: string) => void) | undefined;
  /** Asks the row to open down to a box and show it; `nonce` asks again. */
  focus?: (FactoryWhere & { nonce: number }) | undefined;
  /** The box of the agent whose window is in front. */
  front?: string | undefined;
  level: FactoryLevelDto;
  state: FactoryPlanDto["state"];
  title: string;
  waiting: number;
  onOpenPlan: (path: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const bare = root.kind === "agent" && root.blocks.length === 0;
  // Folded until it has something to show: an agent with no workflow, and
  // a row that was finished when the page opened. What the user chooses
  // holds after that.
  const [finishedAtFirst] = useState(state === "done");
  const [foldChoice, setFolded] = useState<boolean>();
  const folded = foldChoice ?? (bare || finishedAtFirst);
  // The keys of the blocks opened, one per level, from the row down.
  const [path, setPath] = useState<string[]>(() => openedAtFirst(root));
  const [picked, setPicked] = useState<string>();
  // Once the user opens or folds a level, the row stops opening by itself.
  const touched = useRef(false);
  const go = (next: string[]) => {
    touched.current = true;
    setPath(next);
  };
  const first = openedAtFirst(root).join("\n");
  useEffect(() => {
    // What is written or started after the row was drawn opens by itself.
    if (!touched.current && first) setPath(first.split("\n"));
  }, [first]);
  const section = useRef<HTMLElement>(null);
  const asked = focus?.nonce;
  useEffect(() => {
    if (!focus) return;
    touched.current = true;
    setFolded(false);
    setPath(focus.path);
    // After the levels are drawn.
    const frame = requestAnimationFrame(() => {
      const box = focus.leaf
        ? [
            ...(section.current?.querySelectorAll<HTMLElement>(
              "[data-block]",
            ) ?? []),
          ].find((item) => item.dataset.block === focus.leaf)
        : undefined;
      (box ?? section.current)?.scrollIntoView({
        behavior: "smooth",
        block: box ? "center" : "start",
      });
    });
    return () => cancelAnimationFrame(frame);
    // One request shows one box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);

  const note = bare
    ? "nothing started"
    : state === "waiting"
      ? root.kind === "plan"
        ? plural(waiting, "block waits for you", "blocks wait for you")
        : "waits for you"
      : PLAN_NOTE[state];

  if (folded)
    return (
      <section className="factory-plan" ref={section}>
        <button
          aria-expanded={false}
          className="factory-plan-fold"
          onClick={() => setFolded(false)}
          type="button"
        >
          <svg
            aria-hidden="true"
            className="factory-chevron"
            viewBox="0 0 10 10"
          >
            <path d="M3 1.5l4 3.5-4 3.5" />
          </svg>
          <span className="factory-plan-title">{title}</span>
          {root.owner && root.kind === "plan" && (
            <span className="factory-owner-handle">@{root.owner.handle}</span>
          )}
          {root.kind === "workflow" && (
            <span className="factory-owner-handle">{root.title}</span>
          )}
          <span className="factory-plan-summary">
            <Segments blocks={root.blocks} />
            <span className={`factory-state is-plan-${state}`}>
              <span className="factory-dot" />
              {note}
            </span>
          </span>
        </button>
      </section>
    );

  // The levels shown: the row's own, then each opened block's inside.
  const levels: FactoryLevelDto[] = [];
  let level: FactoryLevelDto | null = root;
  let pickedBlock: FactoryBlockDto | undefined;
  /** The plan file the level being walked is in. */
  let file: string | undefined;
  let pickedFile: string | undefined;
  const flowErrors: string[] = [];
  for (let depth = 0; level; depth += 1) {
    levels.push(level);
    if (level.file) file = level.file;
    flowErrors.push(...(level.flowErrors ?? []));
    if (!pickedBlock) {
      pickedBlock = level.blocks.find(
        (block) => block.key === picked && !block.inside,
      );
      if (pickedBlock) pickedFile = file;
    }
    const next: FactoryBlockDto | undefined = level.blocks.find(
      (block) => block.key === path[depth] && block.inside,
    );
    level = next?.inside ?? null;
  }

  // The opened boxes, from the top row down: each has its row under it.
  const opened = levels.flatMap(
    (shown, depth) =>
      shown.blocks.find((block) => block.key === path[depth] && block.inside) ??
      [],
  );

  return (
    <section className="factory-plan" ref={section}>
      <LayerWires opened={opened} />
      {levels.map((shown, depth) => {
        const progress = counted(shown);
        const finished = progress.total > 0 && progress.done === progress.total;
        return (
          <div
            className={`factory-level depth-${Math.min(depth, 3)}`}
            key={depth === 0 ? "root" : path.slice(0, depth).join(">")}
            style={{ paddingLeft: 14 + depth * 26 }}
          >
            <div className="factory-level-head">
              <button
                aria-expanded
                aria-label="Fold this level"
                className="factory-icon-button"
                onClick={() =>
                  depth === 0 ? setFolded(true) : go(path.slice(0, depth - 1))
                }
                type="button"
              >
                <svg
                  aria-hidden="true"
                  className="factory-chevron"
                  viewBox="0 0 10 10"
                >
                  <path d="M1.5 3l3.5 4 3.5-4" />
                </svg>
              </button>
              {/* Every level is headed the same way: the box it came out
                  of, then who does it when that is another agent. */}
              {depth > 0 && (
                <>
                  <span
                    className={`factory-level-port is-${opened[depth - 1]?.state ?? "todo"}`}
                    data-port={depth}
                  />
                  <span className="factory-level-inside">inside</span>
                </>
              )}
              <span className="factory-level-title">
                {depth === 0 ? title : shown.title}
              </span>
              {shown.owner && (
                <OwnerChip
                  about={shown.title}
                  onOpenSession={onOpenSession}
                  owner={shown.owner}
                />
              )}
              {progress.total > 0 && (
                <span
                  className={`factory-progress ${finished ? "is-finished" : ""}`}
                  title={`${progress.done} of ${progress.total} done`}
                >
                  <Segments blocks={shown.blocks} />
                  <span>
                    {progress.done}/{progress.total}
                  </span>
                </span>
              )}
              <span className="factory-level-side">
                {shown.file && (
                  <button
                    className="factory-text-button factory-file"
                    onClick={() => onOpenPlan(shown.file!)}
                    title={shown.file}
                    type="button"
                  >
                    Open plan
                  </button>
                )}
              </span>
            </div>
            <div className="factory-row-scroll">
              <div
                className={`factory-row ${shown.ordered ? "" : "is-unordered"}`}
              >
                {shown.blocks.length === 0 && (
                  <span className="factory-empty-row">
                    Nothing here yet. Its steps show when it starts them.
                  </span>
                )}
                {columnsOf(shown).map((column) => (
                  <div
                    className={`factory-step ${column.some((block) => block.state !== "todo" && block.state !== "draft") ? "is-reached" : ""}`}
                    key={column[0]!.key}
                  >
                    <span aria-hidden="true" className="factory-link" />
                    <div className="factory-column">
                      {column.map((block) => (
                        <Block
                          block={block}
                          front={front === block.key}
                          key={block.key}
                          needs={block.needs.flatMap(
                            (key) =>
                              shown.blocks.find((item) => item.key === key)
                                ?.title ?? [],
                          )}
                          onClick={() => {
                            if (block.inside)
                              go(
                                path[depth] === block.key
                                  ? path.slice(0, depth)
                                  : [...path.slice(0, depth), block.key],
                              );
                            else
                              setPicked(
                                picked === block.key ? undefined : block.key,
                              );
                          }}
                          open={path[depth] === block.key && !!block.inside}
                          selected={picked === block.key && !block.inside}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                <StepWires level={shown} />
              </div>
            </div>
          </div>
        );
      })}
      {flowErrors.length > 0 && (
        <div className="factory-flow-errors" role="alert">
          {flowErrors.map((error) => (
            <span key={error}>{error}</span>
          ))}
        </div>
      )}
      {pickedBlock && (
        <Detail
          block={pickedBlock}
          file={pickedFile}
          onClose={() => setPicked(undefined)}
          onOpenPlan={onOpenPlan}
          onOpenSession={onOpenSession}
          onOpenStep={onOpenStep}
          step={
            pickedBlock.kind === "step"
              ? steps.get(pickedBlock.title)
              : undefined
          }
        />
      )}
    </section>
  );
}

export function FactoryPage({
  client,
  workspaceId,
  workspaceName,
  boxRequest,
  chatRequest,
  clickHint,
  live,
  onError,
  onFrontChat,
  onOpenChatTab,
  onOpenLink,
  onOpenPlan,
  onOpenSession,
  onOpenStep,
  onStart,
  onStartTerminal,
  startOptions,
  onTerminal,
  renderTerminal,
  terminalRelease,
}: {
  /**
   * Starts an agent on what the user typed on the empty page and opens its
   * window. Resolves false when it did not start, so the words are kept.
   */
  onStart?:
    ((text: string, choice?: StartChoice) => Promise<boolean>) | undefined;
  /** The agents and defaults the start box offers. */
  startOptions?: StartOptions | undefined;
  /** Opens the dialog that starts a session by hand. */
  onStartTerminal?: (() => void) | undefined;
  renderTerminal?: ((sessionId: string) => React.ReactNode) | undefined;
  onTerminal?: ((sessionId: string, shown: boolean) => void) | undefined;
  terminalRelease?: { sessionId: string; nonce: number } | undefined;
  client: DesktopClient;
  /** A chat to open as a popup, asked for outside the page (the sidebar). */
  chatRequest?: ChatRequest | undefined;
  /**
   * Told which agent's window is in front, or that none is open, so what
   * is shown beside the page (its workflow) can follow that agent.
   */
  onFrontChat?: ((sessionId: string | undefined) => void) | undefined;
  /**
   * Offers the setting that makes a click on an agent open its chat; absent
   * once it is on or the offer was dismissed.
   */
  clickHint?:
    | { state: "offer"; onAccept: () => void; onDismiss: () => void }
    /** Just turned on: says so, with the way back. */
    | { state: "on"; onUndo: () => void; onDismiss: () => void }
    | undefined;
  /** What an agent is doing now, by session. */
  live?: ((sessionId: string) => AgentLive | undefined) | undefined;
  /** Opens a link in a chat message, as a session's terminal does. */
  onOpenLink: (url: string) => void;
  /** Moves an agent's chat to a tab of its own. */
  onOpenChatTab?: (
    sessionId: string,
    handle: string,
    tab: ChatTabId,
    view: "thread" | "terminal",
  ) => void;
  /** A session whose box to show, asked for outside the page (its tab). */
  boxRequest?: { sessionId: string; nonce: number } | undefined;
  workspaceId: string;
  workspaceName: string;
  onError: (message: string) => void;
  onOpenPlan: (path: string) => void;
  onOpenSession: (sessionId: string) => void;
  /** Shows a saved step on the Workflows page. */
  onOpenStep?: ((name: string) => void) | undefined;
}) {
  const page = useFactoryPage(client, workspaceId, onError);
  // The saved steps, read once: a step's box links to its file and names
  // its tools. Without them the page works and shows no link.
  const [steps, setSteps] = useState<ReadonlyMap<string, WorkflowFileDto>>(
    () => new Map(),
  );
  useEffect(() => {
    let live = true;
    void client.request.workflowFiles({}).then((response) => {
      if (live && response.ok)
        setSteps(new Map(response.data.steps.map((step) => [step.name, step])));
    });
    return () => {
      live = false;
    };
  }, [client]);
  const [focus, setFocus] = useState<FactoryWhere & { nonce: number }>();
  const showBox = (sessionId: string) => {
    const where = factoryWhere(page, sessionId);
    if (!where) return;
    setFocus({ ...where, nonce: Date.now() });
    // Its window would cover the box: it goes to the dock, one click away.
    if (open.current.some((chat) => chat.sessionId === sessionId))
      keep(
        open.current.map((chat) =>
          chat.sessionId === sessionId ? { ...chat, minimized: true } : chat,
        ),
      );
  };
  // A request from outside waits for the page to be read.
  const shown = useRef<number | undefined>(undefined);
  const loaded = Boolean(page);
  useEffect(() => {
    if (!boxRequest || !loaded || shown.current === boxRequest.nonce) return;
    shown.current = boxRequest.nonce;
    showBox(boxRequest.sessionId);
    // `showBox` reads the page as it is when the request is met.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxRequest?.nonce, loaded]);
  const { threads, reload } = useWorkspaceThreads(client, workspaceId);
  // With somewhere to open a chat as a tab, no window floats over the
  // page, also none an earlier version left open.
  const [chats, setChats] = useState<ChatWindow[]>(() =>
    onOpenChatTab ? [] : storedChats(workspaceId),
  );
  useEffect(
    () => setChats(onOpenChatTab ? [] : storedChats(workspaceId)),
    // `onOpenChatTab` is the app's and changes each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId],
  );
  const frontChat = chats
    .filter((chat) => !chat.minimized)
    .reduce<ChatWindow | undefined>(
      (front, chat) => (!front || chat.order > front.order ? chat : front),
      undefined,
    )?.sessionId;
  useEffect(() => {
    onFrontChat?.(frontChat);
    // The page going away leaves no window in front.
    return () => onFrontChat?.(undefined);
    // `onFrontChat` is the app's and changes each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frontChat]);
  // Read through a ref, so two opens in one tick both land.
  const open = useRef(chats);
  open.current = chats;
  const keep = (next: ChatWindow[]) => {
    open.current = next;
    setChats(next);
    try {
      localStorage.setItem(CHATS_KEY + workspaceId, JSON.stringify(next));
    } catch {
      // The layout is a convenience; the chats themselves are stored.
    }
  };
  const openChat = (agent: FactoryAgent, about: string, draft?: string) => {
    if (onOpenChatTab)
      return onOpenChatTab(agent.sessionId, agent.handle, "agent", "thread");
    const now = open.current;
    const front = Math.max(0, ...now.map((chat) => chat.order)) + 1;
    keep(
      now.some((chat) => chat.sessionId === agent.sessionId)
        ? now.map((chat) =>
            chat.sessionId === agent.sessionId
              ? { ...chat, about, draft, minimized: false, order: front }
              : chat,
          )
        : [...now, { ...placeChat(now, agent, about), draft }],
    );
  };
  const requested = chatRequest?.nonce;
  useEffect(() => {
    if (!chatRequest) return;
    const { sessionId, handle, tab, view } = chatRequest;
    if (onOpenChatTab)
      return onOpenChatTab(sessionId, handle, tab, view ?? "thread");
    const now = open.current;
    const front = Math.max(0, ...now.map((chat) => chat.order)) + 1;
    keep(
      now.some((chat) => chat.sessionId === sessionId)
        ? now.map((chat) =>
            chat.sessionId === sessionId
              ? {
                  ...chat,
                  tab,
                  ...(view ? { view } : {}),
                  minimized: false,
                  order: front,
                }
              : chat,
          )
        : [...now, { ...placeChat(now, { sessionId, handle }, ""), tab, view }],
    );
    // One request opens one chat; `keep` and the request are read as they are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested]);
  const rows = page ? page.agents.length + page.plans.length : 0;
  const frontWhere = frontChat ? factoryWhere(page, frontChat) : undefined;
  const rowProps = (key: string) => ({
    focus: focus?.row === key ? focus : undefined,
    // The box of the window in front, else the one last asked for.
    front:
      frontWhere?.row === key
        ? frontWhere.leaf
        : !frontWhere && focus?.row === key
          ? focus.leaf
          : undefined,
    onOpenPlan,
    onOpenSession,
    onOpenStep,
    steps,
  });
  return (
    <ChatContext.Provider
      value={{ client, open: openChat, waiting: waitingBySession(threads) }}
    >
      <div className="factory-shell">
        <div className="factory-page">
          <header className="factory-head">
            <h1>
              {workspaceName} <span>/ Factory</span>
            </h1>
            {page && rows > 0 && (
              <div className="factory-counts">
                <span className="factory-count is-working">
                  <span className="factory-dot" />
                  {plural(page.working, "agent working", "agents working")}
                </span>
                <span className="factory-count is-waiting">
                  <span className="factory-dot" />
                  {plural(
                    page.waiting,
                    "block waits for you",
                    "blocks wait for you",
                  )}
                </span>
                <span className="factory-count is-done">
                  <span className="factory-dot" />
                  {plural(page.finished, "finished", "finished")}
                </span>
              </div>
            )}
          </header>
          {clickHint && (
            <p className="factory-hint" role="note">
              <span>
                {clickHint.state === "offer"
                  ? "Want an agent's threads to open when you click it in the sidebar?"
                  : "Clicking an agent now opens its threads. Its session, with the terminal, is the Session button in that window. You can switch back any time in Settings, General, Agents."}
              </span>
              {clickHint.state === "offer" ? (
                <button onClick={clickHint.onAccept} type="button">
                  Turn on
                </button>
              ) : (
                <button onClick={clickHint.onUndo} type="button">
                  Undo
                </button>
              )}
              <button
                aria-label="Dismiss"
                className="factory-hint-close"
                onClick={clickHint.onDismiss}
                title={clickHint.state === "offer" ? "Not now" : "Got it"}
                type="button"
              >
                ×
              </button>
            </p>
          )}
          {!page ? (
            <div className="empty large">Reading the Factory…</div>
          ) : rows === 0 ? (
            onStart ? (
              <StartPrompt
                client={client}
                options={startOptions}
                onStart={onStart}
                onStartTerminal={onStartTerminal}
                workspaceName={workspaceName}
              />
            ) : (
              <div className="empty large">
                <strong>No agents or plans in this workspace</strong>
                <span>
                  Start an agent, or make a plan: a file in plans/ ending in
                  .plan.md, from the Plans pane or with "daedal plan new".
                </span>
              </div>
            )
          ) : (
            <>
              {onStart && (
                <StartPrompt
                  client={client}
                  compact
                  options={startOptions}
                  onStart={onStart}
                  onStartTerminal={onStartTerminal}
                  workspaceName={workspaceName}
                />
              )}
              {page.agents.map((agent: FactoryAgentRowDto) => (
                <Row
                  key={agentRowKey(agent.sessionId)}
                  level={agent.level}
                  state={agent.state}
                  title={agent.title}
                  waiting={agent.waiting}
                  {...rowProps(agentRowKey(agent.sessionId))}
                />
              ))}
              {page.plans.map((plan) => (
                <Row
                  key={planRowKey(plan.path)}
                  level={plan.level}
                  state={plan.state}
                  title={plan.title}
                  waiting={plan.waiting}
                  {...rowProps(planRowKey(plan.path))}
                />
              ))}
            </>
          )}
        </div>
        <ChatLinks onOpenLink={onOpenLink}>
          <FactoryChats
            agents={agentsOf(page)}
            chats={chats}
            client={client}
            live={live}
            onChats={keep}
            onError={onError}
            onOpenChat={openChat}
            onOpenSession={onOpenSession}
            onShowBox={showBox}
            whereOf={(sessionId) => factoryWhere(page, sessionId)?.labels}
            onOpenTab={
              onOpenChatTab
                ? (chat) =>
                    onOpenChatTab(
                      chat.sessionId,
                      chat.handle,
                      chat.tab ?? "agent",
                      chat.view ?? "thread",
                    )
                : undefined
            }
            onTerminal={onTerminal}
            reloadThreads={reload}
            renderTerminal={renderTerminal}
            terminalRelease={terminalRelease}
            threads={threads}
          />
        </ChatLinks>
      </div>
    </ChatContext.Provider>
  );
}
