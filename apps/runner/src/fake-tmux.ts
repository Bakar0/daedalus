import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";

export class FakeTmux implements TmuxClient {
  openPty() {
    return {
      start: async () => {},
      write() {},
      resize() {},
      close() {},
    };
  }
  async pinWindowSize() {}
  async unpinWindowSize() {}
  sessions = new Set<string>();
  launches: TmuxLaunch[] = [];
  keys: [string, string[]][] = [];
  sent: [string, string][] = [];
  async probe() {
    return "tmux 3.5";
  }
  async createSession(launch: TmuxLaunch) {
    this.launches.push(launch);
    this.sessions.add(launch.session);
  }
  async hasSession(session: string) {
    return this.sessions.has(session);
  }
  async listSessions() {
    return [...this.sessions];
  }
  async attach() {
    return 0;
  }
  async capture(session: string) {
    return `screen of ${session}`;
  }
  async sendKeys(session: string, keys: string[]) {
    this.keys.push([session, keys]);
  }
  async send(session: string, text: string) {
    this.sent.push([session, text]);
  }
  async stop(session: string) {
    this.sessions.delete(session);
  }
  async killServer() {
    return true;
  }
}
