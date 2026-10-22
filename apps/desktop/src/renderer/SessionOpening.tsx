import type { CloudPreparingDto } from "@daedalus/protocol";
import type { SessionLaunchState } from "./WorkspaceApp";

const TOOL_LABEL: Record<SessionLaunchState["tool"], string> = {
  claude: "Claude",
  codex: "Codex",
  terminal: "the terminal",
};

/**
 * The center while a new session starts. A cloud session may first wait for
 * its workspace's cloud copy, made the first time and woken when it slept,
 * so the steps say how far that got.
 */
export function SessionOpening({
  launch,
  preparing,
}: {
  launch: SessionLaunchState;
  preparing?: CloudPreparingDto;
}) {
  const tool = TOOL_LABEL[launch.tool];
  if (!launch.cloud)
    return (
      <div aria-busy="true" className="terminal-empty">
        <span aria-hidden="true" className="session-launch-spinner" />
        <strong>Starting {tool}…</strong>
        <span>The terminal opens here as soon as it is ready.</span>
      </div>
    );
  const steps = [
    {
      id: "workspace",
      label:
        preparing?.phase === "creating"
          ? "Making the workspace's cloud copy"
          : preparing?.phase === "waking"
            ? "Waking the cloud workspace"
            : "Cloud workspace",
    },
    { id: "pod", label: "Starting its pod" },
    { id: "tool", label: `Starting ${tool} in the pod` },
  ];
  const current =
    preparing?.phase === "creating" || preparing?.phase === "waking"
      ? 0
      : preparing?.phase === "starting"
        ? 1
        : 2;
  return (
    <div
      aria-busy="true"
      className="terminal-empty session-opening-cloud"
      data-phase={preparing?.phase ?? "tool"}
      data-testid="cloud-preparing"
    >
      <span aria-hidden="true" className="session-launch-spinner" />
      <strong>
        {current < 2 ? "Preparing the cloud workspace…" : `Starting ${tool}…`}
      </strong>
      <ol className="session-opening-steps">
        {steps.map((step, index) => (
          <li
            data-state={
              index < current ? "done" : index === current ? "now" : "next"
            }
            key={step.id}
          >
            {step.label}
          </li>
        ))}
      </ol>
      {preparing?.phase === "creating" && (
        <span>The first cloud session in a workspace takes a minute.</span>
      )}
    </div>
  );
}
