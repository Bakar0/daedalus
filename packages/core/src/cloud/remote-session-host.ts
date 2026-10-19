import { DaedalusError } from "../errors";
import { cloudHostId } from "../services/cloud-launch";
import type {
  SessionCheckpoint,
  SessionHost,
  SessionHostLaunch,
  SessionTerminal,
  TerminalSize,
} from "../services/session-host";
import type { RunnerTransport } from "./link";

/** A start waits for the provider's first screen, so it gets longer. */
const START_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 5_000;

/**
 * A cloud workspace's pod, reached through its runner. Each call is one of
 * `RunnerMethods`; paths are relative to the workspace root in the pod.
 */
export class RemoteSessionHost implements SessionHost {
  readonly kind = "cloud" as const;
  readonly id: string;

  constructor(
    readonly workspaceId: string,
    private readonly transport: RunnerTransport,
  ) {
    this.id = cloudHostId(workspaceId);
  }

  async probe(): Promise<string | undefined> {
    const unavailable = await this.transport.unavailable(this.workspaceId);
    if (unavailable) return unavailable;
    try {
      await this.transport.request(
        this.workspaceId,
        "host.probe",
        null,
        LIST_TIMEOUT_MS,
      );
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async start({ secrets, ...launch }: SessionHostLaunch): Promise<void> {
    await this.transport.request(
      this.workspaceId,
      "host.start",
      {
        session: launch.session,
        cwd: launch.cwd,
        executable: launch.executable,
        args: launch.args,
        ...(launch.env ? { env: launch.env } : {}),
        ...(secrets && Object.keys(secrets).length ? { secrets } : {}),
        ...(launch.keepOnExit ? { keepOnExit: true } : {}),
      },
      START_TIMEOUT_MS,
    );
  }

  isLive(session: string): Promise<boolean> {
    return this.transport.request(this.workspaceId, "host.isLive", {
      session,
    });
  }

  listLive(): Promise<string[]> {
    return this.transport.request(
      this.workspaceId,
      "host.listLive",
      null,
      LIST_TIMEOUT_MS,
    );
  }

  capture(session: string, options?: { styled?: boolean }): Promise<string> {
    return this.transport.request(this.workspaceId, "host.capture", {
      session,
      ...(options?.styled ? { styled: true } : {}),
    });
  }

  async sendKeys(session: string, keys: string[]): Promise<void> {
    await this.transport.request(this.workspaceId, "host.sendKeys", {
      session,
      keys,
    });
  }

  async send(session: string, text: string): Promise<void> {
    await this.transport.request(this.workspaceId, "host.send", {
      session,
      text,
    });
  }

  async stop(session: string, force?: boolean): Promise<void> {
    await this.transport.request(this.workspaceId, "host.stop", {
      session,
      ...(force ? { force: true } : {}),
    });
  }

  async openTerminal(
    session: string,
    size: TerminalSize,
    onOutput: (output: Uint8Array) => void,
  ): Promise<SessionTerminal> {
    const open = this.transport.openTerminal?.bind(this.transport);
    if (!open)
      throw new DaedalusError(
        "DEPENDENCY",
        "Cloud terminals open in the Daedalus app",
      );
    const unavailable = await this.transport.unavailable(this.workspaceId);
    if (unavailable) throw new DaedalusError("DEPENDENCY", unavailable);
    const closed = Promise.withResolvers<void>();
    const encoder = new TextEncoder();
    let channel: ReturnType<typeof open> | undefined;
    return {
      start: async () => {
        channel = open(this.workspaceId, session, size, {
          output: onOutput,
          server: (message) => {
            // The connection already said it is live; only a failure is
            // worth showing, in the terminal itself.
            if (message.type === "error")
              onOutput(encoder.encode(`\r\n${message.message}\r\n`));
          },
          closed: () => closed.resolve(),
        });
        await closed.promise;
      },
      write: (data) => channel?.input(data),
      resize: (cols, rows) => channel?.resize(cols, rows),
      close: () => {
        channel?.close();
        closed.resolve();
      },
    };
  }

  async exportCheckpoint(): Promise<SessionCheckpoint> {
    throw new DaedalusError("INTERNAL", "Checkpoints are not built yet");
  }

  async importCheckpoint(): Promise<{ workingDirectory: string }> {
    throw new DaedalusError("INTERNAL", "Checkpoints are not built yet");
  }
}
