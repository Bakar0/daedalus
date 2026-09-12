# CLI contract

Phase 1 exposes the stable global shell and diagnostics only:

```text
daedal --help
daedal --version
daedal doctor
daedal doctor --json
```

Human output is written to stdout and actionable errors to stderr. JSON results use `{ "ok": boolean, "data": ... }` and contain no decorative output.

Exit codes are reserved across future commands:

| Code | Meaning                            |
| ---: | ---------------------------------- |
|    0 | Success                            |
|    1 | Unexpected/internal failure        |
|    2 | Usage or validation error          |
|    3 | Object not found                   |
|    4 | Conflict                           |
|    5 | Missing or incompatible dependency |

`doctor` checks the verified Bun version, tmux availability/minimum, resolved Daedalus home, and migrated SQLite database. Use `DAEDALUS_HOME` to isolate its writes.

Workspace, task, and agent commands are intentionally deferred to Phases 2–4. Their future handlers must call `@daedalus/core`; direct filesystem or SQL writes in CLI commands are prohibited.
