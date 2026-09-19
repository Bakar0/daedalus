import type {
  ShutdownPlan,
  ShutdownOptions,
  ShutdownResult,
} from "@daedalus/core";
import type { QuitChoice, ShutdownPlanDto } from "@daedalus/protocol";

/**
 * How long the host waits for the window to say the quit dialog is up.
 *
 * A renderer that cannot draw it must not turn Cmd+Q into a key that does
 * nothing, so the wait is short and what it falls through to is the same
 * thing every other path does: quit, leave everything running.
 */
export const QUIT_DIALOG_ACK_TIMEOUT_MS = 2_000;

export interface QuitControllerOptions {
  plan(): Promise<ShutdownPlan>;
  runShutdown(options: ShutdownOptions): Promise<ShutdownResult>;
  /** Sends the plan to the window, which draws the dialog. */
  askWindow(plan: ShutdownPlanDto): void;
  /** Ends the process. Everything here converges on exactly this call. */
  quit(): void;
  log?(event: string, fields: Record<string, unknown>): void;
  ackTimeoutMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const planDto = (plan: ShutdownPlan): ShutdownPlanDto => ({
  sessions: plan.sessions.map((session) => ({
    id: session.id,
    name: session.name,
    workspaceId: session.workspaceId,
    provider: session.provider,
    disposition: session.disposition,
  })),
  terminals: plan.terminals.map((terminal) => ({
    id: terminal.id,
    name: terminal.name,
  })),
});

/**
 * Owns what happens between "quit was requested" and the process ending.
 *
 * It is a class in its own file rather than a few lines in the host because
 * the interesting behaviour is a state machine with two ways in, three ways
 * out and a watchdog, and none of that is testable through Electrobun.
 *
 * The policy it implements: sessions always survive quitting, and the dialog
 * only confirms. The app does not own the tmux server — `daedal agent spawn`
 * works with the window never opened — so a GUI quit that killed it would
 * kill sessions started from a terminal, and reopening reconnects to what is
 * still there, which is what makes the app come back as it was left.
 *
 * Ending sessions is therefore never what "quit" defaults to. It is its own
 * button, its own menu item and its own CLI command, each named for what it
 * does, and the one that stops things is never the focused one.
 */
export class QuitController {
  #state: "idle" | "deciding" | "quitting" = "idle";
  #acknowledged = false;
  #ackTimer: unknown;

  constructor(private readonly options: QuitControllerOptions) {}

  get state(): "idle" | "deciding" | "quitting" {
    return this.#state;
  }

  /** Cmd+Q, or the Quit menu item. */
  async requestQuit(): Promise<void> {
    if (this.#state !== "idle") return;
    const plan = await this.options.plan().catch((error: unknown) => {
      this.#log("quit_plan_failed", { message: describe(error) });
      return undefined;
    });
    // Nothing live, or nothing we could find out about: quit as before. Asking
    // about an empty list would be a dialog that only ever costs a keystroke.
    if (!plan || (!plan.sessions.length && !plan.terminals.length))
      return this.#quit("nothing-live");
    this.#state = "deciding";
    this.#acknowledged = false;
    this.options.askWindow(planDto(plan));
    const setTimer =
      this.options.setTimer ??
      ((callback: () => void, ms: number) => setTimeout(callback, ms));
    this.#ackTimer = setTimer(() => {
      if (this.#state !== "deciding" || this.#acknowledged) return;
      this.#log("quit_dialog_unacknowledged", {});
      void this.#quit("dialog-unacknowledged");
    }, this.options.ackTimeoutMs ?? QUIT_DIALOG_ACK_TIMEOUT_MS);
  }

  /**
   * Stops everything on the way out.
   *
   * `resumeOnNextStart` is the difference between the dialog's "Quit and stop
   * sessions" and the Shut Down menu item next to it. Both end every session
   * and the tmux server; only the first promises to bring them back, which is
   * what makes it a way to close the app rather than a way to lose an
   * afternoon. The menu item and `daedal shutdown` are the off switch.
   */
  async requestShutdownAndQuit(
    options: { resumeOnNextStart?: boolean; reason?: string } = {},
  ): Promise<void> {
    if (this.#state === "quitting") return;
    this.#cancelAckTimer();
    this.#state = "quitting";
    const result = await this.options
      .runShutdown({
        stopServer: true,
        ...(options.resumeOnNextStart ? { resumeOnNextStart: true } : {}),
      })
      .catch((error: unknown) => {
        this.#log("quit_shutdown_failed", { message: describe(error) });
        return undefined;
      });
    if (result) this.#logResult(result);
    this.#finish(options.reason ?? "menu-shutdown");
  }

  /** The window has the dialog on screen; stop counting. */
  dialogShown(): void {
    this.#acknowledged = true;
    this.#cancelAckTimer();
  }

  async decide(choice: QuitChoice): Promise<void> {
    if (this.#state !== "deciding") return;
    this.#acknowledged = true;
    this.#cancelAckTimer();
    if (choice === "cancel") {
      this.#state = "idle";
      this.#log("quit_cancelled", {});
      return;
    }
    if (choice === "shutdown")
      return this.requestShutdownAndQuit({
        resumeOnNextStart: true,
        reason: "dialog-shutdown",
      });
    await this.#quit("dialog-keep");
  }

  async #quit(reason: string): Promise<void> {
    if (this.#state === "quitting") return;
    this.#state = "quitting";
    this.#cancelAckTimer();
    this.#finish(reason);
  }

  #finish(reason: string): void {
    this.#log("quit", { reason });
    this.options.quit();
  }

  #logResult(result: ShutdownResult): void {
    this.#log("quit_shutdown_swept", {
      archived: result.sessions.filter((item) => item.outcome === "archived")
        .length,
      stopped: result.sessions.filter((item) => item.outcome === "stopped")
        .length,
      failed: result.sessions.filter((item) => item.outcome === "failed")
        .length,
      terminalsClosed: result.terminals.filter((item) => item.closed).length,
      serverStopped: result.serverStopped,
      ...(result.serverError ? { serverError: result.serverError } : {}),
    });
  }

  #cancelAckTimer(): void {
    if (this.#ackTimer === undefined) return;
    const clearTimer =
      this.options.clearTimer ??
      ((handle: unknown) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>));
    clearTimer(this.#ackTimer);
    this.#ackTimer = undefined;
  }

  #log(event: string, fields: Record<string, unknown>): void {
    this.options.log?.(event, fields);
  }
}

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
