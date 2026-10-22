import type { RoutinesStatus } from "./routine-delivery";
import type { ApplicationContext } from "./context";
import { largeFiles } from "./context-files";

/**
 * How to tell cheaply that a source changed: a function over the rows its
 * read is built from, never the built value, since a read may stat folders or
 * ask tmux and the host compares versions every tick. A source that only
 * changes when something already announces it, such as a window's own
 * mutation, is `unwatched` and says why.
 */
type Version = (() => unknown) | { unwatched: string };

const unwatched = (reason: string): Version => ({ unwatched: reason });

/**
 * One part of what a window shows: how to read it, and its version.
 *
 * A `live` source asks outside the database, and reading agents or terminals
 * reconciles them with tmux first: a session whose tmux is gone becomes lost,
 * and one that ended at a startup question loses its attention. So a snapshot
 * awaits every `live` read before it reads any `rows` source.
 */
interface Source<T> {
  phase: "live" | "rows";
  read(): T | Promise<T>;
  version: Version;
}

const live = <T>(read: () => T | Promise<T>, version: Version): Source<T> => ({
  phase: "live",
  read,
  version,
});

const rows = <T>(read: () => T, version: Version): Source<T> => ({
  phase: "rows",
  read,
  version,
});

function sources(context: ApplicationContext) {
  const { repositories } = context;
  const currentLargeFiles = () =>
    largeFiles(
      repositories.listWorkspaces(),
      context.teams.list().map((team) => team.lead),
    );
  return {
    workspaces: live(
      () => context.workspaces.listWithHealth(),
      // A workspace's repositories are read by its view on each reload, so a
      // repository attached outside the window reloads it too.
      () => [
        repositories.listWorkspaces(),
        repositories.listWorkspaceRepositories(),
      ],
    ),
    tasks: live(
      async () => {
        const tasks = await context.tasks.list({});
        const references = context.tasks.references(tasks);
        return tasks.map((task) => ({
          task,
          references: references.get(task.id) ?? [],
        }));
      },
      () => repositories.listTasks({}),
    ),
    agents: live(
      () => context.agents.list({ includeArchived: true }),
      () => repositories.listAgents(),
    ),
    terminals: live(
      () => context.terminals.list(),
      () => repositories.listIntegratedTerminals(),
    ),
    repositories: rows(
      () => context.workspaceContent.listRepositoryLibrary(),
      () => repositories.listRepositoryLibrary(),
    ),
    // Usage is read from provider files, not rows, so its version is the read
    // itself. The service caches it, so most ticks cost nothing.
    telemetry: live(
      () => context.telemetry.read(),
      () => context.telemetry.read(),
    ),
    // Activity and attention are the point of the indicators: a session that
    // starts waiting on the user has to reach the window on the next tick,
    // exactly like a session that starts or stops.
    sessionActivity: rows(
      () => context.activity.list(),
      () => repositories.listAgentActivity(),
    ),
    attention: rows(
      () => context.activity.listAttention(),
      () => repositories.listSessionAttention(),
    ),
    // Git status and pull requests are measured in this process, which
    // announces them when they change.
    worktrees: rows(
      () => context.workspaceContent.listWorktrees(),
      () => repositories.listSessionWorktrees(),
    ),
    shipped: rows(
      () => context.workspaceContent.listShippedPullRequests(),
      unwatched("recorded by the pull request check, which announces it"),
    ),
    toasts: rows(
      () => context.notifications.pending("toast"),
      () => repositories.listPendingNotifications(),
    ),
    // A run starting or ending, or a hold changing, changes what the
    // session's bar says, so it reloads too. A team is its lead's
    // orchestration ability, so this covers `teams` as well.
    abilities: rows(
      () => repositories.abilities.list(),
      () =>
        repositories.abilities.list().map((ability) => ({
          ability,
          ...(ability.enabled && ability.ability === "routines"
            ? {
                status: statusVersion(context.routineDelivery.status(ability)),
                routines: repositories.routines.list(ability.id),
                reports: repositories.routines.listReports(ability.id, {
                  states: ["open", "resolved"],
                }),
              }
            : {}),
        })),
    ),
    routines: rows(
      () =>
        context.abilities
          .holders("routines")
          .map((ability) => context.routineDelivery.status(ability)),
      unwatched("covered by abilities"),
    ),
    teams: rows(
      () => context.teams.list(),
      unwatched("covered by abilities: a team is its lead's ability"),
    ),
    routineReports: rows(
      () => repositories.routines.listReportsWithTasks(),
      unwatched("covered by abilities: a report's task moves with the report"),
    ),
    // A journal or team file crossing its compact size changes a header. To
    // the kilobyte, so each line a session appends does not reload the window.
    largeFiles: rows(currentLargeFiles, () =>
      currentLargeFiles().map(
        (file) =>
          `${file.kind}:${file.sessionId ?? file.workspaceId}:${Math.round(file.bytes / 1000)}`,
      ),
    ),
    capabilities: live(
      () => context.agents.capabilities(),
      unwatched("tmux and the providers are probed when the window asks"),
    ),
    settings: rows(
      () => ({ config: context.config, accounts: context.accounts.list() }),
      unwatched("settings and accounts change through the window's requests"),
    ),
  } satisfies Record<string, Source<unknown>>;
}

