import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { AppUpdateDto } from "@daedalus/protocol";
import { UpdateBanner } from "./UpdateBanner";

const render = (update: AppUpdateDto) =>
  renderToStaticMarkup(
    <UpdateBanner
      onDismiss={() => undefined}
      onInstall={() => undefined}
      update={update}
    />,
  );

describe("UpdateBanner", () => {
  test("an offer names both versions and has both answers", () => {
    const markup = render({
      state: "available",
      currentVersion: "0.8.0",
      version: "0.9.0",
    });
    expect(markup).toContain("Daedalus 0.9.0 is available. You have 0.8.0.");
    expect(markup).toContain("Update and restart");
    expect(markup).toContain("Later");
  });

  test("nothing can be clicked while the update is on its way", () => {
    for (const state of ["downloading", "restarting"] as const) {
      const markup = render({
        state,
        currentVersion: "0.8.0",
        version: "0.9.0",
      });
      expect(markup).not.toContain("<button");
    }
  });

  test("a failure is an alert that can be closed", () => {
    const markup = render({
      state: "error",
      currentVersion: "0.8.0",
      message: "Could not check for updates: offline",
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not check for updates: offline");
    expect(markup).toContain("Close");
  });
});
