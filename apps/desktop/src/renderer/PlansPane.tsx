/**
 * The plans, in the side panel's dock between the Workflow and Custom
 * instructions panes: one row per `.plan.md`, with its progress, the
 * questions waiting for the user and its owner's live dot. A row opens the
 * file, which the editor shows as the interactive plan. In a workspace it
 * is that workspace's `plans/`; at Home it is Home's own and every
 * workspace's, under each workspace's name.
 */
import { useEffect, useState } from "react";
import type { PlanListDto, PlanOwnerDto } from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { PLANS_CHANGED } from "./files/plan-actions";
import { OWNER_STATE_TEXT } from "./files/plan-owner";

/** A checklist: the plans' mark. */
export const PLAN_ICON_PATH =
  "M2.5 4l1.2 1.2L6 3M8 4.2h5.5M2.5 8.5l1.2 1.2L6 7.5M8 8.7h5.5M3 12.8h2M8 12.8h5.5";

/** How often the pane reads again while shown, for owners' live state. */
const REFRESH_MS = 10_000;

const isPlanChange = (path: string) =>
  path.endsWith(".plan.md") || /(^|\/)plans$/.test(path);

/**
 * Reads the list when the pane mounts, when a plan file changes on disk in
 * the shown workspace, after a plan is made, when the window comes back into
 * focus, and every few seconds while it is shown, since owners' state moves
 * with their sessions.
 */
export function usePlanList(
  client: DesktopClient,
  workspaceId: string | undefined,
): PlanListDto | undefined {
  const [list, setList] = useState<PlanListDto>();
  useEffect(() => {
    setList(undefined);
    if (!workspaceId) return;
    let live = true;
    const read = () =>
      void client.request.planList({ workspace: workspaceId }).then(
        (response) => {
          if (live && response.ok) setList(response.data);
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
  }, [client, workspaceId]);
  return list;
}

function OwnerDot({ owner }: { owner: PlanOwnerDto }) {
  return (
    <span
      aria-label={`@${owner.handle} ${OWNER_STATE_TEXT[owner.state]}`}
      className={`plans-pane-owner plan-owner-${owner.state}`}
      role="img"
      title={`@${owner.handle} · ${OWNER_STATE_TEXT[owner.state]}${owner.sessionName ? ` — ${owner.sessionName}` : ""}`}
    >
      <span aria-hidden="true" className="plan-owner-dot" />
    </span>
  );
}

function PlanGroups({
  list,
  onOpenPlan,
}: {
  list: PlanListDto;
  onOpenPlan: (path: string) => void;
}) {
  return (
    <div className="plans-pane-body">
      {list.groups.map((group) => (
        <div className="plans-pane-group" key={group.workspaceId ?? ""}>
          {list.home && (
            <div className="plans-pane-group-name">{group.name}</div>
          )}
          <ul className="plans-pane-list">
            {group.plans.map((plan) => (
              <li key={plan.path}>
                <button
                  className="plans-pane-row"
                  onClick={() => onOpenPlan(plan.path)}
                  title={plan.path}
                  type="button"
                >
                  <span className="plans-pane-title">{plan.title}</span>
                  {plan.questions > 0 && (
                    <span className="plans-pane-asks">
                      {plan.questions} for you
                    </span>
                  )}
                  <span
                    className={`plans-pane-progress${plan.total > 0 && plan.done === plan.total ? " done" : ""}`}
                    title="Tasks done, of all tasks"
                  >
                    {plan.done}/{plan.total}
                  </span>
                  {plan.owner && <OwnerDot owner={plan.owner} />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function NewPlanLink({ onCreate }: { onCreate: () => void }) {
  return (
    <button
      className="workflow-pane-link plans-pane-new"
      onClick={onCreate}
      title="A new plan in plans/, with a Tasks section to fill in"
      type="button"
    >
      + New
    </button>
  );
}

function PlansIcon() {
  return (
    <svg
      aria-hidden="true"
      className="workflow-icon"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 16 16"
    >
      <path d={PLAN_ICON_PATH} />
    </svg>
  );
}

export function PlansPane({
  list,
  onCreate,
  onOpen,
  onOpenPlan,
}: {
  list?: PlanListDto;
  /** Asks for a title and makes the plan, as File › New Plan… does. */
  onCreate: () => void;
  /** Shows every plan in the Plans tab. */
  onOpen: () => void;
  /** Opens a plan's file; the path is the file panel's. */
  onOpenPlan: (path: string) => void;
}) {
  const groups = list?.groups ?? [];
  return (
    <section aria-label="Plans" className="workflow-pane plans-pane">
      <div className="workflow-pane-header">
        <span className="workflow-pane-heading">
          <span className="workflow-pane-title">
            <PlansIcon />
            Plans
          </span>
        </span>
        {groups.length > 0 && <NewPlanLink onCreate={onCreate} />}
        <button
          className="quiet workflow-pane-open"
          onClick={onOpen}
          title="Open the plans in a tab"
          type="button"
        >
          Open <span aria-hidden="true">↗</span>
        </button>
      </div>
      {list &&
        (groups.length === 0 ? (
          <p className="workflow-pane-empty">
            No plans yet · <NewPlanLink onCreate={onCreate} />
          </p>
        ) : (
          <PlanGroups list={list} onOpenPlan={onOpenPlan} />
        ))}
    </section>
  );
}

/**
 * The Plans tab: the dock's list at full size, read on its own so it stays
 * current while the dock is hidden.
 */
export function PlansPage({
  client,
  workspaceId,
  onCreate,
  onOpenPlan,
}: {
  client: DesktopClient;
  workspaceId: string | undefined;
  onCreate: () => void;
  onOpenPlan: (path: string) => void;
}) {
  const list = usePlanList(client, workspaceId);
  const groups = list?.groups ?? [];
  return (
    <section aria-label="Plans" className="plans-pane plans-page">
      <header className="plans-page-header">
        <h2 className="plans-page-title">
          <PlansIcon />
          Plans
        </h2>
        {groups.length > 0 && <NewPlanLink onCreate={onCreate} />}
      </header>
      {list &&
        (groups.length === 0 ? (
          <p className="plans-page-empty">
            No plans yet · <NewPlanLink onCreate={onCreate} />
          </p>
        ) : (
          <PlanGroups list={list} onOpenPlan={onOpenPlan} />
        ))}
    </section>
  );
}
