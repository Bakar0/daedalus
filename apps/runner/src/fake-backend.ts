import { RunnerError } from "./errors";
import { FakeTmux } from "./fake-tmux";
import { createHandlers } from "./handlers";
import type { SessionBackend, Terminal } from "./runner";
import type { SessiondMethod } from "./sessiond-protocol";

/** A session backend in memory: the real handlers over a fake tmux. */
export class FakeBackend implements SessionBackend {
  readonly tmux = new FakeTmux();
  dead: Record<string, number | null> = {};
  terminals: { session: string; writes: string[]; close: () => void }[] = [];
  readonly handlers;

  constructor(root: string) {
    this.handlers = createHandlers({
      root,
      tmux: this.tmux,
      version: "t",
      baseEnv: { PATH: "/usr/bin" },
    });
  }

  async call(method: SessiondMethod, params: unknown): Promise<never> {
    if (method === "deadPanes") return { ...this.dead } as never;
    const handler = this.handlers[method] as (p: unknown) => Promise<unknown>;
    return (await handler(params)) as never;
  }

  async openTerminal(session: string): Promise<Terminal> {
    if (!(await this.tmux.hasSession(session)))
      throw new RunnerError("LOST", "No such session");
    const record = { session, writes: [] as string[], close: () => {} };
    this.terminals.push(record);
    return {
      start: () => new Promise(() => {}),
      write: (data) => record.writes.push(data),
      resize: () => {},
      close: () => record.close(),
    };
  }
}
