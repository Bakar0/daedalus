#!/usr/bin/env bun
import { resolve } from "node:path";
import { normalizeError } from "@daedalus/core";
import { runCli } from "./index";

const json = Bun.argv.slice(2).includes("--json");
try {
  process.exitCode = await runCli(Bun.argv.slice(2), {
    migrationsDirectory: resolve(import.meta.dir, "../migrations"),
  });
} catch (error) {
  const normalized = normalizeError(error);
  if (json)
    console.error(
      JSON.stringify({
        ok: false,
        error: {
          code: normalized.code,
          message: normalized.message,
          details: normalized.details,
        },
      }),
    );
  else console.error(`${normalized.code}: ${normalized.message}`);
  process.exitCode = normalized.exitCode;
}
