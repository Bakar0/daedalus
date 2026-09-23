import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { DiscoveredSkillDto, ManagedSkillDto } from "@daedalus/protocol";
import {
  DiscoveredRow,
  ManagedRow,
  groupSkillsBySource,
  managedDetail,
  rowPath,
  shortenPath,
  sourceLabel,
  visibilityReach,
} from "./SkillsPanel";

const discoveredSkill = (
  overrides: Partial<DiscoveredSkillDto> = {},
): DiscoveredSkillDto => ({
  name: "broken",
  description: "A long description that only belongs in the expanded state.",
  skillPath: "/Users/someone/.cursor/skills/broken/SKILL.md",
  providers: ["cursor"],
  origin: "user",
  source: "cursor-personal",
  sourcePath: "/Users/someone/.cursor/skills",
  invocation: "auto",
  visibility: "on",
  ...overrides,
});

const managed = (
  overrides: Partial<ManagedSkillDto> = {},
): ManagedSkillDto => ({
  id: "unslop",
  title: "Unslop",
  summary: "Cuts AI tells.",
  supportsAlways: true,
  enabled: true,
  mode: "always",
  artifacts: [
    {
      kind: "skill",
      path: "/home/.claude/skills/unslop",
      present: true,
      blocked: false,
    },
  ],
  ...overrides,
});

describe("managedDetail", () => {
  test("separates off, installed, always, and blocked", () => {
    expect(managedDetail(managed({ enabled: false }))).toContain(
      "Nothing is installed",
    );
    expect(managedDetail(managed({ mode: "on-demand" }))).toContain(
      "Call it by name",
    );
    expect(managedDetail(managed())).toContain("every response");
  });

  test("a path Daedalus left alone outranks everything else it could say", () => {
    // The user needs to know their own file is still there and the toggle did
    // not take, which matters more than the mode the toggle is now in.
    const detail = managedDetail(
      managed({
        artifacts: [
          {
            kind: "skill",
            path: "/home/.claude/skills/unslop",
            present: false,
            blocked: true,
          },
        ],
      }),
    );
    expect(detail).toContain("left them alone");
  });

  test("counts an artifact that is simply missing", () => {
    expect(
      managedDetail(
        managed({
          artifacts: [
            {
              kind: "style",
              path: "/home/.claude/output-styles/Unslop.md",
              present: false,
              blocked: false,
            },
          ],
        }),
      ),
    ).toContain("1 artifact(s) missing");
  });
});

describe("rows", () => {
  test("a managed row shows the mode picker only when it has one and is on", () => {
    const withAlways = renderToStaticMarkup(
      <ManagedRow
        disabled={false}
        onRemove={() => undefined}
        onSet={() => undefined}
        skill={managed()}
      />,
    );
    expect(withAlways).toContain("Always, on every response");
    expect(withAlways).toContain("/home/.claude/skills/unslop");

    const control = renderToStaticMarkup(
      <ManagedRow
        disabled={false}
        onRemove={() => undefined}
        onSet={() => undefined}
        skill={managed({ id: "daedalus-control", supportsAlways: false })}
      />,
    );
    expect(control).not.toContain("Always, on every response");
  });

  test("a managed row offers Remove only for a skill the user installed", () => {
    expect(
      renderToStaticMarkup(
        <ManagedRow
          disabled={false}
          onRemove={() => undefined}
          onSet={() => undefined}
          skill={managed()}
        />,
      ),
    ).not.toContain("Remove");
    expect(
      renderToStaticMarkup(
        <ManagedRow
          disabled={false}
          onRemove={() => undefined}
          onSet={() => undefined}
          skill={managed({ source: { kind: "path", ref: "/src/mine" } })}
        />,
      ),
    ).toContain("Remove");
  });

  test("the row control is a switch, and off reads as off", () => {
    // Not a four-way picker: `name-only` means nothing to a user and
    // `user-invocable-only` is the skill author's call, already shown as a tag.
    const on = renderToStaticMarkup(
      <DiscoveredRow
        disabled={false}
        expanded={false}
        onToggle={() => undefined}
        onVisibility={() => undefined}
        skill={discoveredSkill()}
      />,
    );
    // Still a real checkbox, so it keeps its role, label, Space key and focus
    // ring; only its appearance is replaced.
    expect(on).toContain('type="checkbox"');
    expect(on).toContain('class="switch"');
    expect(on).not.toContain("<select");
    expect(on).not.toContain("name-only");
    expect(on).not.toContain("is-off");

    const off = renderToStaticMarkup(
      <DiscoveredRow
        disabled={false}
        expanded={false}
        onToggle={() => undefined}
        onVisibility={() => undefined}
        skill={discoveredSkill({ visibility: "off" })}
      />,
    );
    expect(off).toContain("is-off");
  });

  test("a collapsed row is one line: name, path, and any problem", () => {
    const markup = renderToStaticMarkup(
      <DiscoveredRow
        disabled={false}
        expanded={false}
        onToggle={() => undefined}
        onVisibility={() => undefined}
        skill={discoveredSkill({ problem: "unreadable-frontmatter" })}
      />,
    );
    // The row shows the part under the group, and carries the whole path as
    // its title so nothing is actually lost.
    expect(markup).toContain(">broken/SKILL.md<");
    expect(markup).toContain(
      'title="/Users/someone/.cursor/skills/broken/SKILL.md"',
    );
    expect(markup).toContain("cannot read its frontmatter");
    // The description and the provider list belong to the expanded state, or
    // the row stops being one line.
    expect(markup).not.toContain("skills-detail");
    expect(markup).not.toContain("A long description");
  });

  test("expanding a row shows its detail, then its text once it arrives", () => {
    const waiting = renderToStaticMarkup(
      <DiscoveredRow
        disabled={false}
        expanded
        onToggle={() => undefined}
        onVisibility={() => undefined}
        skill={discoveredSkill()}
      />,
    );
    expect(waiting).toContain("A long description");
    expect(waiting).toContain("Cursor");
    expect(waiting).toContain("Reading…");

    const loaded = renderToStaticMarkup(
      <DiscoveredRow
        content={{ content: "---\nname: broken\n---\n", truncated: true }}
        disabled={false}
        expanded
        onToggle={() => undefined}
        onVisibility={() => undefined}
        skill={discoveredSkill()}
      />,
    );
    expect(loaded).toContain("name: broken");
    expect(loaded).toContain("truncated");
    expect(loaded).not.toContain("Reading…");
  });
});

