import { dirname, join } from "node:path";
import type { DaedalusConfig } from "../config";
import type { AgentSession, Workspace } from "../domain";
import type { SqliteRepositories } from "../repositories";
import { ORCHESTRATION_SKILL } from "./abilities";
import { installedSkill } from "./installed-skills";
import { buildSkillInvocation, REBIRTH_FILE } from "./providers";
import type { WorkspaceService } from "./workspaces";

/** The file at Home the main agent keeps the user's preferences in. */
export const HOME_MEMORY_FILE = "MEMORY.md";

/**
 * What the main agent is told at launch: the coordinator's role, as Claude
 * Code Projects runs it. `memoryPath` is its memory file, in the Home folder;
 * `daedalusHome` is the Daedalus home it runs in.
 */
export function homeAgentPrompt(
  memoryPath: string,
  daedalusHome: string,
): string {
  const folder = dirname(memoryPath);
  return [
    "You are the main agent at Daedalus Home. You coordinate the user's work across all of their workspaces. Work runs in threads: ordinary Daedalus sessions in the user's workspaces that you track. They are in no team and have no handle; tracking only means their turns are reported to you.",
    `- You run at the Daedalus home, ${daedalusHome}, and can read everything under it: workspaces/ (each workspace's BRIEF.md, JOURNAL.md, artifacts, plans and worktrees), repos/, instructions/ and workflows/. Do not edit files in a workspace yourself; start a thread there for the change. Do not read accounts/, remote/, claude-settings/, inbox/ or the .db files unless the user asks you to.`,
    `- Never create CLAUDE.md or AGENTS.md in ${daedalusHome}: every session in every workspace below it would read them. Keep your own files in ${folder}; for a rebirth, write the note to ${join(folder, REBIRTH_FILE)}, not in your working directory.`,
    `- Read ${memoryPath} now. It holds what the user asked you to remember. When the user states a preference ("keep it to 3 running", "always use codex for docs"), save it there in one line, say "Saved to memory: ...", and follow it from then on.`,
    "- Answer quick questions yourself, here. Do not start a thread for a question you can answer from the CLI or a file.",
    '- Start one thread per piece of work: `daedal thread new --workspace <workspace> --name "<short name>" --message "<instructions>"`. It starts an ordinary session there and tracks it. Pick the workspace the work belongs to (`daedal workspace list`); never leave --workspace out. Then say which thread got what, one line each.',
    '- When the user points you at a session ("keep an eye on the stale-write session"), track it: `daedal thread track <session>`; find it with `daedal thread list --all`. When they tell you to stop, `daedal thread untrack <session>`; it keeps running.',
    '- Route a follow-up about running work to the thread that has it, `daedal thread say <session> "<text>"`, instead of starting a new one, and say where it went.',
    '- When you see work worth doing that the user did not ask for, suggest it instead of starting it: `daedal thread suggest "<title>" --workspace <workspace> --message "<instructions>"`. The user starts it from the Threads pane.',
    "- A tracked session's last message comes to you when its turn ends. Post to the user only when a thread finishes something or gets stuck, with the news in the first line. A thread waiting on the user shows in the Threads pane; do not relay its question.",
    '- When you need the user to decide something, run `daedal attention "<the question>"` as well as asking it, and `daedal attention --clear` once answered. A question only in your reply shows as done, not waiting on the user.',
    "- When a thread's work is done and checked, mark it resolved: `daedal thread done <session>`. It stops reporting to you.",
    "- Do not use `daedal agent spawn --team`: you track sessions, you do not lead a team.",
    "Follow the daedalus-orchestration skill. Then greet the user in one line and wait.",
  ].join("\n");
}

/**
 * Home's main agent: one Claude session in the hidden Home workspace, made on
 * first use. The row owns its sessions and the Home folder (`.home` under the
 * workspaces root, with MEMORY.md); the session itself runs at the Daedalus
 * home. It tracks its threads, ordinary sessions in any workspace; it leads
 * no team.
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

  /**
   * Moves the members of any team led from Home to tracked sessions of their
   * lead, clears their handles, and ends the team. The main agent once led
   * its threads as a team. Safe to run again: a second run finds nothing.
   * Returns the sessions it moved.
   */
  adoptTeamMembers(): string[] {
    const home = this.repositories.findHomeWorkspace();
    if (!home) return [];
    const at = new Date().toISOString();
    const moved: string[] = [];
    this.repositories.transaction(() => {
      for (const ability of this.repositories.abilities.list("orchestration")) {
        const lead = this.repositories.findAgent(ability.sessionId);
        if (lead?.workspaceId !== home.id) continue;
        for (const member of this.repositories.listTeamMembers(ability.id)) {
          if (member.id !== lead.id)
            this.repositories.tracks.add(lead.id, member.id, at);
          this.repositories.setAgentTeam(member.id, null, null);
          moved.push(member.id);
        }
        if (ability.enabled)
          this.repositories.abilities.update({
            ...ability,
            enabled: false,
            paused: false,
            pendingNote: null,
            revokedAt: at,
          });
      }
    });
    return moved;
  }

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
    const memory = join(workspace.path, HOME_MEMORY_FILE);
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
        homeAgentPrompt(memory, this.config.home),
      ].join("\n\n"),
    });
    return { workspace, session };
  }
}
