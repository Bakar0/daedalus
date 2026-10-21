import { afterAll, mock } from "bun:test";
import * as os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// Code that falls back to the user's provider folders (`~/.claude.json`,
// `~/.claude`, `~/.codex`) finds them through `homedir()`. A test that does
// not point every one of those elsewhere would otherwise write to the real
// files of whoever runs the suite. `HOME` itself is left alone, because git
// and login shells read it and the tests rely on both.
const home = mkdtempSync(join(os.tmpdir(), "daedalus-test-home-"));
const homedir = () => home;
mock.module("node:os", () => ({ ...os, homedir, default: { ...os, homedir } }));
mock.module("os", () => ({ ...os, homedir, default: { ...os, homedir } }));

// A hook registered here runs once, after the last test file; `bun test`
// fires no `exit` event a cleanup could wait for instead.
afterAll(() => rmSync(home, { recursive: true, force: true }));
