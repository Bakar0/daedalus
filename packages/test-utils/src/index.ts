import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function withTemporaryDaedalusHome<T>(
  run: (home: string) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "daedalus-test-"));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
