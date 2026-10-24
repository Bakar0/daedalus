import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The Daedalus checkout a dev build was built in, found by walking up from
 * the bundle (`build/dev-macos-arm64/Daedalus-dev.app/...` sits inside it).
 * The gateway install builds the local images from it. An installed app has
 * none.
 */
export function daedalusCheckout(start: string): string | undefined {
  let directory = start;
  for (let depth = 0; depth < 10; depth++) {
    if (
      existsSync(join(directory, "apps/gateway/Dockerfile")) &&
      existsSync(join(directory, "apps/runner/Dockerfile")) &&
      existsSync(join(directory, "deploy/helm/daedalus/Chart.yaml"))
    )
      return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}
