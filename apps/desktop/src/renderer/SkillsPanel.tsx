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
import { fuzzyScore } from "./repository-search";

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

const SOURCE_LABEL: Record<DiscoveredSkillDto["source"], string> = {
  "claude-personal": "Claude",
  "agents-personal": "Codex and Cursor",
  "cursor-personal": "Cursor",
  "claude-plugin": "Claude plugin",
};

/** A group's heading: the plugin's own name, or the provider it belongs to. */
export function sourceLabel(skill: DiscoveredSkillDto): string {
  return skill.sourceName ?? SOURCE_LABEL[skill.source];
}

/**
 * What a row shows for its path.
 *
 * The group header already carries the directory, so repeating it on every row
 * spends the width that would otherwise show the end of the path, which is the
 * part that identifies the skill. The full path is still on the row, as its
 * title, for anyone who wants to read or copy it.
 */
export function rowPath(skillPath: string, sourcePath: string): string {
  return skillPath.startsWith(`${sourcePath}/`)
    ? skillPath.slice(sourcePath.length + 1)
    : shortenPath(skillPath);
}

/** Shortens a path the way a shell prompt does, so a row stays one line. */
export function shortenPath(path: string, home = "/Users/"): string {
  const match = new RegExp(`^${home}[^/]+/`).exec(path);
  return match ? `~/${path.slice(match[0].length)}` : path;
}

export interface SkillGroup {
  key: string;
  label: string;
  /** Shown beside the label when the label alone does not say what this is. */
  qualifier?: string;
  path: string;
  skills: DiscoveredSkillDto[];
}

/**
 * Skills by the directory they were found in.
 *
 * Grouping by directory rather than by provider, because a name found in two
 * directories is two entries the providers will both load, and collapsing them
 * into one row would hide exactly the thing worth seeing. Order follows the
 * first appearance, so the list does not reshuffle as a filter narrows it.
 */
