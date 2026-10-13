import { useState } from "react";
import type { FlowStageDto } from "@daedalus/protocol";
import {
  STAGE_MODE_WORDS,
  STAGE_STATE_WORDS,
  segmentLook,
  stageHeartbeat,
  type StageSession,
} from "./model";

const ACTIVITY_WORDS: Record<string, string> = {
  working: "working",
  needs_input: "needs you",
  needs_permission: "needs your permission",
  idle: "idle",
  done: "done",
  error: "error",
  unknown: "unknown",
};

const MODE_MARK = { own: "", rollup: "Σ", after: "⧗" } as const;

/**
 * One component's flow on a line. Finished stages are solid green and the
 * line is green up to the stage at work, which beats like a heart while its
 * agent works. Hovering a stage someone worked on shows who; clicking it
 * opens their session.
 */
export function FlowLine({
  stages,
  sessions,
  onOpenSession,
}: {
  stages: FlowStageDto[];
  sessions: ReadonlyMap<string, StageSession>;
  onOpenSession: (session: StageSession) => void;
}) {
  const [card, setCard] = useState<string | null>(null);
  if (!stages.length)
    return <div className="flow-line flow-line-empty">No stages yet</div>;
  return (
    <div className="flow-line">
      {stages.map((stage, index) => {
        const session = stage.sessionId
          ? sessions.get(stage.sessionId)
          : undefined;
        const beat = stageHeartbeat(stage, session);
        const name = stage.label ?? stage.kind;
        return (
          <div className="flow-step" key={stage.id}>
            {index > 0 ? (
              <div
                className={`flow-segment flow-segment-${segmentLook(stage.shown)}`}
              />
            ) : null}
            <div
              className="flow-station-wrap"
              onMouseEnter={() => setCard(stage.id)}
              onMouseLeave={() => setCard(null)}
            >
              <button
                aria-label={`${name}: ${STAGE_STATE_WORDS[stage.shown]}`}
                className={[
                  "quiet",
                  "flow-station",
                  `flow-station-${stage.shown}`,
                  `flow-station-mode-${stage.mode}`,
                  beat ? `flow-beat-${beat}` : "",
                  stage.droppedReason !== null ? "flow-station-dropped" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-stage={stage.kind}
                data-shown={stage.shown}
                disabled={!session}
                onClick={() => session && onOpenSession(session)}
                type="button"
              >
                <span>{name}</span>
                {MODE_MARK[stage.mode] ? (
                  <span className="flow-station-mode" aria-hidden="true">
                    {MODE_MARK[stage.mode]}
                  </span>
                ) : null}
                {beat === "stalled" ? (
                  <span className="flow-station-stalled">stalled</span>
                ) : null}
              </button>
              {card === stage.id ? (
                <StageCard
                  onOpenSession={onOpenSession}
                  session={session}
                  stage={stage}
                />
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StageCard({
  stage,
  session,
  onOpenSession,
}: {
  stage: FlowStageDto;
  session: StageSession | undefined;
  onOpenSession: (session: StageSession) => void;
}) {
  const beat = stageHeartbeat(stage, session);
  return (
    <div className="flow-stage-card" role="tooltip">
      <strong>
        {stage.label ? `${stage.label} (${stage.kind})` : stage.kind}
      </strong>
      <span>
        {STAGE_STATE_WORDS[stage.shown]}
        {stage.note ? `: ${stage.note}` : ""}
      </span>
      <small>{STAGE_MODE_WORDS[stage.mode]}</small>
      {stage.droppedReason !== null ? (
        <small className="flow-reason">Dropped: {stage.droppedReason}</small>
      ) : null}
      {stage.sessionId ? (
        session ? (
          <div className="flow-stage-card-session">
            <span>
              {stage.shown === "running" || stage.shown === "blocked"
                ? "Held by"
                : "Done by"}{" "}
              <b>{session.name}</b> ({session.provider})
            </span>
            {beat === "stalled" ? (
              <span className="flow-reason">
                Stalled: the session is no longer running
              </span>
            ) : session.live && session.activity ? (
              <span>
                {ACTIVITY_WORDS[session.activity] ?? session.activity}
              </span>
            ) : null}
            {session.question ? (
              <q className="flow-stage-card-question">{session.question}</q>
            ) : null}
            <button onClick={() => onOpenSession(session)} type="button">
              Open session
            </button>
          </div>
        ) : (
          <small>The session that held it was deleted.</small>
        )
      ) : null}
    </div>
  );
}
