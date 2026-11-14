import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { parsePlan } from "@daedalus/core";
import type { PlanOwnerDto, PlanViewDto } from "@daedalus/protocol";
import type { DesktopClient } from "../client-types";
import { PlanView } from "./PlanView";

const root = join(import.meta.dir, "../../../../..");
const source = readFileSync(
  join(root, "tests/fixtures/plans/cart-api-v2.plan.md"),
  "utf8",
);

const owner = (handle: string, state: PlanOwnerDto["state"]): PlanOwnerDto => ({
  handle,
  state,
  sessionId: state === "none" ? null : `${handle}-id`,
  sessionName: state === "none" ? null : handle,
});

function render(): string {
  const plan = parsePlan(source);
  const view: PlanViewDto = {
    title: plan.title,
    owner: plan.owner,
    blocks: plan.blocks,
    hasTasksSection: plan.hasTasksSection,
    absolutePath: "/w/checkout/plans/cart-api-v2.plan.md",
    owners: [
      owner("checkout-lead", "working"),
      owner("api", "working"),
      owner("db", "waiting"),
      owner("payments", "idle"),
      owner("ui", "none"),
      owner("cache", "stopped"),
    ],
  };
  return renderToStaticMarkup(
    <PlanView
      client={{} as DesktopClient}
      initialView={view}
      live={{ liveKey: "", workspaceName: "checkout", openSession: () => {} }}
      onError={() => {}}
      onFileChanged={() => {}}
      path="plans/cart-api-v2.plan.md"
      text={source}
      workspaceId="w"
    />,
  );
}

test("the header shows progress, the owner and where the plan is", () => {
  const html = render();
  expect(html).toContain("33% · 3 of 9 tasks done");
  expect(html).toContain('class="plan-owner plan-owner-working"');
  expect(html).toContain("checkout · plans/cart-api-v2.plan.md");
});

test("Needs you lists the open questions with whoever answers them", () => {
  const html = render();
  expect(html).toContain("Needs you · 2");
  expect(html).toContain("@db: <a");
  expect(html).toContain("Ship behind the old provider");
});

test("tasks are drawn in place with state, owner chip and actions", () => {
  const html = render();
  // A still half circle for doing; no spinner anywhere.
  expect(html).toContain('d="M7 1 A6 6 0 0 1 7 13 Z"');
  expect(html).not.toMatch(/spin/i);
  expect(html).toContain('class="plan-owner plan-owner-waiting"');
  // An owner with a session can be opened; an unowned task can be started.
  expect(html).toMatch(/data-task="\^endpoints"[\s\S]*?>Open</);
  expect(html).toMatch(/data-task="\^screens"[\s\S]*?>Start agent</);
  // A done task offers no Start.
  expect(html).not.toMatch(
    /data-task="\^migrate"[^]*?Start agent[^]*?data-task="\^endpoints"/,
  );
  // Every button is the plan's own, never the app's blue default.
  for (const [, classes] of html.matchAll(/<button[^>]*class="([^"]*)"/g))
    expect(classes).toMatch(/^plan-/);
});

test("rendered blocks carry their source lines for Ask", () => {
  const html = render();
  const lines = source.split("\n");
  const at = (text: string) =>
    lines.findIndex((line) => line.includes(text)) + 1;
  expect(html).toContain(`data-l0="${at("- [/] Cart endpoints")}"`);
  expect(html).toContain(
    `data-l0="${at("Build the four endpoints")}" data-l1="${at("Build the four endpoints")}"`,
  );
  expect(html).toContain(`data-l0="${at("Which index")}"`);
  // A task's markup says who answers for text inside it.
  expect(html).toContain('data-owner="api" data-task="^stale"');
});

test("plan buttons are left out of the global blue button rule", () => {
  const css = readFileSync(join(import.meta.dir, "../styles.css"), "utf8");
  const rules = css.match(/button:not\([^)]*\)/g) ?? [];
  expect(rules.length).toBeGreaterThanOrEqual(2);
  for (const rule of rules.filter((item) => item.includes(".workspace-item")))
    expect(rule).toContain(".plan-scroll button");
});
