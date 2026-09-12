import { mkdir } from "node:fs/promises";

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
