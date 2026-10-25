# Changelog

All notable changes to `@akms/mcp-db`. Dates are `YYYY-MM-DD`.

## [0.3.1] - 2026-10-26

### Verification

- Stabilize Windows test cleanup: temporary test directories are removed with one bounded asynchronous retry budget for transient file locks, while persistent errors still fail. Tests only; the published package changes only its version.
- 0.3.0 was committed but never published to npm; 0.3.1 is the first published 0.3 release.

## [0.3.0] - 2026-10-26

- Detect older registry formats in standalone config and the helper menu. Add reviewed, ordered migrations with default-No approval, script APIs, complete pre-migration backup, rollback preservation and post-apply startup checks. Runtime can change the default for future kinds without changing existing modes.

- Start new registries in version 2 session mode. Register/Add/Import create per-kind bundles automatically; missing runtimes keep imported legacy entries until installation and Sync. Existing v1 migration and v2 per-kind rollback choices are preserved.

- Add session servers (default for new catalogs, opt-in migration for existing version 1 catalogs): one direct-Node `akms_<kind>` entry per client session, connection-prefixed tools, registry version 2, reviewed migration and rollback, and startup tool coverage checks.
- Preserve one atomic `registry.previous.json` revision per catalog-changing operation; keep externally edited client entries for Sync and retain old entries until replacements are verified.
- Validate connection-name budgets; document credential location and recovery in session mode. Show runtime paths in startup failures, accept string protocol versions, and explain file-lock update failures.

- Check MCP startup after saves, runtime conversion and Updates; add an on-demand Updates screen and default registration removal to No.

- Document plaintext catalog credentials, platform permissions, transfer-guard limits and recovery; show one privacy notice during Register review and a catalog notice in --help.
- Keep custom-command edits and host-key saves independent of the managed runtime; continue with a still-usable installed runtime after an update failure.

- Install managed server runtimes under `<AKMS_MCP_HOME or ~/.akms/mcp>/runtime`, independent of Node versions. Convert existing npx and global paths through Runtime; preserve development links.
- Offer older-runtime updates before Add/Edit and check installation before host-key saves. Include the last npm error lines without ANSI controls, and recognize Unix npm JavaScript paths while skipping version-manager shims.

- Generate direct Node launches using the dedicated runtime installation instead of npx. Install the latest runtime on first Add/Edit when missing; reuse installed versions with update prompts when the setup package is newer. Runtime converts existing standard entries together, preserving connection values, custom commands and external edits; linked development packages are protected.

- Clarify Sync choices with numbered AKMS/service versions, highlighted differences, wrapped values, and explicit apply destinations.

- Separate terminal menu, comparison and result screens; wait for acknowledgement before returning, while keeping piped commands unchanged.

- Keep all configuration menus visible; Add requires at least one registered AI service.
- Summarize registration/sync results, show only differing fields during review, and distinguish pending imports from shared settings conflicts.

### Changed

- Discover earlier client settings before registration, merge matching sync copies on Apply, and preserve differing versions for review.
- Add standalone `register` and `sync` commands and a persistent shared connection catalog. Save once to apply a connection to all registered AI services without installing `@akms/mcp`.
- Import existing client entries with explicit conflict choices; preserve external edits, retry partial failures and retain old names until renames succeed. Honor `CODEX_HOME`.

## 0.2.1 — 2026-10-19

### Documentation

- Add minimum direct-connection and URL configuration examples to README, including authentication, TLS defaults and Windows launch settings.

## 0.2.0 — 2026-10-19

### Changed

- Align the package, CLI and MCP server versions with the 0.2.0 MCP release family. Retain the parser memory reclamation and lifecycle safeguards documented below.

## 0.1.7 — 2026-10-19

### Fixed

- Report parser startup, dispatch, runtime and shutdown failures as operational errors instead of SQL syntax errors, so clients are not told to rewrite valid SQL. Refuse the affected request before database access, retire a failed worker, and never replay SQL automatically.
- Add regression coverage for concurrent requests arriving during worker retirement, shutdown while requests are waiting, and parser failure followed by recovery. Verify with PGlite that parser retirement preserves a transaction's connection, returned rows, commit and rollback while its result is still pending.

