# Development

## Release guard and package order

Run `npm run prepublishOnly` to inspect every publish prerequisite without publishing. `npm publish` runs the same `node scripts/release-guard.mjs` gate. It requires a clean `git status --porcelain`, a package version newer than the configured registry's `latest`, matching `SERVER_VERSION` (servers only), and five registration copies matching the DB baseline. Metadata uses a fresh temporary cache. Any lookup failure, including E404, or a missing `latest` tag blocks release. All five sibling checkouts are needed for release comparison; normal builds and installed packages do not need them.

The DB registration directory is the baseline. Run `node scripts/sync-registration.mjs` from the DB checkout after common changes. The launcher keeps its own adapters and its `prompter.ts` import is adjusted for `launcher/prompter`. Keep the five development-only `scripts/release-guard.mjs` copies identical.

Release in this order:

1. Publish `@akms/mcp-ssh` with AKMS registry protection first, after its tests, build, package inspection, reviewed commit and release gate pass.
2. Raise `@akms/mcp-wsl`'s SSH dependency minimum to that published protected release, remove ranges permitting SSH 0.1.9, and refresh its lockfile and local dependency. WSL's release gate calls the installed SSH guard against `.akms/mcp` reads and writes; the current SSH 0.1.9 must fail, regardless of the WSL version.
3. Validate and publish WSL, then the DB and S3 servers. Align each manifest, lockfile and `SERVER_VERSION`, synchronize registration, and commit reviewed release changes before running the gate.
4. Publish the optional `@akms/mcp` launcher last, once every child can be installed from npm.

The guard never commits, installs dependencies or publishes. `npm pack --dry-run` inspects contents without invoking this publish-only gate.

Use Node.js 22+ and npm. Run `npm ci`, `npm run build` and `npm test` from this checkout.

## Link the development runtime

The server installation is independent of the active Node version: `<AKMS_MCP_HOME or ~/.akms/mcp>/runtime`. After building the checkout, use npm's global layout with this explicit prefix; a plain `npm link` in the default Node prefix is not discovered as the managed runtime.

From this checkout in PowerShell:

```powershell
npm run build
$akmsRuntime = if ($env:AKMS_MCP_HOME) { Join-Path $env:AKMS_MCP_HOME "runtime" } else { Join-Path $env:USERPROFILE ".akms/mcp/runtime" }
npm install --global --prefix $akmsRuntime .
node lib/cli.js config
```

For macOS/Linux, use `npm install --global --prefix "${AKMS_MCP_HOME:-$HOME/.akms/mcp}/runtime" "$PWD"` after building (supported by this package). The package is linked into the prefix without moving the source checkout. Runtime shows **linked development checkout**, hides Update and skips version-update prompts. Rebuild the source to change the running code, then reconnect AI clients. Use Runtime > Use for existing connections to migrate older npm/npx launch paths.

## Session-server compatibility

Setup reads registry versions 1 and 2. New catalogs start at version 2 with `defaultMode: "catalog"`; their first connection of each kind creates its session launch. Existing version 1 catalogs require the confirmed Runtime switch. Existing version 2 catalogs without `defaultMode` retain individual mode for kinds without explicit session state. Per-kind choices override the default, and rollback keeps version 2 so older setup cannot recreate individual entries. Server `--catalog` readers accept both versions without locks or writes. The common `catalog.ts` has no dependency on setup or the optional helper. Include it in the five-copy release comparison. `registration-session.test.ts` covers migration/rollback, backup failure, name budgets, external edits, replacement ordering and bundle startup coverage.

During active MCP development, build a disposable source copy and validate it before replacing live `lib` files. The normal build removes `lib`; running it beneath a connected MCP can break active sessions.

Registry migrations are ordered in `registry.ts`: `v1_to_v2`, then `catalog_default`. `needsMigration`, `planMigration`, and `applyMigration` support scripted review/application; the plan is rechecked under the normal lock. Session planning and state transitions are shared with `planSession`/`applySession`, while one outer mutation preserves the pre-migration backup. `setDefaultMode("individual")` and `setDefaultMode("catalog")` change only the future-kind default after migration. An explicit individual marker remains current format. `registration-migration.test.ts` covers migration, no-op repetition, backup, stale plans, external edits, missing runtimes, rollback preservation and menu approval. Include `migration-menu.ts` in common-file synchronization.
