import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { PlanListDto, PlanListItemDto } from "@daedalus/protocol";
import { PlansPane } from "./PlansPane";

const item = (fields: Partial<PlanListItemDto>): PlanListItemDto => ({
  path: "plans/x.plan.md",
  title: "X",
  done: 0,
  total: 0,
  questions: 0,
  owner: null,
  ...fields,
});

const render = (list?: PlanListDto) =>
  renderToStaticMarkup(
    <PlansPane
      list={list}
      onCreate={() => {}}
      onOpen={() => {}}
      onOpenPlan={() => {}}
    />,
  );

describe("PlansPane", () => {
  test("a row: title, questions for the user, progress and the owner's dot", () => {
    const html = render({
      home: false,
      groups: [
        {
          workspaceId: "w1",
          name: "Checkout",
          plans: [
            item({
              path: "plans/cart.plan.md",
              title: "Cart API v2",
              done: 3,
              total: 9,
              questions: 2,
              owner: {
                handle: "lead",
                sessionId: "s1",
                sessionName: "Checkout lead",
                state: "working",
              },
            }),
            item({ title: "Search", done: 2, total: 2 }),
          ],
        },
      ],
    });
    expect(html).toContain("Plans");
    expect(html).toContain("+ New");
    expect(html).toContain("Open ");
    expect(html).toContain("Cart API v2");
    expect(html).toContain("2 for you");
    expect(html).toContain("3/9");
    expect(html).toContain("plan-owner-working");
    expect(html).toContain("@lead · working — Checkout lead");
    expect(html).toContain('title="plans/cart.plan.md"');
    // Finished, its progress is marked done; no questions, no amber.
    expect(html).toContain('class="plans-pane-progress done"');
    expect(html.match(/for you/g)).toHaveLength(1);
    // One workspace: no group heading.
    expect(html).not.toContain("plans-pane-group-name");
  });

  test("keeps the order the host sends", () => {
    const html = render({
      home: false,
      groups: [
        {
          workspaceId: "w1",
          name: "W",
          plans: [
            item({ path: "a", title: "Needs you", questions: 1 }),
            item({ path: "b", title: "Going", done: 1, total: 3 }),
            item({ path: "c", title: "Finished", done: 1, total: 1 }),
          ],
        },
      ],
    });
    const at = (text: string) => html.indexOf(text);
    expect(at("Needs you")).toBeLessThan(at("Going"));
    expect(at("Going")).toBeLessThan(at("Finished"));
  });

  test("at Home, plans are under their workspace's name", () => {
    const html = render({
      home: true,
      groups: [
        {
          workspaceId: null,
          name: "Home",
          plans: [item({ title: "Quarter" })],
        },
        {
          workspaceId: "w1",
          name: "Checkout",
          plans: [item({ title: "Cart" })],
        },
      ],
    });
    expect(html).toContain('<div class="plans-pane-group-name">Home</div>');
    expect(html).toContain('<div class="plans-pane-group-name">Checkout</div>');
    expect(html.indexOf("Quarter")).toBeLessThan(html.indexOf("Checkout"));
    expect(html.indexOf("Checkout")).toBeLessThan(html.indexOf("Cart"));
  });

  test("with none, one quiet line and the New link", () => {
    const html = render({ home: false, groups: [] });
    expect(html).toContain("No plans yet");
    expect(html.match(/\+ New/g)).toHaveLength(1);
    // Before the first read, nothing; no spinner.
    expect(render()).not.toContain("No plans yet");
  });
});