## 0.1.6 — 2026-10-19

### Changed

- Run SQL parsing in a reusable worker and terminate it after 30 seconds without pending parse requests, releasing its WASM allocation after use. The next parse starts a new worker; database connections and already executing queries remain independent of parser retirement.
- Keep each driver's parser lifecycle isolated. Shutdown rejects pending parsing and terminates the owned worker; unexpected worker failure fails pending requests before SQL execution and permits a fresh worker on the next request.
- Reuse the driver's worker for `db_explain` preflight and execution, avoiding a second WASM allocation for query planning.
- Preserve PostgreSQL grammar, UTF-8 statement offsets, SQL error positions and guard checks across the worker boundary. Keep worker output out of MCP stdout and avoid inheriting application preloads or credentials into the parser worker.
- Add real-worker regression coverage for concurrent parsing, idle retirement/restart, shutdown and unexpected worker exit.

## 0.1.5 — 2026-10-19

### Changed

- Load the PostgreSQL WASM parser on the first SQL parse instead of allocating its memory at server startup. Concurrent first calls share the parser initialization; SQL validation and guard rules remain in force.
- Load SSH and its crypto runtime only when a tunnel is opened. Direct PostgreSQL connections and idle MCP sessions no longer initialize SSH. Closing a tunnel during module loading prevents a later connection attempt.
- Document idle-memory behavior and direct Node launch as an alternative to a persistent npm wrapper.

## 0.1.4 — 2026-10-19

### Added

- Add **Copy to another client** to each saved entry's config menu. Choose Claude Code,
  Codex, Claude Desktop or Cursor to copy its name, command, arguments and complete
  environment without changing the source or switching the current client.
- Ask before overwriting any same-name destination entry, including another package or
  HTTP transport. The default is No; Esc returns to the destination picker.

### Fixed

- Validate complete TOML before and after edits. Recognize inline/dotted server names,
  quoted keys and multiline values; refuse layouts that cannot be edited without
  changing unrelated settings. Preserve all string environment values when copying.
- Write JSON and TOML configs through a flushed temporary file and a single rename.
  Partial writes and failed commits keep the original; concurrent changes observed
  before committing abort the save. New config files use owner-only permissions.
- Detect destination names even when the entry cannot be listed as a stdio server.
  Reject malformed JSON server maps instead of replacing their contents.
- Replace the complete destination Codex server table when copying, removing stale
  transport options while keeping unrelated settings. Ordinary edits still preserve
  hand-written options.
- Restore the complete previous Claude Code entry if its replacement fails, and report
  recovery failures accurately. Missing-CLI messages no longer print credentials.

### Documentation

- Document the copy menu, overwrite confirmation and copied fields in the README.

### Verification

- Cover cross-client copying, name conflicts, cancellation, EOF, unreadable destinations,
  source preservation, TOML replacement and Claude Code CLI rollback.
- Reproduce multiline-string corruption, missed inline-name collisions, lost env keys,
  partial disk writes, failed renames and concurrent file changes.

## 0.1.3 — 2026-10-19

### Fixed

- Keep connection check results visible in interactive `config` until Enter is pressed,
  instead of immediately redrawing the menu and scrolling the report out of view.
  Esc goes back and Ctrl+C exits; scripted input needs no additional answer.

### Added

- Animate checks in `config` and `--check` with a spinner and elapsed time for each phase:
  the SSH tunnel (when configured) and database connection and response.
  Completed phases remain visible with success or failure markers and colors.
- Fit progress lines to the terminal width, use ASCII on legacy Windows consoles, and
  respect `NO_COLOR`. Redirected output and `TERM=dumb` keep plain reports.

### Documentation

- Include `CHANGELOG.md` in the npm package and document the check display in the README.

### Library API

- `PostgresDriver.check(onProgress?)` can report the `ssh` and `database` phases.

### Verification

- Cover report pauses, cancellation, progress timing and cleanup, narrow terminals, and
  phase transitions on successful and failed checks.
