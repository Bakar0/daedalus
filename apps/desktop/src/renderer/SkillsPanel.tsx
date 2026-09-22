/**
 * The Skills panel.
 *
 * Its own file rather than another few hundred lines of `WorkspaceApp.tsx`,
 * which is already the one place in the app where the layering discipline has
 * not been applied.
 *
 * The panel answers one question: what can my agents see right now, and where
 * did it come from. That is why every row carries its path. A control plane
 * that writes into a user's provider directories has to show its work, and the
 * paths are the work.
 */
import React from "react";
import type {
  DiscoveredSkillDto,
  ManagedSkillDto,
  SkillListingDto,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";

const PROVIDER_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};

const INVOCATION_LABEL: Record<string, string> = {
  auto: "agent may pick it",
  "user-only": "only when you ask",
  "model-only": "only the agent",
};

const PROBLEM_LABEL: Record<string, string> = {
  "unreadable-frontmatter": "Daedalus cannot read its frontmatter",
  "name-mismatch": "its name does not match its folder",
  "broken-link": "its link points at nothing",
};

const VISIBILITIES = ["on", "name-only", "user-invocable-only", "off"] as const;

/** What a managed row says under its title once it is on. */
export function managedDetail(skill: ManagedSkillDto): string {
  if (!skill.enabled) return "Off. Nothing is installed.";
  const blocked = skill.artifacts.filter((artifact) => artifact.blocked);
  if (blocked.length)
    return `${blocked.length} path(s) already had something else, so Daedalus left them alone.`;
  const missing = skill.artifacts.filter(
    (artifact) => !artifact.present && !artifact.blocked,
  );
  if (missing.length) return `${missing.length} artifact(s) missing.`;
  return skill.mode === "always"
    ? "Applies to every response. Claude picks the style up on its next session; Codex reads its instructions at startup."
    : "Installed. Call it by name.";
}

