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
    expect(markup).not.toContain("Cursor");
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
