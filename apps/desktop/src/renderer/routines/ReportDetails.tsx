import type { RoutineReportDto, SessionColorDto } from "@daedalus/protocol";

export type ReportVerdictChoice = "useful" | "noise" | null;

/** The session whose routine filed a report, as its chip shows it. */
export interface ReportOwner {
  name: string;
  color: SessionColorDto | null;
}

/**
 * What a board card adds for a task a routine made: which session and
 * routine it came from, whether it went away, and the two buttons the
 * session learns from.
 */
export function ReportDetails({
  report,
  owner,
  busy,
  onVerdict,
  onOpenLink,
}: {
  report: RoutineReportDto;
  /** The session's name, shown as the card's chip in the session's color. */
  owner: ReportOwner | undefined;
  busy: boolean;
  onVerdict: (report: RoutineReportDto, verdict: ReportVerdictChoice) => void;
  onOpenLink: (url: string) => void;
}) {
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  return (
    <div className="report-details" onClick={stop}>
      <span className="report-source">
        {owner && (
          <span className="report-agent" data-color={owner.color ?? undefined}>
            {owner.name}
          </span>
        )}
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
