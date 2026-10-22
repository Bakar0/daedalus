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
/** The runner gives the tool 10 seconds; the relay adds its own time. */
const AUTH_CALLBACK_TIMEOUT_MS = 20_000;
const MAX_SESSIONS = 10_000;
const MAX_CAPTURE = 1024 * 1024;

/**
 * A reply that is not the shape its method promises. The runner is not
 * trusted, so a reply is checked before it is used, and a bad one reads as
 * the host being unavailable.
 */
const malformed = (method: string) =>
  new DaedalusError(
    "DEPENDENCY",
    `The workspace's runner sent a malformed reply to ${method}`,
  );

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

  /**
   * Sends a sign-in page's redirect to a tool's listener in the pod. The
   * reply is the pod's, so only a status and a string location are kept.
   */
  async authCallback(params: {
    port: number;
    path: string;
    query: string;
  }): Promise<{ status: number; location?: string }> {
    const reply: unknown = await this.transport.request(
      this.workspaceId,
      "auth.callback",
      params,
      AUTH_CALLBACK_TIMEOUT_MS,
    );
    const status = (reply as { status?: unknown } | null)?.status;
    const location = (reply as { location?: unknown } | null)?.location;
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      (location !== undefined && typeof location !== "string")
    )
      throw malformed("auth.callback");
    return {
      status,
      ...(typeof location === "string" ? { location } : {}),
    };
  }

  /** A text file in the pod, or undefined when it is not there. */
  async readText(path: string): Promise<string | undefined> {
    const file: unknown = await this.transport.request(
      this.workspaceId,
      "fs.read",
      { path },
      LIST_TIMEOUT_MS,
    );
    if (file === null) return undefined;
    if (
      typeof file !== "object" ||
      typeof (file as { base64?: unknown }).base64 !== "string"
    )
      throw malformed("fs.read");
    return Buffer.from((file as { base64: string }).base64, "base64").toString(
      "utf8",
    );
  }

  /** Writes text files in the pod, each replaced whole. */
  async writeText(files: { path: string; text: string }[]): Promise<void> {
    if (!files.length) return;
    await this.transport.request(
      this.workspaceId,
      "fs.write",
      {
        files: files.map((file) => ({
          path: file.path,
          base64: Buffer.from(file.text).toString("base64"),
        })),
      },
      LIST_TIMEOUT_MS,
    );
  }

  async isLive(session: string): Promise<boolean> {
    const live: unknown = await this.transport.request(
      this.workspaceId,
      "host.isLive",
      { session },
    );
    if (typeof live !== "boolean") throw malformed("host.isLive");
    return live;
  }

  async listLive(): Promise<string[]> {
    const names: unknown = await this.transport.request(
      this.workspaceId,
      "host.listLive",
      null,
      LIST_TIMEOUT_MS,
    );
    if (
      !Array.isArray(names) ||
      names.length > MAX_SESSIONS ||
      !names.every((name) => typeof name === "string")
    )
      throw malformed("host.listLive");
    return names as string[];
  }

  async capture(
    session: string,
    options?: { styled?: boolean },
  ): Promise<string> {
    const screen: unknown = await this.transport.request(
      this.workspaceId,
      "host.capture",
      { session, ...(options?.styled ? { styled: true } : {}) },
    );
    if (typeof screen !== "string") throw malformed("host.capture");
    // A screen is a few kilobytes; the rest of a long one is scrollback.
    return screen.length > MAX_CAPTURE ? screen.slice(-MAX_CAPTURE) : screen;
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