describe("what a switch reaches", () => {
  test("names the catch for each provider that can be reached", () => {
    const claude = visibilityReach(discoveredSkill({ providers: ["claude"] }));
    expect(claude.reachable).toBe(true);
    // The override lands in Claude's own settings file, so it reaches every
    // Claude session and not only the ones Daedalus starts.
    expect(claude.sentences.join(" ")).toContain("everywhere, from its next");

    const shared = visibilityReach(
      discoveredSkill({ providers: ["codex", "cursor"] }),
    );
    expect(shared.reachable).toBe(true);
    expect(shared.sentences.join(" ")).toContain("once Codex restarts");
    expect(shared.sentences.join(" ")).toContain("Cursor: not reached");
  });

  test("a skill only Cursor loads cannot be reached at all", () => {
    const reach = visibilityReach(discoveredSkill({ providers: ["cursor"] }));
    expect(reach.reachable).toBe(false);
    expect(reach.sentences.join(" ")).toContain("Move or rename its folder");
  });

  test("its switch is disabled rather than pretending to work", () => {
    const markup = renderToStaticMarkup(
      <DiscoveredRow
        disabled={false}
        expanded={false}
        onToggle={() => undefined}
        onVisibility={() => undefined}
        skill={discoveredSkill({ providers: ["cursor"] })}
      />,
    );
    expect(markup).toContain('disabled=""');

    const reachable = renderToStaticMarkup(
      <DiscoveredRow
        disabled={false}
        expanded={false}
        onToggle={() => undefined}
        onVisibility={() => undefined}
        skill={discoveredSkill({ providers: ["claude"] })}
      />,
    );
    expect(reachable).not.toContain('disabled=""');
  });
});

describe("grouping", () => {
  test("groups by the directory, keeping first-seen order", () => {
    const groups = groupSkillsBySource([
      discoveredSkill({ name: "a", sourcePath: "/home/.claude/skills" }),
      discoveredSkill({ name: "b", sourcePath: "/home/.agents/skills" }),
      discoveredSkill({ name: "c", sourcePath: "/home/.claude/skills" }),
    ]);
    expect(groups.map((group) => group.path)).toEqual([
      "/home/.claude/skills",
      "/home/.agents/skills",
    ]);
    expect(groups[0]?.skills.map((skill) => skill.name)).toEqual(["a", "c"]);
  });

  test("each plugin is its own group under its own name", () => {
    // One "Claude plugin" heading covering several different plugins told the
    // user nothing about which plugin a skill came from.
    const groups = groupSkillsBySource([
      discoveredSkill({
        name: "a",
        source: "claude-plugin",
        sourceName: "pstack",
        sourcePath: "/home/.claude/plugins/pstack/skills",
      }),
      discoveredSkill({
        name: "b",
        source: "claude-plugin",
        sourceName: "toolkit",
        sourcePath: "/home/.claude/plugins/market/toolkit/skills",
      }),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["pstack", "toolkit"]);
    // The name says which plugin; the qualifier says what kind of thing it is.
    expect(groups.every((group) => group.qualifier === "Claude plugin")).toBe(
      true,
    );
  });

  test("a provider directory is named after the provider, with no qualifier", () => {
    const [group] = groupSkillsBySource([
      discoveredSkill({ source: "claude-personal", sourcePath: "/a" }),
    ]);
    expect(group?.label).toBe("Claude");
    expect(group?.qualifier).toBeUndefined();
    expect(sourceLabel(discoveredSkill({ source: "agents-personal" }))).toBe(
      "Codex and Cursor",
    );
  });

  test("one name in two directories stays two entries", () => {
    // Both are loaded by a provider, so collapsing them would hide the very
    // thing the list exists to show.
    const groups = groupSkillsBySource([
      discoveredSkill({ name: "twins", sourcePath: "/home/.claude/skills" }),
      discoveredSkill({ name: "twins", sourcePath: "/home/.cursor/skills" }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe("paths", () => {
  test("a row drops the group's directory and keeps anything outside it", () => {
    expect(rowPath("/a/b/skills/x/SKILL.md", "/a/b/skills")).toBe("x/SKILL.md");
    expect(rowPath("/Users/someone/elsewhere/SKILL.md", "/a/b/skills")).toBe(
      "~/elsewhere/SKILL.md",
    );
  });

  test("replaces the home prefix and leaves anything else alone", () => {
    expect(shortenPath("/Users/someone/.claude/skills/x/SKILL.md")).toBe(
      "~/.claude/skills/x/SKILL.md",
    );
    expect(shortenPath("/etc/codex/skills/x/SKILL.md")).toBe(
      "/etc/codex/skills/x/SKILL.md",
    );
  });
});
