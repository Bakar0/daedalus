import type { DaedalusConfig } from "../config";
import type { AgentSession, Workspace } from "../domain";
import type { SqliteRepositories } from "../repositories";
import { ORCHESTRATION_SKILL } from "./abilities";
import { installedSkill } from "./installed-skills";
import { buildSkillInvocation } from "./providers";
import type { WorkspaceService } from "./workspaces";

/** The file at Home the main agent keeps the user's preferences in. */
export const HOME_MEMORY_FILE = "MEMORY.md";

/**
 * What the main agent is told at launch: the coordinator's role, as Claude
 * Code Projects runs it. `{memory}` is the path of its memory file.
 */
export function homeAgentPrompt(memoryPath: string): string {
  return [
    "You are the main agent at Daedalus Home. You coordinate the user's work across all of their workspaces; every piece of work runs in a thread, a Daedalus session that is a member of your team.",
    `- Read ${memoryPath} now. It holds what the user asked you to remember. When the user states a preference ("keep it to 3 running", "always use codex for docs"), save it there in one line, say "Saved to memory: ...", and follow it from then on.`,
    "- Answer quick questions yourself, here. Do not start a thread for a question you can answer from the CLI or a file.",
    '- Start one thread per piece of work: `daedal agent spawn --team --workspace <workspace> --name <short-handle> --message "<instructions>"`. Pick the workspace the work belongs to (`daedal workspace list`); never leave --workspace out. Then say which thread got what, one line each.',
    '- Route a follow-up about running work to the thread that has it (`daedal team say "@handle ..."`) instead of starting a new one, and say where it went.',
    '- When you see work worth doing that the user did not ask for, suggest it instead of starting it: `daedal thread suggest "<title>" --workspace <workspace> --message "<instructions>"`. The user starts it from the Threads pane.',
    "- Threads hand back their last message when their turn ends. Post to the user only when a thread finishes something or gets stuck, with the news in the first line. A thread waiting on the user shows in the Threads pane; do not relay its question.",
    "- When a thread's work is done and checked, mark it resolved: `daedal thread done <session>`.",
    "Follow the daedalus-orchestration skill. Then greet the user in one line and wait.",
  ].join("\n");
}

/**
 * Home's main agent: one Claude session in the hidden Home workspace, made on
 * first use. It is the lead of a team whose members, its threads, run in any
 * workspace.
 */
export class HomeService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly config: DaedalusConfig,
    private readonly workspaces: Pick<WorkspaceService, "ensureHome">,
    private readonly sessions: {
      spawn(input: {
        workspace: string;
        name?: string;
        provider?: string;
        message?: string;
      }): Promise<AgentSession>;
      restore(id: string): Promise<AgentSession>;
    },
  ) {}

  /** The Home row, if the main agent was ever opened. */
  workspace(): Workspace | undefined {
    return this.repositories.findHomeWorkspace();
  }

  /** Whether a session is the main agent or runs at Home. */
  isHome(session: Pick<AgentSession, "workspaceId">): boolean {
    return this.repositories.findHomeWorkspace()?.id === session.workspaceId;
  }

  /**
   * The main agent now, if there is one: the newest session at Home that is
   * not a member of a team. A rebirth's successor is newer than the session
   * it replaced, so it takes over.
   */
  current(): AgentSession | undefined {
    const home = this.repositories.findHomeWorkspace();
    if (!home) return undefined;
    const candidates = this.repositories
      .listAgents()
      .filter(
        (session) =>
          session.workspaceId === home.id &&
          session.kind === "agent" &&
          !session.teamId,
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return candidates.find((session) => !session.archivedAt) ?? candidates[0];
  }

  /**
   * The main agent, made on first use, or brought back when it was archived.
   */
  async agent(): Promise<{ workspace: Workspace; session: AgentSession }> {
    const workspace = await this.workspaces.ensureHome();
    const existing = this.current();
    if (existing)
      return {
        workspace,
        session: existing.archivedAt
          ? await this.sessions.restore(existing.id)
          : existing,
      };
    const skill = await installedSkill(
      this.config,
      "claude",
      ORCHESTRATION_SKILL,
    );
    const memory = `${workspace.path}/${HOME_MEMORY_FILE}`;
    const file = Bun.file(memory);
    if (!(await file.exists()))
      await Bun.write(
        memory,
        "# Main agent memory\n\nWhat the user asked the main agent to remember, one line each.\n",
      );
    const session = await this.sessions.spawn({
      workspace: workspace.id,
      name: "Main agent",
      provider: "claude",
      message: [
        ...(skill ? [buildSkillInvocation("claude", skill)] : []),
        homeAgentPrompt(memory),
      ].join("\n\n"),
    });
    return { workspace, session };
  }
}
