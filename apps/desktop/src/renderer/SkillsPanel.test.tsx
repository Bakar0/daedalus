import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { DiscoveredSkillDto, ManagedSkillDto } from "@daedalus/protocol";
import { DiscoveredRow, ManagedRow, managedDetail } from "./SkillsPanel";

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

  test("a discovered row carries its path, origin, and any problem", () => {
    const skill: DiscoveredSkillDto = {
      name: "broken",
      description: "",
      skillPath: "/home/.cursor/skills/broken/SKILL.md",
      providers: ["cursor"],
      origin: "user",
      invocation: "auto",
      visibility: "on",
      problem: "unreadable-frontmatter",
    };
    const markup = renderToStaticMarkup(
      <DiscoveredRow
        disabled={false}
        onVisibility={() => undefined}
        skill={skill}
      />,
    );
    expect(markup).toContain("/home/.cursor/skills/broken/SKILL.md");
    expect(markup).toContain("cannot read its frontmatter");
    expect(markup).toContain("Cursor");
  });
});
