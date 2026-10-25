# Shared registration and independent MCP packages

The standalone `akms-mcp-db`, `akms-mcp-ssh`, `akms-mcp-wsl` and `akms-mcp-s3`
commands each implement `register`, `config` and `sync`. `akms-mcp` is an optional
settings helper. A child never installs, launches or imports that helper.

## Ownership and flow

- `register` selects user-wide AI services. Selection applies across MCP kinds.
  Discovery lists existing AKMS entries before registration. Apply previews and
  imports unambiguous names in one batch, merging identical old sync copies;
  differing versions stay intact until explicitly reviewed. Import rechecks the
  reviewed source values before any writes. Pending deletions are not reimported.
- `config` always shows that MCP's shared connections and all menu actions.
  Add without registered services shows a Register instruction and returns to
  the menu without opening a form. Saving also rechecks registration under the
  catalog lock, so unregistering during an open form cannot create local-only entries.
- Results summarize successes and group unresolved items by connection.
  Comparisons show differing fields only, with description-only changes called
  out and secret values hidden. Numbered versions identify AKMS as the shared
  saved source and each service as a current source. Choices and confirmation
  identify destinations. Values wrap using terminal column widths, with changed
  non-secret text highlighted; removal/restoration uses separate labels.
  Existing shared items go to Sync; unmanaged
  legacy entries go to Import, with an explicit choice before replacement.
- Interactive screens clear only the visible terminal viewport at navigation
  boundaries. Results and errors wait for Enter or Esc before returning. The
  main menu redraws service selection and a short unresolved-connection count.
  Existing scrollback is not erased. Pipes emit no screen-control codes and
  consume no additional acknowledgement input.
- Connection forms and connection checks belong to each MCP. A virtual
  `ConfigTarget` adapts the existing forms to the shared catalog.
- Saving or removing a connection reconciles it with every registered service.
  Adding a service backfills existing entries; removing one removes only entries
  previously managed by AKMS on that service. The shared catalog is retained.
- The ordinary stdio invocation remains environment-based. With `--catalog`,
  the server reads a startup snapshot without locks or writes; neither mode
  invokes registration or requires a running management process. See the
  [session-server decisions](../../../../../akms/akms.docs/mcp-session-server.md).

## Dedicated server runtime

New managed connections use the Node executable and the runtime package's
`lib/cli.js` path, never an npm/npx wrapper. The dedicated installation prefix is
`<AKMS_MCP_HOME or ~/.akms/mcp>/runtime`, independent of the active Node version.
Discovery computes `<prefix>/node_modules` on Windows and `<prefix>/lib/node_modules`
elsewhere without running npm. Installation passes `--global --prefix <prefix>`.
After the registration guard, Add and standard-launch Edit install
`@akms/mcp-<kind>@latest` only when no valid runtime is present; standard-launch
host-key saves also check before writing. Custom commands keep their launch
settings without requiring the managed runtime. An update failure reports its
cause and continues only if an installed runtime remains discoverable.
Installation is a setup operation; MCP stdio startup never invokes npm.
ManagedSession receives the setup package version as an option.
Add/Edit offer an update (default Yes) when that version is newer than the runtime;
declining keeps the installed version. Linked packages skip update prompts.

Runtime previews a batch conversion of standard npx/binary/old direct launches.
Only command and arguments change; environment values are retained. Version-pinned
npx entries switch to the installed version shown in the preview. Custom wrappers
and extra flags are skipped. Catalog/service snapshots are checked again under the
lock, and ordinary ownership checks preserve external client edits for Sync.
Legacy entries must first be registered/imported. Existing npx launches remain
recognized for migration; clients need a restart or reconnect after conversion.

Runtime discovery validates the package name, bin declaration and script file.
It preserves the Node alias and the package link path; nvm-windows can change
Node versions without losing the package installation. Automatic updates refuse
to replace development links. Build a checkout and link it using
`npm install -g --prefix <runtime> <checkout>`. Moving the Node command path or
AKMS_MCP_HOME requires reapplying current paths from Runtime.
The installer invokes npm's JavaScript CLI directly without a shell; discovery
includes Unix prefix layouts and rejects non-JavaScript version-manager shims.
It runs outside registry locks, has a deadline, and reports installation failure
with the last six npm stderr lines (ANSI stripped), without saving a connection
or falling back to npx.

## Session migration and local schema

Config and the helper menu detect older formats: version 1, or version 2 without
`defaultMode`. A one-line notice and **Migrate registry** action lead to ordered
steps (`v1_to_v2`, then `catalog_default`), a per-kind/per-service preview, and
approval defaulting to No. The preview lists additions, removals after replacement
verification, external settings retained for Sync, missing-runtime work, and
explicit individual-mode rollback choices that remain unchanged.

