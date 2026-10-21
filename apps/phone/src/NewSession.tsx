import { useEffect, useState } from "react";
import type {
  AgentSessionDto,
  DesktopSnapshotDto,
  ProviderModelCatalogDto,
} from "@daedalus/protocol";
import type { PhoneConnection } from "@daedalus/remote-protocol";
import { ToolIcon } from "../../desktop/src/renderer/session-view";
import { call } from "./Board";

const TOOLS = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
] as const;
type Tool = (typeof TOOLS)[number]["id"];

/**
 * A new agent session in one workspace, as the Mac's New session dialog
 * starts one: a tool, an optional name and model, and an optional first
 * message. The session opens once the Mac has started it.
 */
export function NewSessionScreen({
  workspaceId,
  snapshot,
  connection,
  onStarted,
}: {
  workspaceId: string;
  snapshot: DesktopSnapshotDto;
  connection: PhoneConnection | undefined;
  onStarted: (sessionId: string) => void;
}) {
  const installed = TOOLS.filter((tool) =>
    snapshot.settings.providers.some(
      (provider) => provider.name === tool.id && provider.available,
    ),
  );
  const [tool, setTool] = useState<Tool | undefined>(installed[0]?.id);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [message, setMessage] = useState("");
  const [catalog, setCatalog] = useState<ProviderModelCatalogDto>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!connection || !tool) return;
    let current = true;
    setCatalog(undefined);
    setModel("");
    call<ProviderModelCatalogDto>(connection, "agentModels", {
      provider: tool,
    }).then(
      (data) => {
        if (current) setCatalog(data);
      },
      // Without the list the Mac's default model is used.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [connection, tool]);

  return (
    <form
      className="task-screen"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!connection || !tool) return;
        setBusy(true);
        setError(undefined);
        try {
          const session = await call<AgentSessionDto>(
            connection,
            "agentSpawn",
            {
              workspace: workspaceId,
              provider: tool,
              ...(name.trim() ? { name: name.trim() } : {}),
              ...(model ? { model } : {}),
              ...(message.trim() ? { message: message.trim() } : {}),
            },
          );
          onStarted(session.id);
        } catch (failure) {
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
          setBusy(false);
        }
      }}
    >
      <div aria-label="Tool" className="tool-picker" role="radiogroup">
        {TOOLS.map((item) => {
          const available = installed.some((each) => each.id === item.id);
          return (
            <button
              aria-checked={tool === item.id}
              disabled={!available}
              key={item.id}
              onClick={() => setTool(item.id)}
              role="radio"
              type="button"
            >
              <span className={`session-kind-icon tool-${item.id}`}>
                <ToolIcon tool={item.id} />
              </span>
              <strong>{item.label}</strong>
              <small>{available ? "Available" : "Not installed"}</small>
            </button>
          );
        })}
      </div>
      <label className="field">
        <span>Name</span>
        <input
          onChange={(event) => setName(event.target.value)}
          placeholder="What is this session for?"
          value={name}
        />
      </label>
      <label className="field">
        <span>Model</span>
        <select
          disabled={!catalog}
          onChange={(event) => setModel(event.target.value)}
          value={model}
        >
          <option value="">
            {catalog?.defaultModel
              ? `Default (${catalog.defaultModel})`
              : "Default"}
          </option>
          {catalog?.models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>First message</span>
        <textarea
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Optional. The agent starts on it."
          rows={5}
          value={message}
        />
      </label>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {installed.length === 0 ? (
        <p className="quiet-line">
          Neither Claude nor Codex is installed on this Mac.
        </p>
      ) : null}
      <button
        className="button primary"
        disabled={busy || !connection || !tool}
        type="submit"
      >
        {busy ? "Starting…" : "Start session"}
      </button>
    </form>
  );
}
