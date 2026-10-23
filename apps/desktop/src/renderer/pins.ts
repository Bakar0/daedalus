import { useCallback, useState } from "react";

/**
 * Which actions show on cards, and which live only in their menus. Pins are
 * the user's, the same for every workspace and every session, and kept in
 * this window's storage. Settings and the workspace's + are always there and
 * are not listed.
 */
export type WorkspaceActionId = "terminal" | "secrets" | "cloud" | "archive";
export type SessionActionId = "rebirth" | "archive";

export interface Pins {
  workspace: ReadonlySet<WorkspaceActionId>;
  session: ReadonlySet<SessionActionId>;
}

export const DEFAULT_PINS: Pins = {
  workspace: new Set(),
  session: new Set(["rebirth", "archive"]),
};

const KEY = "daedalus.pins";

const WORKSPACE_IDS: readonly WorkspaceActionId[] = [
  "terminal",
  "secrets",
  "cloud",
  "archive",
];
const SESSION_IDS: readonly SessionActionId[] = ["rebirth", "archive"];

export function readPins(): Pins {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "null");
    if (!raw || typeof raw !== "object") return DEFAULT_PINS;
    const { workspace, session } = raw as Record<string, unknown>;
    return {
      workspace: Array.isArray(workspace)
        ? new Set(WORKSPACE_IDS.filter((id) => workspace.includes(id)))
        : DEFAULT_PINS.workspace,
      session: Array.isArray(session)
        ? new Set(SESSION_IDS.filter((id) => session.includes(id)))
        : DEFAULT_PINS.session,
    };
  } catch {
    return DEFAULT_PINS;
  }
}

function writePins(pins: Pins): void {
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        workspace: [...pins.workspace],
        session: [...pins.session],
      }),
    );
  } catch {
    // Only a convenience; the defaults come back next time.
  }
}

export function usePins() {
  const [pins, setPins] = useState<Pins>(readPins);
  const pin = useCallback(
    <K extends keyof Pins>(
      kind: K,
      id: K extends "workspace" ? WorkspaceActionId : SessionActionId,
      pinned: boolean,
    ) =>
      setPins((current) => {
        const set = new Set(current[kind] as ReadonlySet<typeof id>);
        if (pinned) set.add(id);
        else set.delete(id);
        const next = { ...current, [kind]: set } as Pins;
        writePins(next);
        return next;
      }),
    [],
  );
  return { pins, pin };
}