`Registry.needsMigration()`, `planMigration()`, and `applyMigration(plan)` expose
the same workflow to scripts. Planning performs no writes. Apply checks the
reviewed snapshot and runtime paths again, shares session planning/transitions
with `planSession`/`applySession`, and records all desired changes under one
existing lock before reconciling clients. One previous-revision copy retains the
complete pre-migration state. An unmarked v2 whose active kinds are already
bundled needs only the default marker, with zero client writes. Applying a plan
with no remaining steps does not save, reconcile, or rotate the backup.

Migration converts individual kinds except explicit `sessions[kind].mode:
"individual"` rollback choices. Missing-runtime kinds retain their legacy entries
until Runtime installation and Sync can verify a replacement. The UI runs startup
checks after migration, including connection-prefix coverage. Per-kind Runtime
conversion and rollback remain available.

Runtime can turn the default for new kinds off or on through
`Registry.setDefaultMode("individual" | "catalog")`. Existing explicit choices
remain intact; existing implicit modes are materialized before the default is
changed. Pending runtime setup must finish first. An explicit individual default
is current format too, so disabling the default does not show an older-format
notice. Version 1 and unmarked v2 require migration before changing this default.

Runtime offers **Switch to session server**, with a per-service preview and
confirmation defaulting to No. Each kind has one `akms_<kind>` entry running
`node <runtime cli.js> --catalog`. Its environment is empty at the default
location, or contains only `AKMS_MCP_HOME` for an explicit catalog location.
Register and Import keep existing version 1 files until an explicit migration or
per-kind switch.
New catalogs start at version 2 with `defaultMode: "catalog"`, empty connections
and empty sessions. Register can save service selection without requiring any
runtime; the first Add or import initializes each kind's session launch before
applying client changes. Existing v1 files upgrade only through the confirmed
Runtime switch or registry migration. Older setup packages fail closed before
writing client settings.

When a fresh Register/import finds existing entries but that kind's runtime is
missing, it saves the imported connections and ownership without deleting their
client entries. Results instruct the user to install from Runtime and run Sync.
Sync then persists and verifies the new session launch before removing the old
entries. The ordinary first-Add flow prepares the runtime before saving its form.

Each client session owns its stdio process. Within it, connections of the same
kind share the process and expose `<connection>__<tool>` names. Tool arguments
stay unchanged. Names use ASCII letters, digits, underscores or hyphens and
must fit the complete 64-character client-prefixed tool name: DB 35 characters,
SSH/WSL 30, S3 37. `akms_db`, `akms_ssh`, `akms_wsl`, `akms_s3` are reserved.
`catalog.ts` exports the read-only v1/v2 reader and the tool-name budget. It has
no management imports, tolerates unreadable/invalid files, and returns generic
problems without environment values. Invalid entries are excluded independently.

The confirmed switch preserves saved individual launch commands for rollback,
including custom wrappers. Those wrappers are not run in catalog mode. The
server uses each saved environment to construct a separate lazy connection.
Add/Edit/Remove changes catalog data without rewriting an unchanged session
entry. Removing the last active connection removes that entry; adding one back
recreates it. Clients must reconnect to load the changed snapshot.

**Switch back to per-connection entries** previews the inverse change, restores
individual entries, and removes the session entry only after all replacements
are verified on that service. The schema stays version 2 to prevent older
packages from silently interpreting session bookkeeping as individual mode.

`~/.akms/mcp/registry.json`, or `$AKMS_MCP_HOME/registry.json`, contains:

- `version`: a schema version. Unknown versions fail closed without rewriting.
- `clients`: registered IDs (`claude-code`, `codex`, `claude-desktop`, `cursor`).
- `connections`: globally unique names mapping to `kind`, canonical `entry`
  (`command`, `args`, `env`) and `applied` hashes per service. Client-specific
  fields outside those owned fields remain in the destination configuration.
- A null `entry` is a pending deletion. A deletion created by renaming includes
  `replacement`; the old name is kept on each service until its replacement is
  installed. Pending deletions survive failed writes and CLI restarts.
- Version 2 additionally requires `sessions`, keyed by kind, with `mode`
  (`catalog` or `individual`), the direct launch `entry`, and per-service
  `applied` hashes. An explicit per-kind mode overrides `defaultMode`. New v2
  files use `defaultMode: "catalog"`, including for kinds added later; old v2
  files without this field retain individual mode for kinds without session
  state. Rollback records the explicit individual choice so later saves do not
  switch it back. Missing-runtime kinds may wait without materialized session
  state while their existing client entries remain intact.

The canonical catalog entry contains the complete command, arguments and environment
in plaintext, including passwords, passphrases and S3 static keys/tokens. These
values match client entries in individual mode. After successful session-mode
migration and review of retained external entries, the catalog is the only
active credential location for that kind, plus its previous-revision copy.
SSH key settings retain file paths
and do not copy private-key file contents. Only the separate `applied` bookkeeping
uses hashes. WSL shares this catalog even though its own settings need no password.

