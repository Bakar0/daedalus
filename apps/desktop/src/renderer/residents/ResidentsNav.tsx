import type { ResidentOverviewDto } from "@daedalus/protocol";
import { relativeTime } from "./time";

const LAMP_LABEL: Record<ResidentOverviewDto["lamp"], string> = {
  urgent: "Urgent finding open",
  findings: "Findings open",
  running: "Running a routine",
  quiet: "Quiet",
};

/** The lantern: one shape everywhere a resident is shown. */
export function ResidentLamp({
  resident,
}: {
  resident: Pick<ResidentOverviewDto, "lamp" | "state">;
}) {
  const off = resident.state === "stopped" || resident.state === "paused";
  return (
    <span
      aria-label={
        off ? `Resident ${resident.state}` : LAMP_LABEL[resident.lamp]
      }
      className={`resident-lamp lamp-${off ? "off" : resident.lamp}`}
      role="img"
    />
  );
}

export function residentStatusLine(
  resident: ResidentOverviewDto,
  now: number,
): string {
  if (resident.state === "stopped") return "Stopped";
  if (resident.state === "paused") return "Paused";
  if (resident.sessionStatus === "lost") return "Session lost, reviving";
  if (resident.state === "draining") return "Handing off";
  if (resident.runsQueued && resident.deliveryHold)
    return `${resident.runsQueued} waiting: ${resident.deliveryHold}`;
  const parts = [
    resident.runsInFlight
      ? `${resident.runsInFlight} running`
      : resident.nextRunAt
        ? `next ${relativeTime(resident.nextRunAt, now)}`
        : "nothing scheduled",
  ];
  if (resident.openFindingTasks)
    parts.push(
      `${resident.openFindingTasks} open ${resident.openFindingTasks === 1 ? "task" : "tasks"}`,
    );
  return parts.join(" · ");
}

/**
 * The sidebar section above Workspaces. Residents are agents that run for
 * weeks, not projects, so they are listed on their own and never in the
 * workspace list.
 */
export function ResidentsNav({
  residents,
  selectedId,
  now,
  compact,
  onOpen,
}: {
  residents: ResidentOverviewDto[];
  selectedId?: string;
  now: number;
  compact: boolean;
  onOpen: (resident: ResidentOverviewDto) => void;
}) {
  if (residents.length === 0) return null;
  return (
    <div className="residents-section">
      {!compact && (
        <div className="residents-heading">
          <span className="eyebrow">Residents</span>
        </div>
      )}
      <nav aria-label="Residents" className="item-list">
        {residents.map((resident) => (
          <div
            className={`resident-card ${resident.id === selectedId ? "selected" : ""}`}
            key={resident.id}
          >
            <button
              aria-current={resident.id === selectedId ? "page" : undefined}
              className="resident-item"
              onClick={() => onOpen(resident)}
              title={`${resident.name}: ${residentStatusLine(resident, now)}`}
            >
              <span className="resident-icon">
                <ResidentLamp resident={resident} />
              </span>
              <span className="resident-card-content">
                <strong>{resident.name}</strong>
                <small>{residentStatusLine(resident, now)}</small>
              </span>
              {resident.openFindingTasks > 0 && (
                <span
                  className={`resident-count ${resident.lamp === "urgent" ? "urgent" : ""}`}
                >
                  {resident.openFindingTasks}
                </span>
              )}
            </button>
          </div>
        ))}
      </nav>
    </div>
  );
}
