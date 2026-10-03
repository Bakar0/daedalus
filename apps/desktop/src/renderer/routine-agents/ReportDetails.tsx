import type { RoutineReportDto } from "@daedalus/protocol";

export type ReportVerdictChoice = "useful" | "noise" | null;

/**
 * What a board card adds for a task a routine made: which agent and routine
 * it came from, whether it went away, and the two buttons the agent learns
 * from.
 */
export function ReportDetails({
  report,
  agentName,
  busy,
  onVerdict,
  onOpenLink,
}: {
  report: RoutineReportDto;
  /** The routine agent's name, shown as the card's gold tag. */
  agentName: string | undefined;
  busy: boolean;
  onVerdict: (report: RoutineReportDto, verdict: ReportVerdictChoice) => void;
  onOpenLink: (url: string) => void;
}) {
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  return (
    <div className="report-details" onClick={stop}>
      <span className="report-source">
        {agentName && <span className="report-agent">{agentName}</span>}
        {report.urgent && <span className="report-urgent">urgent</span>}
        <span className="report-routine">{report.routine}</span>
        {report.state === "resolved" && (
          <span className="report-resolved">Resolved</span>
        )}
        {report.reopenCount > 0 && (
          <span className="report-reopened">back {report.reopenCount}×</span>
        )}
        {report.url && (
          <button
            className="quiet report-link"
            onClick={(event) => {
              stop(event);
              onOpenLink(report.url!);
            }}
          >
            Open
          </button>
        )}
      </span>
      <span className="report-verdict">
        {report.verdict ? (
          <>
            <span className={`report-verdict-label verdict-${report.verdict}`}>
              {report.verdict === "noise" ? "Marked noise" : "Marked useful"}
            </span>
            <button
              className="quiet"
              disabled={busy}
              onClick={(event) => {
                stop(event);
                onVerdict(report, null);
              }}
            >
              Undo
            </button>
          </>
        ) : (
          <>
            <button
              className="quiet"
              disabled={busy}
              onClick={(event) => {
                stop(event);
                onVerdict(report, "useful");
              }}
              title="Useful: keep reporting things like this"
            >
              Useful
            </button>
            <button
              className="quiet"
              disabled={busy}
              onClick={(event) => {
                stop(event);
                onVerdict(report, "noise");
              }}
              title="Noise: this key never opens a task again"
            >
              Noise
            </button>
          </>
        )}
      </span>
    </div>
  );
}
