import type { TmuxClient } from "@daedalus/platform";
import { DaedalusError } from "../errors";
import type { LocalSessionHost, SessionHost } from "./session-host";

/**
 * Every host a session can run on: this Mac, and the cloud hosts registered
 * while the app runs. A session names its host by id; null is this Mac.
 */
export class SessionHosts {
  readonly #cloud = new Map<string, SessionHost>();
  #resolve: ((hostId: string) => SessionHost | undefined) | undefined;

  constructor(
    readonly local: LocalSessionHost,
    /**
     * This Mac's tmux, for what only makes sense here: an interactive
     * `tmux attach` in the user's own terminal, and the version it reports.
     */
    readonly localTmux: TmuxClient,
  ) {}

  register(host: SessionHost): void {
    if (host.kind === "local")
      throw new DaedalusError("INTERNAL", "Only cloud hosts are registered");
    this.#cloud.set(host.id, host);
  }

  unregister(hostId: string): void {
    this.#cloud.delete(hostId);
  }

  /** The cloud hosts known now, without this Mac. */
  cloud(): SessionHost[] {
    return [...this.#cloud.values()];
  }

  /**
   * Makes the cloud host for an id this process has not met yet, such as the
   * first time a command touches a cloud session. What it makes is kept.
   */
  resolveWith(resolve: (hostId: string) => SessionHost | undefined): void {
    this.#resolve = resolve;
  }

  find(hostId: string | null | undefined): SessionHost | undefined {
    if (!hostId) return this.local;
    const known = this.#cloud.get(hostId);
    if (known) return known;
    const made = this.#resolve?.(hostId);
    if (made) this.register(made);
    return made;
  }

  get(hostId: string | null | undefined): SessionHost {
    const host = this.find(hostId);
    if (!host)
      throw new DaedalusError(
        "DEPENDENCY",
        `Cloud host '${hostId}' is not connected`,
      );
    return host;
  }
}
