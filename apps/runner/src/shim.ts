#!/usr/bin/env bun
// The `daedal` command inside a workspace pod. It turns its arguments into a
// call to the runner, which forwards it to the Mac.
import type { CommandResult } from "@daedalus/remote-protocol";
import { RUNNER_PATHS } from "@daedalus/remote-protocol";
import { toWorkspacePath } from "./paths";
import {
  FORWARDED_VARIABLES,
  isQueueable,
  socketPath,
  type ShimRequest,
} from "./shim-protocol";

const OFFLINE = 75;

const fail = (message: string, code = OFFLINE): never => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

const argv = process.argv.slice(2);
const request: ShimRequest = {
  argv,
  cwd: toWorkspacePath(RUNNER_PATHS.workspace, process.cwd()),
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        (FORWARDED_VARIABLES as readonly string[]).includes(entry[0]) &&
        entry[1] !== undefined,
    ),
  ),
  queueable: isQueueable(argv),
};
if (!process.stdin.isTTY) request.stdin = await Bun.stdin.text();

let buffer = "";
const reply = Promise.withResolvers<CommandResult>();
try {
  await Bun.connect({
    unix: socketPath(),
    socket: {
      open(socket) {
        socket.write(`${JSON.stringify(request)}\n`);
      },
      data(_socket, chunk) {
        buffer += chunk.toString();
        if (!buffer.includes("\n")) return;
        try {
          reply.resolve(JSON.parse(buffer) as CommandResult);
        } catch {
          reply.reject(new Error("The runner sent an unreadable reply"));
        }
      },
      close() {
        reply.reject(new Error("The runner closed the connection"));
      },
      error(_socket, error) {
        reply.reject(error);
      },
    },
  });
} catch (error) {
  fail(`The workspace runner is not reachable: ${(error as Error).message}`);
}

const result = await reply.promise.catch((error: Error) => fail(error.message));
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.exitCode);
