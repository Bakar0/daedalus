import { join } from "node:path";
import { pathExists } from "@daedalus/platform";
import type { DaedalusConfig } from "../config";
import type { AgentSession } from "../domain";
import { DaedalusError } from "../errors";
import {
  channelArtifactName,
  skillLinkPaths,
  type SkillProvider,
} from "./skills";

/**
 * Which Daedalus skills a session can be asked to run. Not re-exported from
 * the package: only the services that type a skill into a session need it.
 */

/** The skill's installed name for the provider, if it is installed. */
export async function installedSkill(
  config: DaedalusConfig,
  provider: SkillProvider,
  skillId: string,
): Promise<string | undefined> {
  const skillName = channelArtifactName(config, skillId);
  const installed = skillLinkPaths(config, skillName).find((link) =>
    link.providers.includes(provider),
  );
  return installed && (await pathExists(join(installed.path, "SKILL.md")))
    ? skillName
    : undefined;
}

/** The skill's installed name, or `CONFLICT` when it is not installed. */
export async function requireSkill(
  config: DaedalusConfig,
  session: AgentSession,
  skillId: string,
): Promise<string> {
  if (session.provider !== "claude" && session.provider !== "codex")
    throw new DaedalusError(
      "CONFLICT",
      "Only Claude and Codex sessions can run Daedalus skills",
    );
  const skillName = await installedSkill(config, session.provider, skillId);
  if (!skillName)
    throw new DaedalusError(
      "CONFLICT",
      `The ${skillId} skill is not installed for ${session.provider}. Turn it on in Settings, Skills, or with 'daedal skill enable ${skillId}'.`,
    );
  return skillName;
}
