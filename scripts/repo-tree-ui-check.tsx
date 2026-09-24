/**
 * Checks the repository tree against a real browser. Since #27 the tree sits
 * under the task brief in the board's inspector column, so that is where it
 * is measured; the rows and buttons are the ones the explorer used to hold.
 *
 * Two bugs shipped through a green suite here, and both were invisible to
 * assertions about markup because both were purely about geometry:
 *
 *   1. The fetch/pull/push buttons rendered unpressable, because the rule that
 *      gives those icon buttons their box was named for the single sync button
 *      that used to be the only one, and the new buttons never carried it.
 *   2. The rows overflowed their column and pushed their action buttons past
 *      its edge, because `.workspace-repository-group` is a grid item and a
 *      grid item's default `min-width: auto` means min-content.
 *
 * So this measures rather than reads: every row fits inside the repositories
 * section, and every action button is actually clickable. Both assertions were
 * run against the two broken stylesheets and seen to fail before being trusted.
 *
 * Gated like the other browser checks: `bun run test:repo-tree-ui`.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  DesktopSnapshotDto,
  WorkspaceContentDto,
} from "@daedalus/protocol";
import { WorkspaceApp } from "../apps/desktop/src/renderer/WorkspaceApp";
import type { DesktopClient } from "../apps/desktop/src/renderer/client-types";

const projectRoot = resolve(import.meta.dir, "..");
const port = 41743;
const debuggingPort = 41744;
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifactsDirectory = join(projectRoot, "artifacts");
await mkdir(artifactsDirectory, { recursive: true });
const profile = await mkdtemp(
  join(artifactsDirectory, ".repo-tree-check-profile-"),
);

const workspace = {
  id: "w1",
  slug: "deadalus",
  name: "deadalus",
  path: "/tmp/deadalus",
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
  archivedAt: null,
  available: true,
  position: 1,
};
const agent = (id: string, name: string, position: number) => ({
  id,
  workspaceId: "w1",
  taskId: null,
  name,
  provider: "claude" as const,
  kind: "agent" as const,
  tmuxSession: id,
  command: "claude",
  args: [] as string[],
  workingDirectory: "/tmp/deadalus",
  status: "running" as const,
  exitCode: null,
  startedAt: "2026-09-18T00:00:00.000Z",
  endedAt: null,
  providerSessionId: null,
  archivedAt: null,
  model: null,
  position,
});
const snapshot = {
  workspaces: [workspace],
  tasks: [],
  agents: [
    agent("s-14", "re-work repos", 1),
    agent("s-12", "reorder cards", 2),
  ],
  terminals: [],
  sessionTelemetry: [],
  providerRateLimits: [],
  providerUsage: [],
  agentActivity: [],
  sessionAttention: [],
  toasts: [],
  presence: {
    appForeground: true,
    workspaceId: null,
    sessionId: null,
    idleSeconds: 0,
    focusMode: false,
  },
  repositories: [],
  providerModels: [],
  // The board reads these too, now that the tree is drawn on it.
  worktrees: [],
  sessionActivity: [],
  attention: [],
  settings: {
    home: "/tmp/daedalus",
    repositoryRoot: "/tmp/daedalus/repos",
    tmuxAvailable: true,
    tmuxVersion: "tmux 3.7c",
    workspaceInstructionFilesEnabled: true,
    theme: "dark",
    providers: [],
  },
} as unknown as DesktopSnapshotDto;

const arriving = (
  id: string,
  name: string,
  status: "preparing" | "failed",
  statusError: string | null,
) => ({
  id,
  workspaceId: "w1",
  name,
  canonicalPath: `/tmp/daedalus/repos/${id}.git`,
  access: "write" as const,
  libraryRepositoryId: null,
  referencePath: null,
  baseBranch: null,
  baseCommit: null,
  fetchedAt: null,
  createdAt: "2026-09-18T00:00:00.000Z",
  status,
  statusError,
});

const repository = (id: string, name: string, behind: number) => ({
  id,
  workspaceId: "w1",
  name,
  canonicalPath: `/tmp/daedalus/repos/${id}.git`,
  access: "write" as const,
  libraryRepositoryId: id,
  referencePath: `/tmp/deadalus/repos/${name}`,
  baseBranch: "main",
  baseCommit: "a".repeat(40),
  fetchedAt: "2026-09-18T00:00:00.000Z",
  createdAt: "2026-09-18T00:00:00.000Z",
  gitStatus: {
    state: behind ? ("behind" as const) : ("clean" as const),
    changedFiles: 0,
    ahead: 0,
    behind,
  },
});

// Deliberately long branch names: the row has to truncate them rather than
// grow, which is exactly what the grid min-content bug got wrong.
const populated: WorkspaceContentDto = {
  workspaceId: "w1",
  brief: "# Brief",
  journal: "# Journal",
  files: [{ name: "BRIEF.md", path: "BRIEF.md", kind: "file" }],
  repositories: [
    repository("r1", "daedalus", 0),
    repository("r2", "hive", 3),
    arriving("r3", "zenity-app", "preparing", null),
    // A long reason, because the row has to contain it rather than grow.
    arriving(
      "r4",
      "archived-thing",
      "failed",
      "Could not clone repository: repository not found or access denied",
    ),
  ],
  worktrees: [
    {
      sessionId: "s-14",
      repositoryId: "r1",
      path: "/tmp/deadalus/worktrees/a/daedalus",
      branchName: "daedalus/deadalus/739c1588-641d-4d/328a9c7f-df1c-4943",
      createdAt: "2026-09-18T00:00:00.000Z",
      gitStatus: { state: "modified", changedFiles: 4, ahead: 2, behind: 0 },
    },
    {
      sessionId: "s-12",
      repositoryId: "r1",
      path: "/tmp/deadalus/worktrees/b/daedalus",
      branchName: "daedalus/deadalus/641d4d11-aaaa-bb/739c1588-0000-1111",
      createdAt: "2026-09-18T00:00:00.000Z",
      gitStatus: { state: "ahead", changedFiles: 0, ahead: 1, behind: 0 },
    },
  ],
};

const client = { request: {} } as unknown as DesktopClient;
const css = await Bun.file(
  join(projectRoot, "apps/desktop/src/renderer/styles.css"),
).text();
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
body{margin:0;background:#060916}
.frame{height:760px;width:1280px;overflow:hidden}
.frame > .app{height:760px}
</style></head><body><div class="frame">${renderToStaticMarkup(
  <WorkspaceApp
    injectedClient={client}
    initialSnapshot={snapshot}
    initialWorkspaceView="board"
    initialWorkspaceContent={populated}
  />,
)}</div></body></html>`;

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
});
const pageUrl = `http://127.0.0.1:${port}/`;

let chrome: Bun.Subprocess | undefined;
const failures: string[] = [];
try {
  chrome = Bun.spawn(
    [
      chromePath,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${profile}`,
      "--window-size=1300,860",
      pageUrl,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  let websocketUrl: string | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const pages = (await (
        await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)
      ).json()) as Array<{ url: string; webSocketDebuggerUrl: string }>;
      websocketUrl = pages.find((page) =>
        page.url.startsWith(pageUrl),
      )?.webSocketDebuggerUrl;
      if (websocketUrl) break;
    } catch {
      // Chrome is still starting.
    }
    await Bun.sleep(50);
  }
  if (!websocketUrl) throw new Error("Chrome DevTools endpoint did not start");

  const socket = new WebSocket(websocketUrl);
  await new Promise<void>((settle, fail) => {
    socket.addEventListener("open", () => settle(), { once: true });
    socket.addEventListener(
      "error",
      () => fail(new Error("CDP socket failed")),
      {
        once: true,
      },
    );
  });
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const send = (method: string, params: Record<string, unknown> = {}) => {
    sequence += 1;
    const id = sequence;
    return new Promise<Record<string, never>>(
      (resolvePending, rejectPending) => {
        pending.set(id, {
          resolve: resolvePending as (value: unknown) => void,
          reject: rejectPending,
        });
        socket.send(JSON.stringify({ id, method, params }));
      },
    );
  };

  const evaluate = async <T,>(expression: string): Promise<T> => {
    const result = (await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as unknown as { result: { value: T } };
    return result.result.value;
  };

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (
      await evaluate<boolean>(
        "!!document.querySelector('.workspace-worktree-row')",
      )
    )
      break;
    await Bun.sleep(50);
  }

  const measurements = await evaluate<{
    section: { left: number; right: number } | null;
    rows: Array<{ label: string; left: number; right: number }>;
    buttons: Array<{
      label: string;
      width: number;
      height: number;
      icon: number;
      iconOverflow: number;
    }>;
  }>(`(() => {
    const sectionElement = document.querySelector('.repositories-section');
    const box = sectionElement && sectionElement.getBoundingClientRect();
    const rows = [...document.querySelectorAll('.workspace-resource-row, .workspace-worktree-row:not(.empty)')].map((row) => {
      const rect = row.getBoundingClientRect();
      return { label: (row.textContent || '').trim().slice(0, 40), left: rect.left, right: rect.right };
    });
    const buttons = [...document.querySelectorAll('.workspace-resource-actions button, .workspace-worktree-row button')].map((button) => {
      const rect = button.getBoundingClientRect();
      const svg = button.querySelector('svg');
      const svgRect = svg && svg.getBoundingClientRect();
      return {
        label: button.getAttribute('aria-label') || '',
        width: rect.width,
        height: rect.height,
        icon: svgRect ? Math.min(svgRect.width, svgRect.height) : 0,
        iconOverflow: svgRect
          ? Math.max(svgRect.width - rect.width, svgRect.height - rect.height)
          : 0,
      };
    });
    return { section: box ? { left: box.left, right: box.right } : null, rows, buttons };
  })()`);

  if (!measurements.section)
    failures.push("The board's repositories section did not render");
  else {
    const { left, right } = measurements.section;
    for (const row of measurements.rows)
      if (row.right > right + 0.5 || row.left < left - 0.5)
        failures.push(
          `Row "${row.label}" spans ${row.left.toFixed(0)}–${row.right.toFixed(0)}, outside the repositories section's ${left.toFixed(0)}–${right.toFixed(0)}; its actions are unreachable`,
        );
  }
  const expectedRows =
    populated.repositories.length + populated.worktrees.length;
  if (measurements.rows.length !== expectedRows)
    failures.push(
      `Expected ${expectedRows} repository and working-tree rows, found ${measurements.rows.length}`,
    );

  // Terminal, fetch and pull on each repository, plus a dismiss on one that
  // failed; terminal, push and remove on each working tree.
  const expectedActions =
    populated.repositories.length * 3 +
    populated.repositories.filter((item) => item.status === "failed").length +
    populated.worktrees.length * 3;
  if (measurements.buttons.length !== expectedActions)
    failures.push(
      `Expected ${expectedActions} row actions, found ${measurements.buttons.length}`,
    );
  for (const button of measurements.buttons) {
    if (button.width < 16 || button.height < 16)
      failures.push(
        `Action "${button.label}" is ${button.width.toFixed(0)}×${button.height.toFixed(0)}, too small to press`,
      );
    if (button.icon < 8)
      failures.push(`Action "${button.label}" renders no visible icon`);
    // Belt and braces: the icon must sit inside its button rather than spill
    // over the row. (Dropping the `svg` sizing rule alone does not do this —
    // measured, the icon simply fills the button's content box at 16px — so
    // this guards a button that loses its own box, not that rule.)
    if (button.iconOverflow > 0.5)
      failures.push(
        `Action "${button.label}" has an icon ${button.iconOverflow.toFixed(0)}px larger than the button`,
      );
  }
} finally {
  chrome?.kill();
  server.stop(true);
  await rm(profile, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
console.log(
  "Repository tree check passed: every row fits the board's repositories section and every action is pressable.",
);