New files request POSIX mode 0600 and new directories 0700. Existing POSIX file
modes and directory permissions are preserved, not tightened. On Windows, directory
ACL inheritance controls access; Node's owner/group mode distinction is not
implemented there ([Node file modes](https://nodejs.org/docs/latest-v24.x/api/fs.html#file-modes)).
The default location inherits permissions under the user profile; custom locations
need their parent ACLs checked. No special Windows ACL is installed by this code.

Do not commit, share, copy to another PC, or paste the catalog into chats, issues
or AI conversations; do not ask an agent to print it. Exclude or protect cloud-sync
and shared-backup copies. Prefer SSH keys where possible. If exposed, change
affected passwords or rotate keys/tokens at the provider, then update `config`.
These are operational recommendations because the file is a plaintext credential
copy, not protection implemented by the catalog format.

The SSH local file-tool guard blocks the `.akms/mcp` tree for upload sources and
download destinations. If AKMS_MCP_HOME is available in the server environment,
its exact registry.json and registry.previous.json are also blocked; a custom directory outside `.akms/mcp`
is not protected as a whole. SSH remote paths are limited by allowedPaths and
readonly, without a catalog-specific exclusion. WSL's `/mnt/<drive>/` guard
blocks the default tree and the configured custom registry, but native Linux
paths have no catalog-specific block. Its Windows-local upload/download guard
comes from the installed SSH dependency: the locked 0.1.9 version does not block
the AKMS catalog there. This is a documented limitation, not changed by this work.

Every operation that changes the catalog atomically retains one previous revision
as `registry.previous.json` beside it. The copy uses the source file's mode;
Windows permissions come from the containing directory's ACL. Internal writes
recording applied hashes do not overwrite the pre-operation revision. No-op Sync
does not rotate it. Failure to commit the backup prevents committing a desired-state
edit and beginning that edit's client changes. Sync retries remain resumable
per-service operations rather than transactions across files. This is one
revision, not history.

For recovery, close configuration commands, preserve the current file if needed,
copy `registry.previous.json` over `registry.json`, then reopen setup and review
Sync before reconnecting clients. Recovery does not restore client files itself.
No server automatically falls back to the previous revision. A running session
keeps its snapshot; a new catalog-mode server with a missing or invalid catalog
exposes only the status tool. Credential-free session client entries cannot be
imported to reconstruct lost connections. In individual mode, existing client
entries continue working and Import can rebuild the catalog after registration.

Evidence for the README and CLI statements:

| Statement | Evidence |
|---|---|
| Plaintext values, matching client entries, SSH key paths | `tests/registration-security.test.ts`: `stores complete credential values in plaintext, matching the client, while SSH keys remain paths` (bundled in all five packages); S3 credential fields are read in `src/profile.ts` |
| Default/override location and requested modes | Same suite: `uses the configured catalog directory and requests private creation modes`; actual mode assertions run on POSIX, creation arguments are checked on every platform; Windows ACL evidence is recorded in the isolated validation report |
| Notice appears once and pipe input remains usable | Same suite: `shows the privacy notice once across repeated Apply reviews in plain piped input`, `does not repeat the privacy notice while only selecting services`; each package's `tests/catalog-help.test.ts` checks plain help output |
| Individual entries survive deletion; catalog sessions require recovery | `registration-security.test.ts` covers individual-mode Import; `registration-session.test.ts` covers previous-revision recovery; each server's `catalog-server.test.ts` covers empty/invalid catalogs |
| SSH and WSL transfer scope, including custom paths and dependency limits | Respective `tests/catalog-transfer-security.test.ts` files exercise actual local tool handlers with mocked transfer I/O and the remote/distro path guards |
| Handling advice | Recommendations based on plaintext storage and the verified guard limitations; they do not claim encryption, automatic backup exclusion or provider-side credential rotation |

## Post-save startup check and Updates

Add/Edit checks the saved entry when its command, arguments or environment changed.
Runtime conversion checks the converted entries; Updates checks saved entries of each
successfully updated kind. The checker starts the exact command and argument array
with `shell: false`, using the normal minimal client environment plus the saved env.
It follows the [MCP stdio lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle):
initialize, initialized notification, tools/list (including pagination), then stdin EOF.
It accepts any string protocol version and never sends tools/call. The total handshake deadline is 10 seconds; bounded cleanup
terminates a child that ignores EOF, including its process tree on Windows or process
group on POSIX. This checks process/protocol readiness, not remote connectivity.

Identical command/argument/environment values share one launch within a batch, while
each connection name gets a result. Diagnostics use the comparison's visible-field
allowlist: remaining env values and arguments are masked, including URL passwords.
The standard runtime's first `cli.js` argument remains visible; spawn errors
include the command path. Catalog checks use one bundle launch and require at
least one tool prefixed by every active connection name. Diagnostic masking
also includes those connections' credentials even though the launch env is empty.
Output is bounded; failures show the exit code when available and the last six stderr
lines. Failed checks leave the catalog and applied settings in place and tell users
to fix them before reconnecting clients. Piped input needs no extra response.

Updates is available in the helper and each config menu. Only entering this screen
or choosing Refresh queries npm; each `npm view` has a six-second outer deadline,
fresh metadata preference, no fetch retries and a four-second fetch timeout. Failed
queries display Unavailable. The screen shows installed/latest versions and current,
update-available, missing, linked-development or unavailable status. It updates one
runtime or all installed outdated runtimes sequentially, preserving development links.
Missing runtimes can be installed individually. WSL is shown only on Windows; helper
self-update is outside this flow. Installation uses the existing dedicated prefix.
Failures containing EBUSY, EPERM or EACCES advise closing AI clients and retrying
because a running runtime may hold files open.

`registration-startup.test.ts` exercises real fixture processes, missing paths,
timeouts, exit, masking, deduplication and plain output. `registration-updates.test.ts`
covers statuses, on-demand lookup, offline/invalid/timeout npm responses, individual
and bulk actions, development links, WSL filtering and post-update checks. Package
`registration-command.test.ts` checks saved custom entries even when startup fails;
`registration-runtime.test.ts` checks deduplicated migration. Registration removal
defaults to No (addition remains Yes), covered by `registration-security.test.ts`.

## Reconciliation and concurrent editing

An exclusive PID lock serializes catalog changes across packages. A dead owner's
lock can be reclaimed; an active owner makes a second writer stop and retry.
Desired state is saved before client changes, and applied state is recorded
after each verified write. Success on one service remains valid when another
fails. This is a resumable operation, not an atomic transaction across clients.
Session migration installs and verifies the bundle before removing managed
individual entries on each service. Rollback verifies all individual entries
before removing its bundle. External edits block their own replacement/removal
and stay visible in Sync. Sync can restore the AKMS session launch; it cannot
import an arbitrary external session launch as a connection. Retained external
individual settings can be imported into the catalog before removing that entry.

For each owned entry, compare the current destination fields against the last
applied hash and desired hash. External edits and unmanaged conflicting names
require review; unsupported HTTP entries and different servers are not replaced.
Sync can explicitly reapply the shared version or import a changed service's
version. Import and resolution recheck the reviewed value before applying.
Shared forms and registration also detect stale edits from another command.

The existing adapters preserve unrelated entries. JSON/TOML writes stage an
adjacent file and replace the destination; TOML is validated before and after
editing. Claude Code uses its CLI. Changes are read back before being counted as
applied. Client reload/restart is separate from successful configuration writes.

## Distribution and maintenance

Each repository includes `src/modules/registration` in its own CLI bundle.
There is no new shared npm package to publish first and no cross-repository
runtime or build import. The DB checkout maintains the common `types.ts`,
`registry.ts`, `menu.ts`, `comparison.ts`, `config-file.ts`, `runtime.ts`,
`runtime-menu.ts`, `startup-check.ts`, `updates-menu.ts`, `migration-menu.ts` and `catalog.ts`; run
`node scripts/sync-registration.mjs` there to copy reviewed changes to sibling
checkouts. The prompter shim points to the local package's UI implementation.
This script is a development convenience, not part of building or running an
individual package.

`registration.test.ts` covers multi-service writes, migration, drift, failed
writes/deletions, chained renames, stale forms, version guards and locking.
Each server also has `registration-command.test.ts` exercising its public
management flow and its own CLI with isolated local files. The helper tests
cover persistent selection and handing terminal input to a child.
`registration-runtime.test.ts` covers discovery, batch conversion, custom commands,
stale reviews, external edits, first installation and protection of development
links. Tests inject temporary runtimes or a fake npm CLI; they do not install
packages globally or change the user's client configuration.
`registration-session.test.ts` covers v1 migration/rollback, previous revisions,
backup failures, default/custom paths, service changes, external edits, replacement
ordering, stale reviews, name budgets and missing connection-tool diagnostics.
`registration-migration.test.ts` covers ordered full-registry migration, marker-only
v2 application with zero client writes, rollback choices, missing runtimes,
external edits, stale plans, exact previous revision, repeated no-op application,
default-No preview and Runtime defaults. Helper menu tests cover the entry point.

The helper still resolves child releases from npm. Compatible child releases
must be published before its package routes provide the new flow to installed
users; local validation uses each checkout's built CLI. This change does not
publish any package.