export function groupSkillsBySource(
  skills: DiscoveredSkillDto[],
): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const skill of skills) {
    const existing = groups.get(skill.sourcePath);
    if (existing) {
      existing.skills.push(skill);
      continue;
    }
    groups.set(skill.sourcePath, {
      key: skill.sourcePath,
      label: sourceLabel(skill),
      // A plugin group is headed by the plugin's name, which says nothing
      // about where it came from, so the kind rides along as a qualifier.
      ...(skill.sourceName ? { qualifier: SOURCE_LABEL[skill.source] } : {}),
      path: skill.sourcePath,
      skills: [skill],
    });
  }
  return [...groups.values()];
}

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
  const [filter, setFilter] = React.useState("");
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  const [viewing, setViewing] = React.useState<string>();
  const [content, setContent] = React.useState<{
    content: string;
    truncated: boolean;
  }>();

  /**
   * Opens a skill's own text, or closes it again.
   *
   * The content is fetched rather than carried on the listing: a list of forty
   * skills would otherwise ship forty files to draw forty one-line rows.
   */
  const view = React.useCallback(
    async (path: string) => {
      if (viewing === path) {
        setViewing(undefined);
        setContent(undefined);
        return;
      }
      setViewing(path);
      setContent(undefined);
      const response = await client.request.skillRead({ path });
      if (!response.ok) {
        onError(response.error.message);
        setViewing(undefined);
        return;
      }
      setContent({
        content: response.data.content,
        truncated: response.data.truncated,
      });
    },
    [client, onError, viewing],
  );

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
  // The same fuzzy matcher the repository picker uses, so typing "clsk" finds
  // a Claude skill here exactly as it would there. The name is scored ahead of
  // the path, because a path match on a shared parent directory would
  // otherwise rank every sibling equally.
  const found = (listing?.discovered ?? [])
    .map((skill) => ({
      skill,
      score: filter.trim()
        ? Math.max(
            (fuzzyScore(filter, skill.name) ?? Number.NEGATIVE_INFINITY) + 60,
            fuzzyScore(filter, skill.skillPath) ?? Number.NEGATIVE_INFINITY,
          )
        : 0,
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.skill);
  const groups = groupSkillsBySource(found);
  // A filter that matched something opens what it matched: collapsed groups
  // would hide the result and read as "nothing found".
  const filtering = filter.trim().length > 0;

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

      <h3>Found on this machine</h3>
      <p className="skills-note">
        Everything your agents can see, including skills Daedalus did not
        install. Turning one off uses the provider's own switch. Codex applies
        that only after it restarts, and it applies everywhere.
      </p>
      {listing && listing.discovered.length > 6 ? (
        <input
          aria-label="Filter skills"
          className="skills-filter"
          disabled={disabled}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by name or path"
          value={filter}
        />
      ) : undefined}
      {listing && found.length === 0 ? (
        <p className="skills-note">
          {listing.discovered.length ? "Nothing matches." : "Nothing found."}
        </p>
      ) : undefined}
      {groups.map((group) => {
        const open = filtering || !collapsed.has(group.key);
        return (
          <section className="skills-group" key={group.key}>
            <button
              aria-expanded={open}
              className="skills-group-head"
              onClick={() =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(group.key)) next.delete(group.key);
                  else next.add(group.key);
                  return next;
                })
              }
              type="button"
            >
              <span className={`skills-caret ${open ? "is-open" : ""}`}>›</span>
              <strong>{group.label}</strong>
              {group.qualifier ? (
                <span className="skills-tag">{group.qualifier}</span>
              ) : undefined}
              <code>{shortenPath(group.path)}</code>
              <span className="skills-count">{group.skills.length}</span>
            </button>
            {open ? (
              <ul className="skills-found">
                {group.skills.map((skill) => (
                  <DiscoveredRow
                    key={skill.skillPath}
                    disabled={disabled}
                    expanded={viewing === skill.skillPath}
                    content={viewing === skill.skillPath ? content : undefined}
                    onToggle={() => void view(skill.skillPath)}
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
            ) : undefined}
          </section>
        );
      })}
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
          className="switch"
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
  expanded,
  content,
  onToggle,
  onVisibility,
}: {
  content?: { content: string; truncated: boolean };
  disabled: boolean;
  expanded: boolean;
  onToggle: () => void;
  onVisibility: (visibility: "on" | "off") => void;
  skill: DiscoveredSkillDto;
}) {
  return (
    <li
      className={`skills-found-row ${expanded ? "is-open" : ""} ${
        skill.visibility === "off" ? "is-off" : ""
      }`}
    >
      <button
        aria-expanded={expanded}
        className="skills-row-head"
        onClick={onToggle}
        type="button"
      >
        <strong>{skill.name}</strong>
        {skill.invocation === "auto" ? undefined : (
          <span className="skills-tag">
            {INVOCATION_LABEL[skill.invocation]}
          </span>
        )}
        {skill.origin === "user" ? undefined : (
          <span className="skills-tag">{skill.origin}</span>
        )}
        {skill.problem ? (
          <span className="skills-tag is-problem">
            {PROBLEM_LABEL[skill.problem]}
          </span>
        ) : undefined}
        <code title={skill.skillPath}>
          {rowPath(skill.skillPath, skill.sourcePath)}
        </code>
      </button>
      <label className="skills-switch" title="Let your agents load this skill">
        <input
          checked={skill.visibility === "on"}
          className="switch"
          disabled={disabled}
          onChange={(event) =>
            onVisibility(event.target.checked ? "on" : "off")
          }
          type="checkbox"
        />
      </label>
      {expanded ? (
        <div className="skills-detail">
          {skill.description ? <p>{skill.description}</p> : undefined}
          <p className="skills-note">
            {skill.providers.map((one) => PROVIDER_LABEL[one]).join(", ")} ·{" "}
            {INVOCATION_LABEL[skill.invocation]}
          </p>
          {content ? (
            <pre>
              {content.content}
              {content.truncated ? "\n\n[…truncated]" : ""}
            </pre>
          ) : (
            <p className="skills-note">Reading…</p>
          )}
        </div>
      ) : undefined}
    </li>
  );
}
