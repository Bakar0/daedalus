import type { FindingDto } from "@daedalus/protocol";

export type FindingVerdictChoice = "useful" | "noise" | null;

/**
 * What a board card adds for a task a resident opened: where it came from,
 * whether it went away, and the two buttons the resident learns from.
 */
export function FindingDetails({
  finding,
  busy,
  onVerdict,
  onOpenLink,
}: {
  finding: FindingDto;
  busy: boolean;
  onVerdict: (finding: FindingDto, verdict: FindingVerdictChoice) => void;
  onOpenLink: (url: string) => void;
}) {
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  return (
    <div className="finding-details" onClick={stop}>
      <span className="finding-source">
        <span className={`finding-severity severity-${finding.severity}`}>
          {finding.severity}
        </span>
        <span className="finding-routine">{finding.routine}</span>
        {finding.state === "cleared" && (
          <span className="finding-cleared">Cleared</span>
        )}
        {finding.reopenCount > 0 && (
          <span className="finding-reopened">back {finding.reopenCount}×</span>
        )}
        {finding.url && (
          <button
            className="quiet finding-link"
            onClick={(event) => {
              stop(event);
              onOpenLink(finding.url!);
            }}
          >
            Open
          </button>
        )}
      </span>
      <span className="finding-verdict">
        {finding.verdict ? (
          <>
            <span
              className={`finding-verdict-label verdict-${finding.verdict}`}
            >
              {finding.verdict === "noise" ? "Marked noise" : "Marked useful"}
            </span>
            <button
              className="quiet"
              disabled={busy}
              onClick={(event) => {
                stop(event);
                onVerdict(finding, null);
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
                onVerdict(finding, "useful");
              }}
              title="Useful: keep reporting issues like this"
            >
              Useful
            </button>
            <button
              className="quiet"
              disabled={busy}
              onClick={(event) => {
                stop(event);
                onVerdict(finding, "noise");
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
