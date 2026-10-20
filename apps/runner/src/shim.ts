#!/usr/bin/env bun
// The `daedal` command inside a workspace pod. It turns its arguments into a
// call to the runner, which forwards it to the Mac.
import {
  RUNNER_PATHS,
  SocketWriter,
  type CommandResult,
} from "@daedalus/remote-protocol";
import { toWorkspacePath } from "./paths";
import {
  FORWARDED_VARIABLES,
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
};
if (!process.stdin.isTTY) request.stdin = await Bun.stdin.text();

// Bytes, decoded once whole: a chunk can end inside a UTF-8 character.
const chunks: Buffer[] = [];
let writer: SocketWriter | undefined;
const reply = Promise.withResolvers<CommandResult>();
try {
  await Bun.connect({
    unix: socketPath(),
    socket: {
      open(socket) {
        writer = new SocketWriter(socket);
        writer.write(`${JSON.stringify(request)}\n`);
      },
      drain() {
        writer?.flush();
      },
      data(_socket, chunk) {
        chunks.push(Buffer.from(chunk));
        if (!chunk.includes(10)) return;
        try {
          reply.resolve(
            JSON.parse(Buffer.concat(chunks).toString("utf8")) as CommandResult,
          );
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
// Written in full before exiting: `process.exit` drops what a slow pipe has
// not taken yet.
await Bun.write(Bun.stdout, result.stdout);
await Bun.write(Bun.stderr, result.stderr);
process.exit(result.exitCode);
