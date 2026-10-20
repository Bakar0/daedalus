import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CommandTmuxClient,
  findTmuxExecutable,
  TmuxPtyBridge,
} from "@daedalus/platform";
import { RUNNER_PATHS } from "@daedalus/remote-protocol";
import { createHandlers } from "./handlers";
import { deadPanes, SessionDaemon } from "./sessiond";

// The entry point of the session container (uid 1001). It reads no token and
// no runner state: neither is mounted here.
const VERSION = "0.1.0";
const TMUX_SOCKET = "daedalus";

const home = join(RUNNER_PATHS.workspace, ".home");
mkdirSync(home, { recursive: true });
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
