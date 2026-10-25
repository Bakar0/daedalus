/**
 * The admin page's script. The gateway serves
 * `(adminClient)((filterTools)())` as /admin/admin.js, so each function
 * holds everything it needs: it may use only browser globals and what it is
 * passed, never an import or a module-level value.
 *
 * Every value from the gateway goes into the page as text (textContent and
 * attributes), never as HTML. Workspace names and emails come from users.
 */

/** The filter's matching, as `filterTools()` returns it. */
export interface FilterTools {
  distance(a: string, b: string): number;
  find(text: string, term: string): [number, number] | null;
  matches(fields: string[], terms: string[]): boolean;
}

/**
 * The admin page's fuzzy matching. Self-contained like `adminClient`: the
 * gateway serves `(adminClient)((filterTools)())`, and the tests call it.
 */
export function filterTools(): FilterTools {
  /** Optimal string alignment distance: edits, with swaps of neighbours. */
  function distance(a: string, b: string): number {
    const rows: number[][] = [];
    for (let i = 0; i <= a.length; i++) {
      rows.push([i]);
      for (let j = 1; j <= b.length; j++) {
        if (i === 0) {
          rows[0]!.push(j);
          continue;
        }
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let best = Math.min(
          rows[i - 1]![j]! + 1,
          rows[i]![j - 1]! + 1,
          rows[i - 1]![j - 1]! + cost,
        );
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
          best = Math.min(best, rows[i - 2]![j - 2]! + 1);
        rows[i]!.push(best);
      }
    }
    return rows[a.length]![b.length]!;
  }

  /**
   * Where `term` is in `text`: as a substring, else a word (or the start of
   * one) within one typo for terms of 4 or more letters, two from 8.
   */
  function find(text: string, term: string): [number, number] | null {
    const lower = text.toLowerCase();
    const at = lower.indexOf(term);
    if (at >= 0) return [at, at + term.length];
    const typos = term.length >= 8 ? 2 : term.length >= 4 ? 1 : 0;
    if (!typos) return null;
    const words = /[a-z0-9]+/g;
    for (let match = words.exec(lower); match; match = words.exec(lower)) {
      const word = match[0];
      // The whole word first, then its starts, nearest the term's length.
      const lengths = [word.length];
      for (let step = 0; step <= typos; step++)
        for (const length of [term.length + step, term.length - step])
          if (length >= term.length && length < word.length)
            lengths.push(length);
      for (const length of lengths)
        if (distance(word.slice(0, length), term) <= typos)
          return [match.index, match.index + length];
    }
    return null;
  }

  /** Whether every term is somewhere in the fields. */
  function matches(fields: string[], list: string[]): boolean {
    return list.every((term) =>
      fields.some((text) => find(text, term) !== null),
    );
  }

  return { distance, find, matches };
}

