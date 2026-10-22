import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CommandTmuxClient,
  findTmuxExecutable,
  TmuxPtyBridge,
} from "@daedalus/platform";
import { RUNNER_PATHS } from "@daedalus/remote-protocol";
import { createHandlers } from "./handlers";
import { deadPanes, privateRuntimeFolder, SessionDaemon } from "./sessiond";

// The entry point of the session container (uid 1001). It reads no token and
// no runner state: neither is mounted here.
const VERSION = "0.1.0";
const TMUX_SOCKET = "daedalus";

const home = join(RUNNER_PATHS.workspace, ".home");
mkdirSync(home, { recursive: true });
const runtime = privateRuntimeFolder(join(RUNNER_PATHS.runtime, "session"));
if (!runtime)
  console.log(
    "[sessiond] no private runtime folder; Claude messaging stays off",
  );
const tmuxPath = findTmuxExecutable() ?? "tmux";
const tmux = new CommandTmuxClient(
  TMUX_SOCKET,
  tmuxPath,
  undefined,
  RUNNER_PATHS.workspace,
);

const daemon = new SessionDaemon({
  handlers: createHandlers({
    root: RUNNER_PATHS.workspace,
    tmux,
    version: VERSION,
    baseEnv: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
      ...(runtime ? { XDG_RUNTIME_DIR: runtime } : {}),
    },
  }),
  deadPanes: () => deadPanes(tmuxPath, TMUX_SOCKET),
  hasSession: (session) => tmux.hasSession(session),
  openTerminal: (session, size, onOutput) =>
    new TmuxPtyBridge(
      onOutput,
      { socketName: TMUX_SOCKET, session },
      size,
      tmuxPath,
    ),
});
daemon.listen(RUNNER_PATHS.sessionSocket);
console.log(`[sessiond] ${VERSION} listening on ${RUNNER_PATHS.sessionSocket}`);

// Both daemons are PID 1 in their container, and the kernel drops signals for
// PID 1 unless it has a handler, so without these a sleep waits out the grace
// period and then kills the pod.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[sessiond] ${signal} received, exiting`);
    process.exit(0);
  });
}
