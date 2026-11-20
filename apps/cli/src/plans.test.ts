import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import {
  NO_LOGIN_SHELL,
  withTemporaryDaedalusHome,
} from "@daedalus/test-utils";
import { parsePlan } from "@daedalus/core";
import { printPlan } from "./plans";

async function cli(home: string, args: string[], stdin?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...NO_LOGIN_SHELL,
    DAEDALUS_HOME: home,
  };
  // Run as the user, not as the session this suite may be running in.
  for (const name of Object.keys(env))
    if (name.startsWith("DAEDALUS_") && name !== "DAEDALUS_HOME")
      delete env[name];
  delete env.TMUX;
  const child = Bun.spawn(
    [process.execPath, "run", join(import.meta.dir, "index.ts"), ...args],
    {
      env,
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

test("plan new, start, ask, done and show through the CLI", async () => {
  await withTemporaryDaedalusHome(async (home) => {
    expect((await cli(home, ["workspace", "create", "Demo"])).exitCode).toBe(0);
    const created = await cli(
      home,
      [
        "plan",
        "new",
        "Cart API v2",
        "--workspace",
        "demo",
        "--owner",
        "lead",
        "--body-file",
        "-",
      ],
      "## Tasks\n\n- [ ] Endpoints ^endpoints\n- [ ] Storage ^storage\n",
    );
    expect(created.stderr).toBe("");
    const path = join(
      home,
      "workspaces",
      "demo",
      "plans",
      "cart-api-v2.plan.md",
    );
    expect(created.stdout).toContain(path);

    const scope = ["--workspace", "demo"];
    expect(
      (
        await cli(home, [
          "plan",
          "start",
          "cart-api-v2",
          "^endpoints",
          "--owner",
          "api",
          ...scope,
        ])
      ).stdout,
    ).toContain("[/] Endpoints @api");
    // An ask needs the session that waits on it; outside one it is refused.
    const asked = await cli(home, [
      "plan",
      "ask",
      "cart-api-v2",
      "^storage",
      "Which index?",
      ...scope,
    ]);
    expect(asked.exitCode).not.toBe(0);
    expect(asked.stderr).toContain("--session <session>");
    await cli(home, ["plan", "done", path, "^endpoints"]);
    expect(await readFile(path, "utf8")).toBe(
      [
        "---",
        'plan: "Cart API v2"',
        "owner: lead",
        "---",
        "",
        "# Cart API v2",
        "",
        "## Tasks",
        "",
        "- [x] Endpoints @api ^endpoints",
        "- [ ] Storage ^storage",
        "",
      ].join("\n"),
    );

    const shown = await cli(home, ["plan", "show", "cart-api-v2", ...scope]);
    expect(shown.stdout).toContain("1 of 2 tasks done");
    const listed = await cli(home, ["plan", "list", "--json", ...scope]);
    expect(JSON.parse(listed.stdout).data[0]).toMatchObject({
      path: "plans/cart-api-v2.plan.md",
      done: 1,
      total: 2,
      questions: 0,
    });

    const missing = await cli(home, [
      "plan",
      "drop",
      "cart-api-v2",
      "^nope",
      ...scope,
    ]);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("plan show");
  });
}, 30_000);

test("plan show marks a task that waits on the user's answer", () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    printPlan(
      {
        scope: { workspace: "w" },
        workspaceId: "w",
        root: "/w",
        path: "plans/release.plan.md",
        absolutePath: "/w/plans/release.plan.md",
      },
      parsePlan(
        "# Release\n\n## Tasks\n\n- [ ] Build ^build\n- [ ] Store ^store\n",
      ),
      [],
      [{ number: 5, taskKey: "store" }],
    );
  } finally {
    console.log = log;
  }
  const output = lines.join("\n");
  expect(output).toContain("[ ] Store ^store  <- #5 waits on the user");
  expect(output).not.toContain("Build ^build  <-");
});
