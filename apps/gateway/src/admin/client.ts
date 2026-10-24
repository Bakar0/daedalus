/**
 * The admin page's script. The gateway serves `(adminClient)()` as
 * /admin/admin.js, so everything it needs lives inside the function: it may
 * use only browser globals, never an import or a module-level value.
 *
 * Every value from the gateway goes into the page as text (textContent and
 * attributes), never as HTML. Workspace names and emails come from users.
 */
export function adminClient(): void {
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
    return el("header", {}, el("h1", {}, "Daedalus cloud admin"), right);
  }

  function signInView(error = "") {
    stopTimer();
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
    return el(
      "section",
      { class: "summary", "data-testid": "admin-summary" },
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
        STATUS_LABEL[workspace.status] ?? workspace.status,
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
        el("div", { class: "name" }, workspace.name),
        el("div", { class: "id" }, workspace.workspaceId),
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

  function userSection(user: User) {
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
        ...user.workspaces.flatMap((workspace) =>
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
          el("h2", {}, user.email),
          el(
            "div",
            { class: "id" },
            `${user.id} · since ${when(user.createdAt)}`,
          ),
        ),
        limitEditor(user),
      ),
      user.error ? el("p", { class: "message error" }, user.error) : null,
      user.workspaces.length
        ? el("div", { class: "table-wrap" }, table)
        : el("p", { class: "hint" }, "No workspaces."),
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
      "details",
      { class: "audit", "data-testid": "admin-audit" },
      el("summary", {}, `Audit log (${entries.length} newest)`),
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

  let auditOpen = false;

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
    const previous = document.getElementById("message");
    const kept = previous && !previous.hidden ? previous.cloneNode(true) : null;
    const details = root.querySelector("details.audit");
    if (details) auditOpen = (details as HTMLDetailsElement).open;
    const audits = auditSection(audit.entries);
    if (auditOpen) audits.setAttribute("open", "");
    root.replaceChildren(
      header(overview),
      el(
        "main",
        {},
        kept ?? el("p", { class: "message", id: "message", hidden: "" }),
        summary(overview),
        ...(overview.users.length
          ? [
              // Users with workspaces first; the order is otherwise by email.
              ...overview.users.filter((user) => user.workspaces.length),
              ...overview.users.filter((user) => !user.workspaces.length),
            ].map(userSection)
          : [el("p", { class: "hint" }, "No users have signed in yet.")]),
        audits,
        el(
          "p",
          { class: "hint stamp" },
          `Updated ${when(overview.generatedAt)}; refreshes every 15 s.`,
        ),
      ),
    );
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