export function SkillsPanel({
  client,
  busy,
  onError,
}: {
  busy: boolean;
  client: DesktopClient;
  onError: (message: string | undefined) => void;
}) {
  const [listing, setListing] = React.useState<SkillListingDto>();
  const [working, setWorking] = React.useState(false);
  const [source, setSource] = React.useState("");
  const [subpath, setSubpath] = React.useState("");

  const reload = React.useCallback(async () => {
    const response = await client.request.skillList({});
    if (response.ok) setListing(response.data);
    else onError(response.error.message);
  }, [client, onError]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  async function run(operation: Promise<{ ok: boolean } & object>) {
    setWorking(true);
    onError(undefined);
    try {
      const response = (await operation) as
        { ok: true } | { ok: false; error: { message: string } };
      if (!response.ok) {
        onError(response.error.message);
        return;
      }
      await reload();
    } finally {
      setWorking(false);
    }
  }

  const disabled = busy || working;
  // A git URL and a local directory go in the same box, because the user is
  // answering one question and should not have to pick a form first.
  const looksLikeGit = /^(https?:\/\/|git@)/.test(source.trim());

  return (
    <div className="skills-panel">
      <h3>From Daedalus</h3>
      <p className="skills-note">
        Installed under your home directory, so they apply to every session on
        this machine, not only the ones Daedalus starts.
      </p>
      {(listing?.managed ?? []).map((skill) => (
        <ManagedRow
          key={skill.id}
          disabled={disabled}
          skill={skill}
          onRemove={() =>
            void run(client.request.skillRemove({ name: skill.id }))
          }
          onSet={(enabled, mode) =>
            void run(
              client.request.skillSet({
                id: skill.id,
                enabled,
                ...(mode ? { mode } : {}),
              }),
            )
          }
        />
      ))}

      <h3>Install a skill</h3>
      <div className="skills-install">
        <input
          aria-label="Skill source"
          disabled={disabled}
          onChange={(event) => setSource(event.target.value)}
          placeholder="A folder with a SKILL.md, or a git URL"
          value={source}
        />
        {looksLikeGit ? (
          <input
            aria-label="Path inside the repository"
            disabled={disabled}
            onChange={(event) => setSubpath(event.target.value)}
            placeholder="pstack/skills/no-comments"
            value={subpath}
          />
        ) : undefined}
        <button
          disabled={disabled || !source.trim()}
          onClick={() =>
            void run(
              client.request.skillInstall(
                looksLikeGit
                  ? { git: source.trim(), subpath: subpath.trim() }
                  : { path: source.trim() },
              ),
            ).then(() => {
              setSource("");
              setSubpath("");
            })
          }
        >
          Install
        </button>
      </div>

      <h3>Found on this machine</h3>
      <p className="skills-note">
        Everything your agents can see, including skills Daedalus did not
        install. Turning one off uses the provider's own switch. Codex applies
        that only after it restarts, and it applies everywhere.
      </p>
      {listing && listing.discovered.length === 0 ? (
        <p className="skills-note">Nothing found.</p>
      ) : undefined}
      <ul className="skills-found">
        {(listing?.discovered ?? []).map((skill) => (
          <DiscoveredRow
            key={`${skill.name}:${skill.skillPath}`}
            disabled={disabled}
            skill={skill}
            onVisibility={(visibility) =>
              void run(
                client.request.skillVisibilitySet({
                  name: skill.name,
                  visibility,
                }),
              )
            }
          />
        ))}
      </ul>
    </div>
  );
}

export function ManagedRow({
  skill,
  disabled,
  onSet,
  onRemove,
}: {
  disabled: boolean;
  onRemove: () => void;
  onSet: (enabled: boolean, mode?: "on-demand" | "always") => void;
  skill: ManagedSkillDto;
}) {
  return (
    <div className="skills-managed">
      <label className="settings-toggle">
        <input
          checked={skill.enabled}
          disabled={disabled}
          onChange={(event) => onSet(event.target.checked)}
          type="checkbox"
        />
        <span>
          <strong>{skill.title}</strong>
          <small>{skill.summary}</small>
        </span>
      </label>
      {skill.supportsAlways && skill.enabled ? (
        <label className="skills-mode">
          <span>How much</span>
          <select
            aria-label={`${skill.title} mode`}
            disabled={disabled}
            onChange={(event) =>
              onSet(true, event.target.value as "on-demand" | "always")
            }
            value={skill.mode}
          >
            <option value="on-demand">On demand, when you ask for it</option>
            <option value="always">Always, on every response</option>
          </select>
        </label>
      ) : undefined}
      <p className="skills-note">{managedDetail(skill)}</p>
      {skill.enabled ? (
        <ul className="skills-artifacts">
          {skill.artifacts.map((artifact) => (
            <li key={artifact.path}>
              <span className="skills-kind">{artifact.kind}</span>
              <code>{artifact.path}</code>
              <span>
                {artifact.blocked
                  ? "left alone"
                  : artifact.present
                    ? "installed"
                    : "absent"}
              </span>
            </li>
          ))}
        </ul>
      ) : undefined}
      {skill.source ? (
        <button className="quiet" disabled={disabled} onClick={onRemove}>
          Remove
        </button>
      ) : undefined}
    </div>
  );
}

export function DiscoveredRow({
  skill,
  disabled,
  onVisibility,
}: {
  disabled: boolean;
  onVisibility: (visibility: (typeof VISIBILITIES)[number]) => void;
  skill: DiscoveredSkillDto;
}) {
  return (
    <li className="skills-found-row">
      <div>
        <strong>{skill.name}</strong>
        <span className="skills-origin">{skill.origin}</span>
        <span>
          {skill.providers.map((one) => PROVIDER_LABEL[one]).join(", ")}
        </span>
        <span>{INVOCATION_LABEL[skill.invocation]}</span>
      </div>
      {skill.description ? <small>{skill.description}</small> : undefined}
      <code>{skill.skillPath}</code>
      {skill.problem ? (
        <p className="skills-problem">{PROBLEM_LABEL[skill.problem]}</p>
      ) : undefined}
      <select
        aria-label={`${skill.name} visibility`}
        disabled={disabled}
        onChange={(event) =>
          onVisibility(event.target.value as (typeof VISIBILITIES)[number])
        }
        value={skill.visibility}
      >
        {VISIBILITIES.map((visibility) => (
          <option key={visibility} value={visibility}>
            {visibility}
          </option>
        ))}
      </select>
    </li>
  );
}
