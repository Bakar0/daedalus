#!/usr/bin/env bun
import { createApplicationContext, normalizeError } from "@daedalus/core";
import { probeVersion } from "@daedalus/platform";
import type { DoctorCheck } from "@daedalus/protocol";

const VERSION = "0.1.0";
const MINIMUM_TMUX = "3.7c";
const VERIFIED_BUN = "1.4.2";

function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (version: string) => {
    const match = version.match(/(\d+)\.(\d+)([a-z]?)/i);
    return match
      ? [
          Number(match[1]),
          Number(match[2]),
          match[3] ? match[3].toLowerCase().charCodeAt(0) - 96 : 0,
        ]
      : undefined;
  };
  const left = parse(actual);
  const right = parse(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0))
      return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
}

const help = `daedal ${VERSION} — local-first control plane for coding agents

Usage:
  daedal --help
  daedal --version
  daedal doctor [--json]

Commands:
  doctor       Check runtime, tmux, data directories, and SQLite

Workspace, task, and agent lifecycle commands begin in Phases 2–4.`;

async function doctor(json: boolean): Promise<number> {
  const context = await createApplicationContext();
  const bunVersion = Bun.version;
  const tmuxVersion = await probeVersion("tmux", ["-V"]);
  const tmuxCompatible = Boolean(
    tmuxVersion && versionAtLeast(tmuxVersion, MINIMUM_TMUX),
  );
  const checks: DoctorCheck[] = [
    {
      name: "bun",
      ok: bunVersion === VERIFIED_BUN,
      version: bunVersion,
      detail:
        bunVersion === VERIFIED_BUN
          ? "verified runtime"
          : `expected verified version ${VERIFIED_BUN}`,
    },
    {
      name: "tmux",
      ok: tmuxCompatible,
      version: tmuxVersion,
      detail: tmuxVersion
        ? `verified minimum ${MINIMUM_TMUX}`
        : "tmux is not available on PATH",
    },
    { name: "home", ok: true, detail: context.config.home },
    { name: "database", ok: true, detail: context.config.databasePath },
  ];
  if (json) {
    console.log(
      JSON.stringify({
        ok: checks.every((check) => check.ok),
        data: { checks },
      }),
    );
  } else {
    for (const check of checks) {
      console.log(
        `${check.ok ? "✓" : "✗"} ${check.name}: ${check.version || check.detail}`,
      );
      if (check.version) console.log(`  ${check.detail}`);
    }
  }
  return checks.every((check) => check.ok) ? 0 : 5;
}

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(help);
    return 0;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return 0;
  }
  if (args[0] === "doctor") return doctor(args.includes("--json"));
  console.error(`Unknown command: ${args[0]}\n\n${help}`);
  return 2;
}

try {
  process.exitCode = await main();
} catch (error) {
  const normalized = normalizeError(error);
  console.error(`${normalized.code}: ${normalized.message}`);
  process.exitCode = normalized.exitCode;
}
