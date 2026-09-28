#!/usr/bin/env bun
import { resolve } from "node:path";
import { normalizeError } from "@daedalus/core";
import { BUNDLED_TMUX_VARIABLE } from "@daedalus/platform";
import { runCli } from "./index";

// This file is the CLI inside Daedalus.app, at
// Contents/Resources/app/cli/daedal.js, and the app's tmux is at
// Contents/MacOS/tmux. A run from the user's own terminal has not inherited
// the variable the app sets, so it is set here too.
const bundledTmux = resolve(import.meta.dir, "../../../MacOS/tmux");
if (
  !process.env[BUNDLED_TMUX_VARIABLE] &&
  (await Bun.file(bundledTmux).exists())
)
  process.env[BUNDLED_TMUX_VARIABLE] = bundledTmux;

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