type Sources = ReturnType<typeof sources>;

/** Everything a window draws from, read in one go. */
export type ReadModelView = {
  [Name in keyof Sources]: Awaited<ReturnType<Sources[Name]["read"]>>;
};

/**
 * What the desktop window and the phone draw from. `snapshot()` reads it all;
 * `version()` is a cheap string that changes whenever a snapshot would, so a
 * host can poll it and reload only on a change. Both come from one source
 * list, so a part cannot be shown without also saying how it changes.
 */
export class ReadModel {
  private readonly sources: Sources;

  constructor(context: ApplicationContext) {
    this.sources = sources(context);
  }

  async snapshot(): Promise<ReadModelView> {
    const entries = Object.entries(this.sources) as Array<
      [keyof Sources, Source<unknown>]
    >;
    const view: Record<string, unknown> = {};
    const first = entries.filter(([, part]) => part.phase === "live");
    const values = await Promise.all(first.map(([, part]) => part.read()));
    first.forEach(([name], index) => (view[name] = values[index]));
    for (const [name, part] of entries)
      if (part.phase === "rows") view[name] = part.read();
    return view as ReadModelView;
  }

  async version(): Promise<string> {
    return JSON.stringify(await this.versions());
  }

  /**
   * The version of each watched source on its own, so a host can say which
   * parts changed and a window reload only those.
   */
  async versions(): Promise<Record<string, string>> {
    const parts: Record<string, string> = {};
    for (const [name, part] of Object.entries(this.sources))
      if (typeof part.version === "function")
        parts[name] = JSON.stringify(await part.version());
    return parts;
  }

  /**
   * Only the named parts. Each is safe to read on its own: none of them is
   * an input to the reconciliation that a `live` agents or terminals read
   * runs first, so it reads the same here as inside a whole snapshot.
   */
  async snapshotParts<Name extends PartialReadModelSource>(
    names: readonly Name[],
  ): Promise<Pick<ReadModelView, Name>> {
    const view: Partial<Record<Name, unknown>> = {};
    for (const name of names) view[name] = await this.sources[name].read();
    return view as Pick<ReadModelView, Name>;
  }
}

/**
 * The sources a window may reload on their own. They are the ones that move
 * while agents work, a turn's activity and token counts above all, and none
 * of them changes what the rest of the snapshot says.
 */
export const PARTIAL_READ_MODEL_SOURCES = [
  "sessionActivity",
  "attention",
  "telemetry",
  "toasts",
  "worktrees",
  "shipped",
  "largeFiles",
] as const satisfies readonly (keyof Sources)[];

export type PartialReadModelSource =
  (typeof PARTIAL_READ_MODEL_SOURCES)[number];

/** Whether every changed part can be reloaded without the rest. */
export const isPartialReload = (
  names: readonly string[],
): names is PartialReadModelSource[] =>
  names.length > 0 &&
  names.every((name) =>
    (PARTIAL_READ_MODEL_SOURCES as readonly string[]).includes(name),
  );

/**
 * A routines status as the version sees it. Every keystroke moves the quiet
 * time, so the times are rounded to ten seconds: a reload per tick while the
 * user types would resend the whole snapshot for nothing.
 */
const statusVersion = (status: RoutinesStatus) => ({
  ...status,
  lastKeystrokeAt: null,
  hold: status.hold
    ? {
        ...status.hold,
        until: status.hold.until
          ? Math.floor(Date.parse(status.hold.until) / 10_000)
          : undefined,
      }
    : null,
});
