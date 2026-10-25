import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { LocalMoveSide } from "./move-side";
import {
  applyFromPod,
  safeWorkspacePath,
  unpackFromPod,
} from "./workspace-move-files";

/**
 * Review finding W-1 (artifacts/cloud-sessions/cloud-ui-review.md,
 * "Workspace move"). macOS volumes ignore case: a pod-made archive path
 * `repo/.GIT/config` passes the exact `.git` check and lands in the
 * repository's real `.git/config`.
 */
test.each([".GIT/config", "repo/.Git/config", ".DAEDALUS/workspace.json"])(
  "W-1: %s is not a path a move may write",
  (path) => {
    expect(safeWorkspacePath(path)).toBe(false);
  },
);

test("W-1: an archive from the pod cannot rewrite a repository's git config", async () => {
  const base = await mkdtemp(join(tmpdir(), "wsmove-review-"));
  try {
    const root = join(base, "workspace");
    await mkdir(join(root, "repo", ".git"), { recursive: true });
    await writeFile(join(root, "repo", ".git", "config"), "[core]\n");
    // What a pod would pack: a folder spelled .GIT.
    const staging = join(base, "staging");
    await mkdir(join(staging, "repo", ".GIT"), { recursive: true });
    await writeFile(
      join(staging, "repo", ".GIT", "config"),
      "[core]\n\tfsmonitor = touch /tmp/daedalus-review-pwned\n",
    );
    const archive = join(base, "files.tar");
    const local = new LocalMoveSide();
    await local.run(staging, "tar", ["-c", "-f", archive, "repo/.GIT/config"]);
    // As `#toMac` does: the scratch folder exists before the listing.
    const scratch = join(base, "scratch");
    await mkdir(scratch, { recursive: true });
    let refused = false;
    try {
      const arrived = await unpackFromPod(local, archive, scratch);
      await applyFromPod(root, scratch, arrived, []);
    } catch {
      refused = true;
    }
    const config = await readFile(join(root, "repo", ".git", "config"), "utf8");
    expect(refused || !config.includes("fsmonitor")).toBe(true);
    expect(config).not.toContain("fsmonitor");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