export function adminClient(tools: FilterTools): void {
  interface Session {
    subject: string;
    role: "viewer" | "admin";
    csrf: string;
  }
  interface Workspace {
    workspaceId: string;
    name: string;
    status: string;
    reason: string | null;
    runnerOnline: boolean;
    createdAt: string;
    lastActiveAt: string | null;
    sleptAt: string | null;
    collectAt: string | null;
    daysUntilCollection: number | null;
    disk: { name: string; size: string }[];
    diskBytes: number;
    live: { cpu: number; memory: number } | null;
    resources: {
      cpu: { request: string; limit: string };
      memory: { request: string; limit: string };
    } | null;
  }
  interface User {
    id: string;
    email: string;
    createdAt: string;
    limit: number;
    limitOverride: number | null;
    error: string | null;
    workspaces: Workspace[];
  }
  interface Overview {
    generatedAt: string;
    settings: {
      asleepDays: number;
      defaultLimit: number;
      idleMinutes: string;
      collectMinutes: number;
    };
    opencostUrl: string | null;
    summary: {
      users: number;
      workspaces: number;
      byStatus: Record<string, number>;
      diskBytes: number;
      cpuRequested: number;
      memoryRequestedBytes: number;
    };
    users: User[];
    health: Health;
  }
  interface Health {
    ok: boolean;
    problems: {
      severity: "error" | "warning";
      area: string;
      message: string;
    }[];
    nodes:
      | {
          name: string;
          ready: boolean;
          readyMessage: string | null;
          unschedulable: boolean;
          runtime: boolean | null;
          allocatable: { cpu: number; memory: number; ephemeral: number };
          requested: { cpu: number; memory: number; ephemeral: number };
          workspacePods: number;
        }[]
      | null;
    nodesError: string | null;
    runtimeClass: string;
    runtimeHandler: string;
    pods: {
      email: string;
      workspace: string;
      pod: string;
      kind: string;
      detail: string;
    }[];
    volumes: { email: string; volume: string; phase: string }[];
    quotas: {
      email: string;
      storage: { used: number; hard: number } | null;
      volumes: { used: number; hard: number } | null;
      pods: { used: number; hard: number } | null;
    }[];
    metrics: { available: boolean; reason: string | null };
    gateway: {
      startedAt: string;
      uptimeSeconds: number;
      macs: number;
      runners: number;
      collectMinutes: number;
      lastCollection: {
        at: string;
        workspaces: number;
        namespaces: number;
        failures: number;
      } | null;
    };
    recentLog: { at: string; message: string }[];
  }
  interface AuditEntry {
    at: string;
    subject: string;
    session: string;
    address: string;
    action: string;
    target: string;
    result: string;
    detail: string;
  }

  const REFRESH_MS = 15_000;
  const root = document.getElementById("app")!;
  let session: Session | null = null;
  let timer: number | undefined;
  /** Workspace ids whose delete is waiting for the typed confirmation. */
  const confirming = new Set<string>();
  /** The chart's workspaces per user, the most an override may be. */
  let defaultLimit = 0;
  /** True while a form on the page is being typed into. */
  let editing = false;

  type Child = Node | string | null | undefined | false;
  function el(
    tag: string,
    attributes: Record<string, string> = {},
    ...children: Child[]
  ): HTMLElement {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes))
      node.setAttribute(name, value);
    for (const child of children)
      if (child !== null && child !== undefined && child !== false)
        node.append(child);
    return node;
  }

  class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }

  async function api<T>(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      if (session) headers["X-Daedalus-CSRF"] = session.csrf;
    }
    const response = await fetch(`/admin/api/${path}`, {
      method,
      headers,
      credentials: "same-origin",
      ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    const json = (await response.json().catch(() => ({}))) as {
      error?: { message: string };
    };
    if (!response.ok)
      throw new ApiError(
        response.status,
        json.error?.message ?? `Request failed (${response.status})`,
      );
    return json as T;
  }

  const STATUS_LABEL: Record<string, string> = {
    running: "Running",
    sleeping: "Asleep",
    starting: "Starting",
    failed: "Failed",
    unknown: "Unknown",
  };

  /** Words a status filter matches, besides the label. */
  const STATUS_WORDS: Record<string, string> = {
    running: "running awake",
    sleeping: "asleep sleeping",
    starting: "starting",
    failed: "failed error",
    unknown: "unknown",
  };

  type Page = "overview" | "health" | "workspaces" | "audit";
  const PAGES: { id: Page; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "health", label: "Health" },
    { id: "workspaces", label: "Workspaces" },
    { id: "audit", label: "Audit" },
  ];

  /**
   * The page and the filter live in the URL hash, so a view can be shared:
   * `#health`, `#audit`, `#workspaces?q=omer asleep`. The older `#q=...`
   * opens Workspaces with that filter.
   */
  function readRoute(): { page: Page; query: string } {
    const hash = window.location.hash.replace(/^#/, "");
    const [name = "", search = ""] = hash.split("?", 2) as [string?, string?];
    const decode = (text: string) => {
      try {
        return decodeURIComponent(text);
      } catch {
        return "";
      }
    };
    if (name.startsWith("q="))
      return { page: "workspaces", query: decode(name.slice(2)) };
    const page = PAGES.find((item) => item.id === name)?.id ?? "overview";
    const match = /(?:^|&)q=([^&]*)/.exec(search);
    return { page, query: match ? decode(match[1]!) : "" };
  }

  let { page, query } = readRoute();

  /** The hash for a page, carrying the filter on Workspaces. */
  function hashFor(target: Page): string {
    if (target === "workspaces" && query.trim())
      return `#workspaces?q=${encodeURIComponent(query.trim())}`;
    return target === "overview" ? "#" : `#${target}`;
  }

  const terms = () =>
    query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0);

  const { find, matches: matchAll } = tools;
  /** Whether every term is somewhere in the fields. */
  const matches = (fields: string[], list = terms()) => matchAll(fields, list);

  const workspaceFields = (user: User, workspace: Workspace) => [
    user.email,
    user.id,
    workspace.name,
    workspace.workspaceId,
    `${STATUS_LABEL[workspace.status] ?? ""} ${STATUS_WORDS[workspace.status] ?? ""}`,
  ];

  /** The text with every filter match marked. */
  function marked(text: string): Node {
    const list = terms();
    if (!list.length) return document.createTextNode(text);
    const ranges = list
      .map((term) => find(text, term))
      .filter((range): range is [number, number] => range !== null)
      .sort((a, b) => a[0] - b[0]);
    const out = document.createDocumentFragment();
    let at = 0;
    for (const [start, end] of ranges) {
      if (start < at) continue;
      out.append(text.slice(at, start), el("mark", {}, text.slice(start, end)));
      at = end;
    }
    out.append(text.slice(at));
    return out;
  }

  function when(iso: string | null): string {
    if (!iso) return "–";
    const date = new Date(iso);
    return date.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function ago(iso: string | null): string {
    if (!iso) return "never";
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} days ago`;
  }

  function bytes(value: number): string {
    if (value <= 0) return "0";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let unit = 0;
    let amount = value;
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024;
      unit += 1;
    }
    return `${amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
  }

  function cores(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  function message(text: string, kind: "error" | "info" = "error") {
    const bar = document.getElementById("message");
    if (!bar) return;
    bar.textContent = text;
    bar.className = `message ${kind}`;
    bar.hidden = !text;
  }

  function header(overview: Overview | null) {
    const right = el("div", { class: "who" });
    if (overview?.opencostUrl)
      right.append(
        el(
          "a",
          {
            href: overview.opencostUrl,
            target: "_blank",
            rel: "noopener noreferrer",
            "data-testid": "opencost-link",
          },
          "OpenCost",
        ),
      );
    if (session) {
      right.append(
        el(
          "span",
          { class: "role", "data-testid": "admin-role" },
          session.role === "admin"
            ? "Signed in as admin"
            : "Signed in read only",
        ),
      );
      const out = el("button", { type: "button", class: "quiet" }, "Sign out");
      out.addEventListener("click", () => void signOut());
      right.append(out);
    }
    const nav = el("nav", { "aria-label": "Admin pages" });
    if (session && overview)
      for (const item of PAGES) {
        const link = el(
          "a",
          {
            href: hashFor(item.id),
            class: item.id === page ? "current" : "",
            "data-testid": `nav-${item.id}`,
            ...(item.id === page ? { "aria-current": "page" } : {}),
          },
          item.label,
        );
        if (item.id === "health" && !overview.health.ok)
          link.append(
            el(
              "span",
              { class: "count", "data-testid": "nav-health-count" },
              String(overview.health.problems.length),
            ),
          );
        if (item.id === "workspaces")
          link.append(
            el(
              "span",
              { class: "count quiet" },
              String(overview.summary.workspaces),
            ),
          );
        nav.append(link);
      }
    return el(
      "header",
      {},
      el("div", { class: "brand" }, el("h1", {}, "Daedalus cloud admin"), nav),
      right,
    );
  }

  function signInView(error = "") {
    stopTimer();
    shell = null;
    root.replaceChildren();
    const input = el("input", {
      type: "password",
      id: "token",
      name: "token",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "Admin token",
      "aria-label": "Admin token",
      "data-testid": "admin-token",
    }) as HTMLInputElement;
    const button = el(
      "button",
      { type: "submit", "data-testid": "admin-sign-in" },
      "Sign in",
    );
    const form = el(
      "form",
      { class: "sign-in" },
      el("h2", {}, "Sign in"),
      el(
        "p",
        { class: "hint" },
        "Use the token in the Secret named by admin.bootstrap.existingSecret.",
      ),
      input,
      button,
      el("p", { class: "message error", id: "message", hidden: "" }),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void (async () => {
        try {
          session = await api<Session>("POST", "login", {
            token: input.value,
          });
          input.value = "";
          await load();
        } catch (failure) {
          message(failure instanceof Error ? failure.message : String(failure));
        }
      })();
    });
    root.append(header(null), el("main", {}, form));
    if (error) message(error);
    input.focus();
  }

  async function signOut() {
    try {
      await api("POST", "logout");
    } catch {
      // Signed out either way.
    }
    session = null;
    signInView();
  }

  function stopTimer() {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  }

  function schedule() {
    stopTimer();
    timer = window.setTimeout(() => {
      if (editing || confirming.size) schedule();
      else void load();
    }, REFRESH_MS);
  }

  function stat(label: string, value: string, testId: string) {
    return el(
      "div",
      { class: "stat", "data-testid": testId },
      el("div", { class: "value" }, value),
      el("div", { class: "label" }, label),
    );
  }

  function summary(overview: Overview) {
    const { summary: s, settings } = overview;
    const counts = el(
      "div",
      { class: "counts" },
      ...["running", "starting", "sleeping", "failed", "unknown"]
        .filter((status) => status !== "unknown" || s.byStatus.unknown)
        .map((status) =>
          el(
            "span",
            { class: `pill ${status}` },
            `${s.byStatus[status] ?? 0} ${STATUS_LABEL[status]!.toLowerCase()}`,
          ),
        ),
    );
    const { health } = overview;
    const count = health.problems.length;
    const badge = el(
      "a",
      {
        href: "#health",
        class: `health-badge ${health.ok ? "ok" : "bad"}`,
        "data-testid": "health-badge",
      },
      health.ok
        ? "Healthy"
        : `${count} problem${count === 1 ? "" : "s"}: see Health`,
    );
    return el(
      "section",
      { class: "summary", "data-testid": "admin-summary" },
      el("div", { class: "summary-head" }, badge),
      el(
        "div",
        { class: "stats" },
        stat("Users", String(s.users), "summary-users"),
        stat("Workspaces", String(s.workspaces), "summary-workspaces"),
        stat("Disk requested", bytes(s.diskBytes), "summary-disk"),
        stat("CPU requested (awake)", cores(s.cpuRequested), "summary-cpu"),
        stat(
          "Memory requested (awake)",
          bytes(s.memoryRequestedBytes),
          "summary-memory",
        ),
      ),
      counts,
      el(
        "p",
        { class: "hint" },
        settings.asleepDays > 0
          ? `A workspace asleep ${settings.asleepDays} days is deleted; collection runs every ${settings.collectMinutes} min. `
          : "Collection of asleep workspaces is off. ",
        `Idle workspaces sleep after ${settings.idleMinutes} min. Default limit ${settings.defaultLimit} workspaces per user; an override can only lower it, since each user's volume quota is sized for the default.`,
      ),
    );
  }

  async function runAction(label: string, run: () => Promise<unknown>) {
    message("");
    try {
      await run();
      message(label, "info");
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        session = null;
        signInView("Your admin session ended; sign in again.");
        return;
      }
      message(failure instanceof Error ? failure.message : String(failure));
    }
    await load();
  }

  /** The row under a workspace that asks for its id before a delete. */
  function confirmRow(user: User, workspace: Workspace) {
    const path = `users/${encodeURIComponent(user.id)}/workspaces/${encodeURIComponent(workspace.workspaceId)}`;
    const input = el("input", {
      type: "text",
      class: "confirm",
      placeholder: workspace.workspaceId,
      "aria-label": `Type ${workspace.workspaceId} to delete`,
      "data-testid": "delete-confirm-input",
    }) as HTMLInputElement;
    const go = el(
      "button",
      {
        type: "button",
        class: "danger",
        disabled: "",
        "data-testid": "delete-confirm",
      },
      "Delete for good",
    ) as HTMLButtonElement;
    input.addEventListener("input", () => {
      go.disabled = input.value.trim().toLowerCase() !== workspace.workspaceId;
    });
    go.addEventListener("click", () => {
      confirming.delete(workspace.workspaceId);
      void runAction(`Deleted ${workspace.name}`, () =>
        api("DELETE", path, { confirm: input.value }),
      );
    });
    const cancel = el("button", { type: "button", class: "quiet" }, "Cancel");
    cancel.addEventListener("click", () => {
      confirming.delete(workspace.workspaceId);
      void load();
    });
    const box = el(
      "div",
      { class: "confirm-box" },
      el(
        "span",
        { class: "warn" },
        `Delete ${workspace.name} for good? This removes its pod, both volumes and its record; the user's Mac falls back to its own copy. Type the workspace id to confirm:`,
      ),
      input,
      el("div", { class: "row" }, go, cancel),
    );
    queueMicrotask(() => input.focus());
    return el("tr", { class: "confirm-row" }, el("td", { colspan: "9" }, box));
  }

  function workspaceActions(user: User, workspace: Workspace) {
    const box = el("div", { class: "actions" });
    const cell = el("td", { class: "actions-cell" }, box);
    if (session?.role !== "admin" || confirming.has(workspace.workspaceId))
      return cell;
    const path = `users/${encodeURIComponent(user.id)}/workspaces/${encodeURIComponent(workspace.workspaceId)}`;
    const button = (
      label: string,
      testId: string,
      run: () => void,
      kind = "",
    ) => {
      const node = el(
        "button",
        { type: "button", class: kind, "data-testid": testId },
        label,
      );
      node.addEventListener("click", run);
      return node;
    };
    if (workspace.status === "sleeping")
      box.append(
        button(
          "Wake",
          "workspace-wake",
          () =>
            void runAction(`Waking ${workspace.name}`, () =>
              api("POST", `${path}/wake`),
            ),
        ),
      );
    else
      box.append(
        button(
          "Sleep",
          "workspace-sleep",
          () =>
            void runAction(`${workspace.name} is asleep`, () =>
              api("POST", `${path}/sleep`),
            ),
        ),
      );
    box.append(
      button(
        "Delete…",
        "workspace-delete",
        () => {
          confirming.add(workspace.workspaceId);
          void load();
        },
        "danger-quiet",
      ),
    );
    return cell;
  }

  function collection(workspace: Workspace) {
    if (workspace.status !== "sleeping") return "–";
    if (workspace.daysUntilCollection === null) return "never";
    if (workspace.daysUntilCollection === 0) return "within a day";
    if (workspace.daysUntilCollection === 1) return "1 day";
    return `${workspace.daysUntilCollection} days`;
  }

  function resources(workspace: Workspace) {
    if (!workspace.resources) return "no pod while asleep";
    const { cpu, memory } = workspace.resources;
    return el(
      "div",
      { class: "resources" },
      el("div", {}, `CPU ${cpu.request}, up to ${cpu.limit}`),
      el("div", {}, `Memory ${memory.request}, up to ${memory.limit}`),
      workspace.live
        ? el(
            "div",
            { class: "live", "data-testid": "workspace-live" },
            `Using ${cores(workspace.live.cpu)} CPU, ${bytes(workspace.live.memory)}`,
          )
        : null,
    );
  }

  function workspaceRow(user: User, workspace: Workspace) {
    const status = el(
      "td",
      {},
      el(
        "span",
        {
          class: `pill ${workspace.status}`,
          "data-testid": "workspace-status",
        },
        marked(STATUS_LABEL[workspace.status] ?? workspace.status),
      ),
      workspace.reason
        ? el("div", { class: "reason" }, workspace.reason)
        : null,
    );
    const disk = el(
      "td",
      {
        title: workspace.disk
          .map((volume) => `${volume.name}: ${volume.size}`)
          .join("\n"),
      },
      workspace.disk.length ? bytes(workspace.diskBytes) : "–",
    );
    return el(
      "tr",
      {
        "data-testid": "workspace-row",
        "data-workspace": workspace.workspaceId,
      },
      el(
        "td",
        {},
        el("div", { class: "name" }, marked(workspace.name)),
        el("div", { class: "id" }, marked(workspace.workspaceId)),
      ),
      status,
      el("td", { title: workspace.createdAt }, when(workspace.createdAt)),
      el(
        "td",
        { title: workspace.lastActiveAt ?? "" },
        ago(workspace.lastActiveAt),
      ),
      el("td", { title: workspace.sleptAt ?? "" }, when(workspace.sleptAt)),
      el("td", { title: workspace.collectAt ?? "" }, collection(workspace)),
      disk,
      el("td", {}, resources(workspace)),
      workspaceActions(user, workspace),
    );
  }

  function limitEditor(user: User) {
    const count = `${user.workspaces.length} of ${user.limit} workspaces`;
    const label = el(
      "span",
      { class: "limit", "data-testid": "user-limit" },
      count,
      user.limitOverride !== null
        ? el("span", { class: "override" }, " (override)")
        : null,
    );
    if (session?.role !== "admin") return label;
    const input = el("input", {
      type: "number",
      min: "0",
      max: String(defaultLimit),
      step: "1",
      value: user.limitOverride === null ? "" : String(user.limitOverride),
      placeholder: "default",
      "aria-label": `Workspace limit for ${user.email}`,
      title: `An override can only lower the limit, to at most ${defaultLimit}: the volume quota is sized for the default`,
      "data-testid": "limit-input",
    }) as HTMLInputElement;
    input.addEventListener("focus", () => (editing = true));
    input.addEventListener("blur", () => (editing = false));
    const save = el(
      "button",
      { type: "button", "data-testid": "limit-save" },
      "Set limit",
    );
    save.addEventListener("click", () => {
      editing = false;
      const text = input.value.trim();
      const maxWorkspaces = text === "" ? null : Number(text);
      void runAction(
        maxWorkspaces === null
          ? `${user.email} uses the default limit`
          : `${user.email} may have ${maxWorkspaces} workspaces`,
        () =>
          api("PUT", `users/${encodeURIComponent(user.id)}/limit`, {
            maxWorkspaces,
          }),
      );
    });
    return el("div", { class: "limit-editor" }, label, input, save);
  }

  function userSection(user: User, shown = user.workspaces) {
    const table = el(
      "table",
      { class: "workspaces" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          ...[
            "Workspace",
            "Status",
            "Created",
            "Last active",
            "Slept at",
            "Collected in",
            "Disk",
            "Pod resources",
            "",
          ].map((title) => el("th", {}, title)),
        ),
      ),
      el(
        "tbody",
        {},
        ...shown.flatMap((workspace) =>
          confirming.has(workspace.workspaceId) && session?.role === "admin"
            ? [workspaceRow(user, workspace), confirmRow(user, workspace)]
            : [workspaceRow(user, workspace)],
        ),
      ),
    );
    return el(
      "section",
      { class: "user", "data-testid": "admin-user", "data-user": user.id },
      el(
        "div",
        { class: "user-head" },
        el(
          "div",
          {},
          el("h2", {}, marked(user.email)),
          el(
            "div",
            { class: "id" },
            marked(user.id),
            ` · since ${when(user.createdAt)}`,
          ),
        ),
        limitEditor(user),
      ),
      user.error ? el("p", { class: "message error" }, user.error) : null,
      shown.length
        ? el("div", { class: "table-wrap" }, table)
        : el("p", { class: "hint" }, "No workspaces."),
      shown.length < user.workspaces.length
        ? el(
            "p",
            { class: "hint" },
            `${user.workspaces.length - shown.length} more hidden by the filter.`,
          )
        : null,
    );
  }

  function auditSection(entries: AuditEntry[]) {
    const rows = entries.map((entry) =>
      el(
        "tr",
        {},
        el("td", { title: entry.at }, when(entry.at)),
        el(
          "td",
          {},
          entry.subject,
          entry.session
            ? el("span", { class: "id" }, ` ${entry.session}`)
            : null,
        ),
        el("td", {}, entry.address),
        el("td", {}, entry.action),
        el("td", { class: "id" }, entry.target),
        el("td", { class: `result ${entry.result}` }, entry.result),
        el("td", {}, entry.detail),
      ),
    );
    return el(
      "section",
      { class: "audit", "data-testid": "admin-audit" },
      el("h2", {}, `Audit log, ${entries.length} newest`),
      el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          {},
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              ...[
                "When",
                "Who",
                "Address",
                "Action",
                "Target",
                "Result",
                "Detail",
              ].map((title) => el("th", {}, title)),
            ),
          ),
          el("tbody", {}, ...rows),
        ),
      ),
    );
  }

  function uptime(seconds: number): string {
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`;
    return `${Math.round(seconds / 86_400)} days`;
  }

  function share(used: number, total: number, show: (value: number) => string) {
    const text = `${show(used)} of ${show(total)}`;
    return total > 0 && used >= total * 0.9
      ? el("span", { class: "near-full" }, text)
      : text;
  }

  const table = (titles: string[], rows: HTMLElement[]) =>
    el(
      "div",
      { class: "table-wrap" },
      el(
        "table",
        {},
        el(
          "thead",
          {},
          el("tr", {}, ...titles.map((title) => el("th", {}, title))),
        ),
        el("tbody", {}, ...rows),
      ),
    );

  function healthSection(health: Health) {
    const parts: (HTMLElement | null)[] = [];
    if (health.problems.length)
      parts.push(
        el(
          "ul",
          { class: "problems", "data-testid": "health-problems" },
          ...health.problems.map((item) =>
            el(
              "li",
              { class: item.severity },
              el("span", { class: "area" }, item.area),
              item.message,
            ),
          ),
        ),
      );
    else parts.push(el("p", { class: "ok-line" }, "Nothing needs attention."));

    parts.push(el("h3", {}, "Nodes"));
    if (health.nodes)
      parts.push(
        table(
          [
            "Node",
            "Ready",
            health.runtimeClass
              ? `${health.runtimeHandler} runtime`
              : "Runtime",
            "CPU requested",
            "Memory requested",
            "Disk requested",
            "Workspace pods",
          ],
          health.nodes.map((node) =>
            el(
              "tr",
              { "data-testid": "health-node" },
              el("td", {}, node.name),
              el(
                "td",
                {},
                node.ready
                  ? node.unschedulable
                    ? el("span", { class: "near-full" }, "Ready, cordoned")
                    : "Ready"
                  : el(
                      "span",
                      { class: "bad" },
                      `Not ready: ${node.readyMessage ?? ""}`,
                    ),
              ),
              el(
                "td",
                {},
                node.runtime === null
                  ? health.runtimeClass
                    ? "not reported"
                    : "not required"
                  : node.runtime
                    ? "yes"
                    : el("span", { class: "bad" }, "missing"),
              ),
              el(
                "td",
                {},
                share(node.requested.cpu, node.allocatable.cpu, cores),
              ),
              el(
                "td",
                {},
                share(node.requested.memory, node.allocatable.memory, bytes),
              ),
              el(
                "td",
                {},
                share(
                  node.requested.ephemeral,
                  node.allocatable.ephemeral,
                  bytes,
                ),
              ),
              el("td", {}, String(node.workspacePods)),
            ),
          ),
        ),
        el(
          "p",
          { class: "hint" },
          "Requested counts workspace pods only; the gateway cannot see other namespaces.",
        ),
      );
    else
      parts.push(
        el(
          "p",
          { class: "message error" },
          `Nodes: ${health.nodesError ?? "not readable"}`,
        ),
      );

    if (health.pods.length)
      parts.push(
        el("h3", {}, "Workspace pods with problems"),
        table(
          ["Workspace", "User", "Pod", "Problem", "Detail"],
          health.pods.map((item) =>
            el(
              "tr",
              {},
              el("td", {}, item.workspace),
              el("td", {}, item.email),
              el("td", { class: "id" }, item.pod),
              el("td", {}, item.kind),
              el("td", { class: "detail" }, item.detail),
            ),
          ),
        ),
      );
    if (health.volumes.length)
      parts.push(
        el("h3", {}, "Volumes not bound"),
        table(
          ["Volume", "User", "Phase"],
          health.volumes.map((item) =>
            el(
              "tr",
              {},
              el("td", { class: "id" }, item.volume),
              el("td", {}, item.email),
              el("td", {}, item.phase),
            ),
          ),
        ),
      );
    if (health.quotas.length)
      parts.push(
        el("h3", {}, "Quota per user"),
        table(
          ["User", "Storage", "Volumes", "Pods"],
          health.quotas.map((item) => {
            const cell = (
              value: { used: number; hard: number } | null,
              show: (value: number) => string,
            ) =>
              el("td", {}, value ? share(value.used, value.hard, show) : "–");
            return el(
              "tr",
              {},
              el("td", {}, item.email),
              cell(item.storage, bytes),
              cell(item.volumes, String),
              cell(item.pods, String),
            );
          }),
        ),
      );

    const { gateway } = health;
    const last = gateway.lastCollection;
    parts.push(
      el("h3", {}, "Gateway"),
      el(
        "div",
        { class: "stats small", "data-testid": "health-gateway" },
        stat("Up", uptime(gateway.uptimeSeconds), "health-uptime"),
        stat("Macs connected", String(gateway.macs), "health-macs"),
        stat("Runners connected", String(gateway.runners), "health-runners"),
        stat(
          "Last collection",
          last ? ago(last.at) : "not yet",
          "health-collection",
        ),
      ),
      el(
        "p",
        { class: "hint" },
        last
          ? `The last pass deleted ${last.workspaces} workspace${last.workspaces === 1 ? "" : "s"} and ${last.namespaces} namespace${last.namespaces === 1 ? "" : "s"}, with ${last.failures} failure${last.failures === 1 ? "" : "s"}. `
          : "",
        `Collection runs every ${gateway.collectMinutes} min. `,
        health.metrics.available
          ? "Live CPU and memory come from metrics-server."
          : `Pod resources are requests only: ${health.metrics.reason ?? "no metrics"}.`,
      ),
    );
    if (health.recentLog.length)
      parts.push(
        el(
          "details",
          { class: "log" },
          el(
            "summary",
            {},
            `Recent gateway log (${health.recentLog.length} line${health.recentLog.length === 1 ? "" : "s"})`,
          ),
          el(
            "ul",
            {},
            ...health.recentLog.map((line) =>
              el(
                "li",
                {},
                el("span", { class: "id" }, when(line.at)),
                " ",
                line.message,
              ),
            ),
          ),
        ),
      );

    return el(
      "section",
      {
        id: "health",
        class: `health ${health.ok ? "healthy" : "sick"}`,
        "data-testid": "admin-health",
      },
      el(
        "h2",
        {},
        health.ok
          ? "Health: all good"
          : `Health: ${health.problems.length} to look at`,
      ),
      ...parts,
    );
  }

  /** The overview's short list of what is wrong, pointing at Health. */
  function attention(health: Health) {
    const first = health.problems.slice(0, 5);
    return el(
      "section",
      {
        class: `attention ${health.ok ? "healthy" : "sick"}`,
        "data-testid": "admin-attention",
      },
      el("h2", {}, health.ok ? "Nothing needs attention" : "Needs attention"),
      health.ok
        ? el(
            "p",
            { class: "hint" },
            `${health.nodes?.length ?? 0} node${health.nodes?.length === 1 ? "" : "s"} ready, no workspace pod or volume in trouble.`,
          )
        : el(
            "ul",
            { class: "problems" },
            ...first.map((item) =>
              el(
                "li",
                { class: item.severity },
                el("span", { class: "area" }, item.area),
                item.message,
              ),
            ),
          ),
      el(
        "a",
        { href: "#health", class: "more" },
        health.problems.length > first.length
          ? `All ${health.problems.length} on the Health page`
          : "Open the Health page",
      ),
    );
  }

  let lastOverview: Overview | null = null;
  let lastAudit: AuditEntry[] = [];
  /** The signed-in page's parts; the filter box survives every refresh. */
  let shell: {
    header: HTMLElement;
    content: HTMLElement;
    filterBar: HTMLElement;
    list: HTMLElement;
    filter: HTMLInputElement;
  } | null = null;

  function buildShell() {
    const filter = el("input", {
      type: "search",
      class: "filter",
      placeholder:
        "Filter by email, user id, workspace name or id, or status (asleep, failed, running)",
      "aria-label": "Filter users and workspaces",
      spellcheck: "false",
      autocomplete: "off",
      "data-testid": "admin-filter",
    }) as HTMLInputElement;
    filter.value = query;
    filter.addEventListener("input", () => {
      query = filter.value;
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${hashFor("workspaces")}`,
      );
      renderList();
    });
    const filterBar = el(
      "div",
      { class: "filter-bar" },
      filter,
      el("span", {
        class: "hint",
        id: "filter-count",
        "data-testid": "filter-count",
      }),
    );
    const header = el("header", {});
    const content = el("div", { class: "stack" });
    const list = el("div", { class: "stack" });
    root.replaceChildren(
      header,
      el(
        "main",
        {},
        el("p", { class: "message", id: "message", hidden: "" }),
        content,
      ),
    );
    shell = { header, content, filterBar, list, filter };
  }

  // The menu's links, a pasted link and Back change the page or filter.
  window.addEventListener("hashchange", () => {
    const next = readRoute();
    const moved = next.page !== page;
    page = next.page;
    query = next.query;
    if (shell && shell.filter.value !== query) shell.filter.value = query;
    render();
    if (moved) window.scrollTo(0, 0);
  });

  const stamp = (overview: Overview) =>
    el(
      "p",
      { class: "hint stamp" },
      `Updated ${when(overview.generatedAt)}; refreshes every 15 s.`,
    );

  /** Draws the current page from the last data, keeping the filter box. */
  function render() {
    if (!shell || !lastOverview) return;
    const overview = lastOverview;
    const fresh = header(overview);
    shell.header.replaceWith(fresh);
    shell.header = fresh;
    document.title = `${PAGES.find((item) => item.id === page)!.label} · Daedalus admin`;
    const { content } = shell;
    if (page === "workspaces") {
      if (shell.filterBar.parentElement !== content)
        content.replaceChildren(shell.filterBar, shell.list);
      renderList();
      return;
    }
    if (page === "health")
      content.replaceChildren(healthSection(overview.health), stamp(overview));
    else if (page === "audit")
      content.replaceChildren(auditSection(lastAudit), stamp(overview));
    else
      content.replaceChildren(
        summary(overview),
        attention(overview.health),
        stamp(overview),
      );
  }

  function renderList() {
    if (!shell || !lastOverview || page !== "workspaces") return;
    const overview = lastOverview;
    const list = terms();
    // Users with workspaces first; the order is otherwise by email.
    const ordered = [
      ...overview.users.filter((user) => user.workspaces.length),
      ...overview.users.filter((user) => !user.workspaces.length),
    ];
    const sections: HTMLElement[] = [];
    let shownCount = 0;
    for (const user of ordered) {
      const shown = list.length
        ? user.workspaces.filter((workspace) =>
            matches(workspaceFields(user, workspace), list),
          )
        : user.workspaces;
      const visible = list.length
        ? shown.length > 0 ||
          (!user.workspaces.length && matches([user.email, user.id], list))
        : true;
      if (!visible) continue;
      shownCount += shown.length;
      sections.push(userSection(user, shown));
    }
    const counter = document.getElementById("filter-count");
    if (counter)
      counter.textContent = list.length
        ? `${shownCount} of ${overview.summary.workspaces} workspaces, ${sections.length} of ${overview.users.length} users`
        : "";
    shell.list.replaceChildren(
      ...(overview.users.length
        ? sections.length
          ? sections
          : [
              el(
                "p",
                { class: "hint", "data-testid": "filter-empty" },
                "Nothing matches the filter.",
              ),
            ]
        : [el("p", { class: "hint" }, "No users have signed in yet.")]),
      stamp(overview),
    );
  }

  async function load() {
    stopTimer();
    let overview: Overview;
    let audit: { entries: AuditEntry[] };
    try {
      [overview, audit] = await Promise.all([
        api<Overview>("GET", "overview"),
        api<{ entries: AuditEntry[] }>("GET", "audit?limit=100"),
      ]);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        session = null;
        signInView();
        return;
      }
      message(failure instanceof Error ? failure.message : String(failure));
      schedule();
      return;
    }
    defaultLimit = overview.settings.defaultLimit;
    lastOverview = overview;
    lastAudit = audit.entries;
    if (!shell) buildShell();
    render();
    schedule();
  }

  void (async () => {
    try {
      session = await api<Session>("GET", "session");
      await load();
    } catch {
      signInView();
    }
  })();
}
