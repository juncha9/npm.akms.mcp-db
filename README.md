# @akms/mcp-db

MCP server that lets an AI agent query **one pre-registered database** — directly, or through an **SSH tunnel it opens itself** — behind a guard that reads every statement with the real PostgreSQL parser.

Built because the database we needed to reach (RDS, not publicly accessible) sits behind a bastion, and the MCP server we used could neither tunnel nor tell `DELETE FROM users` from `DELETE FROM users WHERE id = 1`. The design record, with the measurements behind each choice, is [DESIGN.md](DESIGN.md) in the repository.

Use **session server mode** to share one process among this kind's connections in each client session. Each connection keeps its own target, credentials and policy; its tool names carry the connection prefix. The environment-based examples below describe individual mode. See [Session server mode](#session-server-mode).

## 📦 Installation

```bash
npm install -g @akms/mcp-db@latest   # installs the `akms-mcp-db` command
akms-mcp-db --help
```

Node ≥ 22. PostgreSQL 12 or later, only PostgreSQL for now.

## Upgrading from 0.2.x

Open the current setup with `npx -y --prefer-online @akms/mcp@latest`, install this runtime from **Runtime**, then use **Register > Apply registration** to import existing entries. Compare differing descriptions when prompted, or use **Import existing connections** later.

If you register before installing the runtime, existing entries are kept in a normal pending state. Install the runtime, run **Sync**, then restart or reconnect your client and check `db_catalog_status`.

See the launcher's [full upgrade guide](https://github.com/juncha9/npm.akms.mcp/blob/main/README.md#upgrading-from-02x) for the comparison steps, Codex thread cleanup, rollback and **Migrate registry** for older development catalogs.

## Minimum working configuration

Install the server from **Runtime** before using these manual examples. On Windows its script is `<AKMS_MCP_HOME or ~/.akms/mcp>/runtime/node_modules/@akms/mcp-db/lib/cli.js`; on macOS/Linux insert `lib/` before `node_modules`. Replace the placeholder below with that absolute path. Use the Node executable from `node -p "process.execPath"` as `command`. The `config` command writes both paths for you.

For a direct PostgreSQL connection with password authentication, use this MCP client entry. Replace the host, database, user and password with an existing, reachable database and its credentials. This example uses port `5432` and requires the database to support TLS (the default `DB_SSL=require`).

```json
{
    "mcpServers": {
        "db": {
            "command": "node",
            "args": ["/absolute/akms/mcp/runtime/node_modules/@akms/mcp-db/lib/cli.js"],
            "env": {
                "DB_DRIVER": "postgres",
                "DB_HOST": "db.example.com",
                "DB_NAME": "app",
                "DB_USER": "app_user",
                "DB_PASSWORD": "your-database-password"
            }
        }
    }
}
```

Required split fields are `DB_DRIVER`, `DB_HOST`, `DB_NAME` and `DB_USER`. Supply `DB_PASSWORD` when the database requires password authentication. `DB_PORT` is optional; set it only for a non-default port. For a local database without TLS, add `"DB_SSL": "off"`. SSH tunnel settings are unnecessary for a direct connection. Writes are allowed by default; add `"DB_READONLY": "true"` for a read-only entry.

If you already have a connection URL, replace the entire `env` block with:

```json
{
    "DB_DRIVER": "postgres",
    "DB_URL": "postgres://app_user:your-database-password@db.example.com:5432/app?sslmode=require"
}
```

Keep `DB_DRIVER` with `DB_URL`, and percent-encode reserved characters in the URL's user/password. Do not combine `DB_URL` with the split connection fields.

The full JSON example fits an MCP client's `mcpServers` configuration, such as a project `.mcp.json` or Cursor's `mcp.json`. The direct Node command also works on Windows. For Codex TOML, open Register from `akms-mcp-db config --target codex` (or choose another client below).

## ⚙️ MCP client setup

Register the AI services you use once, then manage connections in one shared list. **This package works independently; installing or running `@akms/mcp` is optional.**

```sh
akms-mcp-db register   # toggle services, then Apply registration
akms-mcp-db config     # add, edit, check, print or remove connections
akms-mcp-db sync       # review differences and retry pending changes
```

### AKMS runtime and existing connections

Managed connections start Node directly using a dedicated installation at `<AKMS_MCP_HOME or ~/.akms/mcp>/runtime`. This directory is independent of Node version managers. The setup CLI may be installed globally as above or opened once with `npx -y @akms/mcp-db@latest config`; it is separate from the server runtime saved in client settings.

Before Add or a standard-launch Edit, setup installs a missing runtime with `npm install --global --prefix "<AKMS runtime directory>" --prefer-online --no-fund --no-audit @akms/mcp-db@latest`. If the installed version is older than this setup package, it offers an update (default Yes); declining continues with the installed version. Linked development packages skip this prompt. Host-key saves for standard launches also check the runtime before writing. Custom launch commands keep their existing command and require no managed-runtime installation. If an update fails but an installed runtime is still usable, setup reports the error and continues with that version. Servers do not invoke npm or query updates when AI clients connect.

For an existing catalog that still uses individual entries, open `akms-mcp-db config`, choose **Runtime**, install the runtime if needed, then choose **Use for existing connections**. Both legacy npx entries and direct paths in ordinary global installations can be converted. Review and apply the list, then **restart or reconnect the AI clients** to replace running processes. Connection values and credentials stay intact; custom commands and external client edits are preserved for individual review. Register/import legacy entries first if they are missing from the shared list. Version-pinned npx entries switch to the installed version shown in the preview.

**Runtime > Update runtime installation** explicitly installs the latest release into this same directory. The Node executable keeps its existing alias path, allowing nvm-windows to switch Node versions while the package path stays fixed. If the Node command path or `AKMS_MCP_HOME` moves, reapply current paths from Runtime. Removing the runtime directory breaks entries that use it.

For development, build the checkout and link it with `npm install -g --prefix "<AKMS runtime directory>" "<checkout path>"`. Linked packages retain the runtime alias path; automatic updates do not overwrite the checkout link. See [README_DEV.md](README_DEV.md). `@akms/mcp` remains optional.

`config` always shows the connection menu, including Add, Register, Sync, Import and Runtime. With no registered services, Add displays a message asking you to open Register and returns to the menu without opening a form or changing settings. Claude Code, Codex, Claude Desktop and Cursor are supported; Enter toggles each service and Apply saves the selection. `--target codex` preselects Codex in Register; it does not restrict subsequent saves to Codex.

On an interactive terminal, connection menus, registration and comparisons use separate screens. Results and errors stay visible until Enter or Esc; returning to the menu shows current services and any connections needing attention. Piped commands keep plain output and need no extra answers. Sync labels the saved AKMS version and the current service version separately. Numbered choices show which service receives a value or whether it becomes the AKMS value for all registered services. Long values wrap, changed text is highlighted, and confirmation names the destinations.

Service selection is shared across the AKMS packages. Every saved connection is applied to all registered services, and a newly registered service receives existing shared connections. Unregistering removes only entries managed by AKMS from that service and retains the shared catalog. Restart or reconnect the MCP client to load changed settings.

### Startup checks and updates

After saving a changed connection, applying Runtime launch commands, or updating from **Updates**, setup starts each distinct saved command once without shell interpolation. It sends MCP `initialize` and `tools/list`, then closes stdin; it does not invoke database, SSH, WSL or S3 tools. The check takes at most about 10 seconds per entry, plus bounded process cleanup. Results show the server version and tool count, or the exit code and masked stderr tail. Standard runtime script paths and spawn command paths stay visible for diagnosis. Session checks also verify a tool-name prefix for every saved connection. A failed check keeps the saved settings: fix it before restarting or reconnecting AI clients. Identical command/arguments/environment values share one check.

Open **Updates** in the launcher or any package config menu to see installed and latest published runtime versions. Version lookup runs only when this screen opens or **Refresh versions** is chosen, with a short timeout; offline results show **Unavailable**. Update one runtime or all installed runtimes with newer releases; missing runtimes can be installed individually. Development links are displayed but never updated, and WSL is listed only on Windows. Updates use the same dedicated AKMS runtime directory and check that kind's saved connections afterward. Reconnect your AI clients to use the new runtime. The helper itself is not updated here.

Register confirmation defaults to **No** when deselecting a previously registered service; otherwise it defaults to **Yes**.

### Session server mode

New catalogs start in version 2 with session mode enabled. Register your AI services, then add connections; setup creates each kind's session entry automatically. Existing version 1 catalogs keep individual mode until you approve **Migrate registry** or a per-kind **Runtime > Switch to session server** conversion (default No). Register/import their existing connections first. Each registered AI service gets one `akms_db`, `akms_ssh`, `akms_wsl` or `akms_s3` entry for that kind, running Node directly with `--catalog`. The helper package is optional. A client session still owns its own stdio process; connections of the same kind share that process.

The server reads its connections from the shared catalog at startup. Tools include the connection name, for example `production__db_query`; their arguments stay unchanged. Add/Edit/Remove updates the catalog; reconnect your clients to load changes. Removing the last connection removes the session entry. An invalid connection is excluded while valid ones remain available; `<kind>_catalog_status` reports the loaded/excluded names without credentials. No database, SSH, WSL or S3 connection opens just to list tools.

Converting an existing version 1 catalog upgrades it to version 2 and keeps the previous revision. Older setup packages stop without modifying version 2. New kinds in a new catalog also default to sessions; each kind's explicit rollback choice is retained. AKMS removes managed individual entries only after verifying the session entry; external edits stay for **Sync** review. Custom launch commands are retained in the catalog for rollback but are not executed in session mode.

**Runtime > Switch back to per-connection entries** previews and restores the saved individual entries, including their credentials and launch commands. It removes the session entry after the replacements are verified. The registry stays version 2. **Reapply session launch command** updates paths after moving Node or the runtime. Restart/reconnect clients after either change.

Connection names use ASCII letters, digits, underscores or hyphens: DB up to 35 characters, SSH/WSL 30, S3 37. The four `akms_<kind>` names are reserved. These limits keep client-prefixed tool names within 64 characters; rename longer legacy entries before conversion.

### Migrate an older registry

When a version 1 registry or a version 2 registry without a default-mode marker is opened, the helper and each config menu show **Registry update available** and **Migrate registry**. Select it to review the ordered format steps, every kind's current layout, per-service additions/removals, and settings kept for Sync. Approval defaults to **No**.

Migration upgrades v1 to v2, records `defaultMode: "catalog"`, and converts individual kinds through the existing session conversion rules. Kinds explicitly switched back to individual entries keep that choice. Already bundled kinds keep their launch commands; an unmarked v2 containing only bundles receives the marker without client-file changes. Missing runtimes leave existing entries in place for **Runtime** installation and **Sync**. Startup checks verify the affected session tools after approval.

One `registry.previous.json` revision covers the whole migration. Repeating migration on a current registry does nothing. Runtime still offers per-kind conversion and rollback. **Runtime > Use individual entries for new kinds** turns the future-kind default off, and **Start new kinds as session servers** turns it back on; existing kinds retain their modes. The explicit `individual` default is also current format, so turning it off does not trigger another migration notice.

### Catalog security

The shared catalog is `~/.akms/mcp/registry.json`, or `$AKMS_MCP_HOME/registry.json`. It contains complete connection settings, including passwords and secret values **in plaintext**. In individual mode these values also appear in AI client entries. After successful session-mode conversion and resolution of any retained legacy entries, the catalog is the only active location for that kind's connection credentials; one previous-revision copy also contains them. DB secrets include DB_PASSWORD, credentials inside DB_URL, DB_SSH_PASSWORD and DB_SSH_PASSPHRASE. SSH private-key settings store file paths, not the key files themselves.

On POSIX, new catalog files request mode `0600` and new catalog directories `0700`; existing permissions are not tightened. Windows uses inherited parent-directory ACLs (normally the user profile), not POSIX owner/group modes. Check access permissions when choosing a custom location.

Keep both catalog files private: do not commit it, share it, copy it to another person or PC, paste its contents into chats/issues/AI conversations, or ask an AI agent to print it. Exclude it from cloud sync and shared backups, or protect those copies. Prefer SSH key authentication over passwords where possible. If exposed, change the affected passwords or rotate the affected keys/tokens, then update the connections through `config`.

SSH blocks local uploads from and downloads into `.akms/mcp`. A custom `AKMS_MCP_HOME` outside that path is not protected as a whole: its `registry.json` and `registry.previous.json` are additionally blocked when the SSH process has that environment variable. Remote SSH paths have no catalog-specific block. WSL protects these paths through `/mnt/<drive>/`; native Linux paths have no catalog-specific block, and local Windows transfers depend on the installed SSH guard. The locked SSH 0.1.9 dependency does not block the catalog in those local transfers. Do not rely on these guards to keep the file private.

Each successful catalog-changing operation atomically keeps one previous revision as **`registry.previous.json`** in the same directory. Internal application bookkeeping does not replace that pre-operation revision, and a no-op Sync leaves it unchanged. The copy requests the catalog's existing file permissions; Windows uses inherited ACLs. This is one revision, not a history.

To recover, close configuration commands, preserve the current file if needed, and copy `registry.previous.json` over `registry.json` in that directory. Then reopen setup, review **Sync**, and reconnect clients. Recovery does not automatically revert client files.

A running session keeps its startup snapshot. If `registry.json` is missing or invalid, a newly started session exposes only its status tool; its empty client entry cannot reconstruct credentials through Import. Restore the previous revision or enter the connections again. Individual mode still uses each entry's environment, so its existing client entries keep working and can be imported after registering services again.

Each standalone package manages this versioned file directly and does not call the optional helper.

Register shows existing AKMS entry counts even before registration. Applying registration automatically imports existing connections whose versions match, merging identical copies into one shared item. In session mode, it replaces owned individual entries after verifying the session launch. If a runtime is missing, the existing entries stay in place: install it from Runtime, then run Sync. Differing versions remain intact for review. Results summarize completed connections and list only items needing attention. The comparison shows changed fields, labels description-only differences, and keeps secrets hidden. Use **Import existing connections** to review differences later or import all remaining matching entries together. When versions differ, review the masked settings and choose which version to apply, or give the imported connection another name to keep both. The menu shows per-connection application counts. Failed writes keep the saved values and successful service updates; **Sync** retries pending changes and offers explicit choices for external edits. Unrelated or conflicting unmanaged entries are preserved.

Codex configs are validated before and after editing. Inline/dotted server definitions
are recognized, but automatic edits require the `[mcp_servers.<name>]` table layout;
unsupported edits are rejected without changing the file. JSON and TOML saves use a
temporary file so a failed write or commit preserves the previous config.

On a terminal, checks in `config` and `--check` show animated progress, elapsed time and
completed phases. After a check in `config`, **press Enter to continue**; Esc goes back and
Ctrl+C exits. Redirected output stays plain and scripted input needs no extra answer.
Release notes are in [CHANGELOG.md](CHANGELOG.md).

| Client | Config file | How it is written |
|---|---|---|
| Claude Code | `~/.claude.json` (user scope) | through `claude mcp add-json … -s user`, never by editing the file |
| Codex | `$CODEX_HOME/config.toml` (defaults to `~/.codex/config.toml`) | only the `[mcp_servers.<name>]` tables are rewritten; keys you added to them stay |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers.<name>` is set, every other key kept |
| Cursor | `~/.cursor/mcp.json` | same |

Only entries that launch this package are listed for management. An edit keeps every `DB_*` variable the form does not ask about (`DB_ALIAS`, deny patterns, timeouts, row limits, …). The connection is always written as the split variables — an entry that uses `DB_URL` is read into the form and rewritten without it. **Print** shows an entry as JSON, as a Codex TOML table and as a `claude mcp add-json` line, for when pasting is easier. Entries use the absolute Node executable and the script in the AKMS runtime directory on every platform.

**Or by hand — one server entry per database** — plain `DB_*` variables, no separate server-side config file. The server name (`pg_aws_akms` below) is what the agent sees in its tool list, so name it after the database.

```json
{
    "mcpServers": {
        "pg_aws_akms": {
            "command": "node",
            "args": ["/absolute/akms/mcp/runtime/node_modules/@akms/mcp-db/lib/cli.js"],
            "env": {
                "DB_DRIVER": "postgres",
                "DB_HOST": "mydb.xxxx.ap-northeast-2.rds.amazonaws.com",
                "DB_PORT": "15432", "DB_NAME": "akms", "DB_USER": "app_user", "DB_PASSWORD": "…",
                "DB_SSH_HOST": "203.0.113.5", "DB_SSH_PORT": "20022", "DB_SSH_USER": "ubuntu",
                "DB_SSH_KEY": "~/.ssh/bastion.pem",
                "DB_SSH_HOST_KEY": "SHA256:…"
            }
        }
    }
}
```

With `DB_SSH_*` set, the database host is **resolved on the SSH server** — a private name like an RDS endpoint works. Without them the connection is direct. Coming from a URL-based server, `DB_URL` takes the whole `postgres://user:password@host:port/database?sslmode=…` instead of the five split variables (not both).

The server speaks MCP over **stdio**: stdout carries JSON-RPC, every log line goes to stderr. When the client goes away — stdin ends, or the process is simply gone — the server shuts down on its own and exits within a few seconds even if the database or the tunnel no longer answers; a stderr nobody reads is never a reason to stay. Its log says `mcp server ready on stdio` with its `pid`, for when one has to be found among a client's processes.

### Check it before wiring it up

```bash
akms-mcp-db --check
```

```
Checking aws_akms  →  postgres app_user@mydb…:15432/akms via ssh ubuntu@203.0.113.5:20022

  OK      ssh  ubuntu@203.0.113.5:20022  (key ~/.ssh/bastion.pem, 195ms)
          host key SHA256:nkJn…  (not pinned — set DB_SSH_HOST_KEY to it to detect a changed key)
  OK      db   PostgreSQL 18.6 · akms as app_user · ssl on · statement_timeout 1min  (1184ms)
```

Each hop on its own line, so a setup mistake is not mistaken for a policy rejection later. Exit code 0 when both succeed. The same report runs behind **Test the connection** in `config`, so a database that passes setup passes `--check`.

## 🗂️ Configuration

### Connection

| Variable | Description |
|---|---|
| `DB_DRIVER` ✅ | `postgres` |
| `DB_HOST` · `DB_NAME` · `DB_USER` ✅ | Where and as whom |
| `DB_PORT` · `DB_PASSWORD` | Port defaults to 5432 |
| `DB_URL` | All of the above in one URL. Setting it together with any of them fails startup, and so does any URL parameter but `sslmode` (`options`, `sslrootcert`, … would otherwise be dropped silently) |
| `DB_SSL` | `require` (encrypt, don't check the certificate) · `verify` · `off`. **Default `require`, through a tunnel too** — RDS refuses an unencrypted session even from inside its VPC |
| `DB_SSL_CA` | CA bundle for `verify` (the RDS bundle is not in Node's default store). Setting it without `DB_SSL=verify` fails startup — it would be ignored — and so does a path that does not exist |
| `DB_ALIAS` · `DB_DESCRIPTION` | Shown to the agent; alias defaults to `<database>@<host>` |

### SSH tunnel

| Variable | Description |
|---|---|
| `DB_SSH_HOST` · `DB_SSH_USER` | Turns the tunnel on |
| `DB_SSH_PORT` | Default 22 |
| `DB_SSH_KEY` · `DB_SSH_PASSPHRASE` | Private key **path** (`~` expanded) |
| `DB_SSH_PASSWORD` | When no key is used |
| `DB_SSH_HOST_KEY` | Pin the server's key, `SHA256:…` — `--check` prints it |

Authentication order: key file, password, then the SSH agent. A `DB_SSH_*` detail without `DB_SSH_HOST` fails startup rather than silently connecting direct.

No local port is opened: each database connection rides its own SSH channel, handed straight to the PostgreSQL driver. Nothing else on the machine can use the tunnel, and two servers never fight over a port. A dropped SSH connection is reopened on the next query.

### Policy

| Variable | Default | Effect |
|---|---|---|
| `DB_READONLY` | `false` | Only `SELECT` / `VALUES` / `TABLE` / `SHOW` / `EXPLAIN`, and every call runs in `BEGIN READ ONLY … ROLLBACK` — so a write hidden in a function is stopped by the server too. Functions whose effect lands outside the transaction are refused as well (`pg_terminate_backend`, `pg_cancel_backend`, replication-slot and `pg_stat_reset*` functions, `dblink*`, `lo_export`, …), and `set_config` of `statement_timeout` / `transaction_timeout` — any other `set_config` is fine, the closing `ROLLBACK` undoes it |
| `DB_ALLOW_DDL` | `true` | `false` refuses CREATE / ALTER / DROP / GRANT / COMMENT / REASSIGN OWNED …, and the tables `SELECT … INTO` and `EXPLAIN ANALYZE CREATE TABLE … AS` would create |
| `DB_DENY_PATTERNS` | — | Regexes, case-insensitive, tested against each statement as written. Comma-separated, or a JSON array (`["\\bdrop\\s{1,3}table", "secrets"]`) when a pattern contains a comma — the value is read as JSON when it parses as JSON or opens like one (`["…",` or `["…"]`), otherwise as a comma list (so a regex starting with a class like `["']` still works), where an entry with unbalanced brackets fails startup. As JSON it must be a valid array of strings, and a `\b` written with one backslash — JSON's backspace, a pattern that never matches — fails startup. Not applied to the SQL the tools write themselves (catalog queries, `db_explain`'s `EXPLAIN` wrapper) |
| `DB_STATEMENT_TIMEOUT_MS` | `60000` | `statement_timeout`, set at connect and again in every call — the **server** stops the query, even behind a pooler that drops startup parameters |
| `DB_CONNECT_TIMEOUT_MS` | `20000` | SSH and database handshakes, each — and the longest a call waits for a free connection (the pool holds two) |
| `DB_MAX_ROWS` | `500` | Rows read per statement. A cursor stops there, so a huge table never lands in memory |
| `DB_MAX_OUTPUT` | `100000` | Characters of rendered output, errors included; at least 2000 — the server text quoted in one error (message, hint, detail, where together) can take 1000, and the rest must hold the outcome line and the headings of whatever was committed before the failure. Every statement keeps its heading line. Results are kept whole smallest first — a count after a wide listing still shows — and the largest are cut, each saying how many rows or notices it leaves out (with very many statements, one line counts them all). When even the headings do not fit, runs of statements fold into one range line each (`[3–200] CREATE · 198 statements · DDL · 1–3 ms each`), so every statement stays accounted for |
| `DB_MCP_LOG_LEVEL` | `info` | `silent` · `debug` · `info` · `warn` · `error`, to stderr |

Defaults are permissive on purpose — a guard that blocks real work gets switched off wholesale. Make a production entry `DB_READONLY=true` and let write access be the deliberate exception.

A malformed value fails startup: `DB_READONLY=ture` is an error, not "writable"; so is a port outside 1–65535 or a timeout past 2³¹−1 ms, and so is a misspelled policy or TLS name (`DB_READ_ONLY`, or `db_readonly` on a case-sensitive system — "did you mean `DB_READONLY`?") that would otherwise leave the permissive default in place. A `DB_*` name close only to a connection variable is logged and ignored — another program's `DB_POOL` or `DB_HOST_REPLICA` in an inherited environment does not stop the server, and a wrong connection shows itself anyway. Errors about `DB_URL` never repeat it — it holds the password. Passwords are taken as written, surrounding spaces included.

## 🧰 Tools

| Tool | Purpose |
|---|---|
| `db_list_hosts` | The database, the route to it, and the policy. No credentials |
| `db_query` | Run SQL — one or several statements, optional `params` (`$1`, `$2`, … with a single statement; pass bigint ids and exact decimals as strings), optional `transaction: false` |
| `db_schemas` | Schemas with owner and table / view / sequence counts |
| `db_tables` | One schema's tables, views, sequences (approx rows, size, comment) and its enum / domain / composite types. A partitioned table shows its partitions' total size and rows |
| `db_describe` | Columns, constraints, foreign keys pointing in, indexes with size and scan count since the statistics were last reset (an `INVALID` one marked, with what to do about it; a standby counts its own scans), triggers, partitions and `INHERITS` children, a sequence's settings, view definition |
| `db_explain` | The plan of one statement (send it without `EXPLAIN`); `analyze: true` runs it inside a transaction that is always rolled back. A prepared statement does not outlive its call — send its own SQL, with the values in `params` and its declared parameter types as casts (`$1::numeric`) |

The catalog tools read a name as SQL does — `"MixedCase"` in double quotes, an unquoted name folded to lower case (then, failing that, tried as typed), each argument by its own quotes — and print every name the way SQL has to write it: schemas, tables, columns, types, constraints, indexes, quoted where needed and schema-qualified where they name another table (partitions, parents, a sequence's owner, foreign keys pointing in). A name with no schema is looked up on the session's `search_path`, as SQL does — so a table named without its schema inside a printed definition (a foreign key, a trigger) resolves to the same object. A copied name means the same object in a query. When the same spelling also names another schema or table (`"Users"` beside `users`), a note says so. A separate `schema` argument is one name, dots included.

Rows come back as **one JSON object per line**. Dates, times, timestamps, intervals and `bytea` stay as the server's text — `pg` would otherwise turn a `timestamp` without time zone into a local-time `Date` that JSON shifts to UTC. `bigint`, `numeric` and `numeric[]` are strings, so no precision is lost; a float `NaN` / `Infinity` stays text instead of turning into `null`; in a `json` / `jsonb` value, a number a double cannot hold exactly (an id past 2⁵³, `1e-400`) is written with the server's own digits, and the value stays an object or array. A value nested deeper than about 2,000 levels comes back whole as the server's text. A repeated column name gets a `#2` suffix instead of overwriting the first. The server's `NOTICE` / `WARNING` lines are shown under the statement that raised them — a failed statement's too, since a procedure's progress lines tell what it committed (up to 20 per statement, each cut at 500 characters).

**Past the row limit:** a `SELECT` stops reading one row past it (read to tell there are more), but a function in its select list may have run for more rows than are shown — up to every row read, when its value feeds a sort, `DISTINCT`, `GROUP BY`, an aggregate or a set operation, or comes from a `WITH` or subquery that is sorted, grouped or joined. Side effects belong in a write with `RETURNING`, not in a `SELECT`. An `INSERT` / `UPDATE` / `DELETE` / `MERGE … RETURNING` has already run in full; its output says how many rows it affected and how many of the returned rows are shown. A `SELECT` whose `WITH` writes runs in full as well, outer query included. `EXECUTE` and `SHOW` run in full; only their listing is cut. A long `EXPLAIN` plan is cut the same way — without `ANALYZE` the explained statement does not run.

### Transactions

| Call | What happens |
|---|---|
| `db_query` (default) | All statements in **one transaction** — committed together, or all rolled back; the error names the statement that failed. A failing `COMMIT` (a deferred constraint) is reported as such, with everything rolled back |
| `db_query` with `transaction: false` | Autocommit, statement by statement — for `CREATE INDEX CONCURRENTLY`, `VACUUM` and others that refuse a transaction. When a later statement fails, the results of those already committed are shown with the error |
| Read-only profile, `db_explain`, catalog tools | `BEGIN [READ ONLY] … ROLLBACK` — nothing persists |

`BEGIN` / `COMMIT` / `SAVEPOINT` in the SQL are refused — the tool owns the transaction. `COPY … FROM STDIN / TO STDOUT` is refused too: the tool has no channel for a COPY stream — read with `SELECT`, write with `INSERT`.

**Cancellation.** When the MCP client cancels a call or gives up waiting, the server is asked to stop the running statement (a protocol CancelRequest), nothing further runs, and an open transaction — or an autocommit statement whose rows are still being read — is rolled back instead of committed. If the server does not stop within 5 s, the connection is cut. A connection that lost its session mid-call — a restart, a failover, a dropped tunnel — fails that call and is replaced; it never takes the server process down. When the connection dies so that a statement's outcome can't be known (during an autocommit statement or a `COMMIT`), the error says the outcome is unknown rather than guessing.

After every call the connection runs `DISCARD ALL` before going back to the pool: a `SET statement_timeout = 0`, a `set_config(…)` or a temp table does not reach the next call, and the profile's timeout is restored.

## 🛡️ Guard

Every statement is parsed by **libpg_query** — PostgreSQL's own grammar, compiled to WASM (`libpg-query`), the same parser `postgres-mcp` uses through `pglast`. A statement that does not parse is refused: an unknown shape can't be screened. Rules read the whole tree, so `delete   from\n users` is the same node as `DELETE FROM users`, and a `DELETE` inside `WITH x AS (…)` is found even though the statement's top is a `SELECT`.

| Layer | Scope | Refuses |
|---|---|---|
| **Always** | Every database, not configurable | `TRUNCATE` · `UPDATE` / `DELETE` without `WHERE` (inside `WITH` too) · `DROP DATABASE` / `SCHEMA` / `TABLESPACE` · `DROP OWNED` · `ALTER SYSTEM` · `COPY … TO/FROM PROGRAM` · transaction control |
| `DB_READONLY` | Opt-in | Anything but reads; data-modifying `WITH`; `SELECT … INTO`; `EXPLAIN ANALYZE` of a write |
| `DB_ALLOW_DDL=false` | Opt-in | Schema changes |
| `DB_DENY_PATTERNS` | Opt-in | Whatever you list |

**The threat model is a mistaken agent, not an adversary.** A `DO $$ … $$` body is a PL/pgSQL string the tree doesn't open, and a function can do anything its owner can — the read-only profile closes both by refusing `DO` and running inside a `READ ONLY` transaction, but the read-write profile's guard is a seatbelt, not a cage. The real boundary is the database role: give the entry a role that can do no more than it should.

The guard also can't ask a human. "Confirm before dropping a table" is the agent's rule, carried in the server's instructions; the tool refuses only what is never right.

A rejection says which rule fired, on which statement, and that nothing was sent. Its first line tells the agent what to do with it: **`Refused by the guard:`** is policy — report it, don't rephrase around it; **`Not supported by this tool:`** (COPY over STDIN / STDOUT, transaction control, turning `standard_conforming_strings` off) and **`SQL syntax error:`** mean the statement should be rewritten or fixed and sent again.

## ⚠️ Security notes

- The MCP entry holds `DB_PASSWORD` and maybe `DB_SSH_PASSWORD`. Prefer a key file so only its path is stored; keep the entry out of version control.
- **Anything the agent can reach, a prompt injection can reach.** Rows are untrusted input. Keep a production entry read-only.
- An unpinned SSH host accepts whatever key it presents — pin it with `DB_SSH_HOST_KEY`.

## 🧑‍💻 Development

```bash
npm test          # unit tests, plus driver / tool / catalog tests against PGlite (PostgreSQL 18 in WASM, started per test file);
                  # the session-isolation tests also run when MCP_DB_TEST_URL points at a real server (TEMP tables only)
npm run build     # tsc --noEmit, then tsup: lib/index.{js,cjs,d.ts} + lib/cli.js
```

For a release, keep `package.json`, both root-package versions in `package-lock.json`, and
`SERVER_VERSION` in `src/_defs/defaults.ts` in sync. Add a dated entry to
[CHANGELOG.md](CHANGELOG.md) and update the usage docs. Run the tests and build above,
check `node lib/cli.js --version` and `--help`, and inspect `npm pack --dry-run` for the
expected version, built files, README, changelog and license before publishing.

Layout:

- `src/modules/guard/` — `parse.ts` (libpg_query, byte offsets → statement text), `rules.ts` (the tree walk)
- `src/modules/postgres/postgres-driver.ts` — the one way SQL reaches the server: guard → transaction → cursor → reset
- `src/modules/postgres/catalog.ts` — catalog SQL, through the same `execute()`
- `src/modules/tunnel/` — `ssh-tunnel.ts` (ssh2, reconnecting, host key pin), `channel-socket.ts` (the socket `pg` gets)
- `src/modules/tools/` — tool registration and the text the agent reads
- `src/modules/profile.ts` — `DB_*` → profile, failing on anything malformed
- `src/modules/manage/` — the `config` command: `prompter.ts` (arrow-key / numbered prompts over any stream pair), `db-form.ts` (the settings form), `entry.ts` (answers ↔ `DB_*` env block), `connection-check.ts` (the report `--check` and the form share), `targets/` (one writer per client: `claude mcp` CLI, Codex TOML, JSON files)

## Memory and process lifetime

The PostgreSQL WASM parser runs in a worker started on the first non-empty SQL parse, including SQL used by catalog tools. After all pending parses finish, **30 seconds without another parse request terminates that worker**, releasing its WASM allocation. The next parse starts a new worker and pays the initialization cost again. Requests arriving during retirement wait for the previous worker to exit. Database connections and already executing queries remain independent of this lifecycle; parsing and guard rules apply to every SQL execution.

Each driver owns its parser and closes it on shutdown. The standalone library `parseStatements` function shares an automatically retiring worker. Worker failures reject pending parses before SQL execution. Idle workers do not keep a library caller's process alive. Node's remaining heap/allocator memory means total RSS need not return exactly to its original startup value.

Retirement never terminates a pending parse. New requests arriving during retirement wait for the worker to exit and share its replacement. Parser infrastructure failures are reported as operational errors, not instructions to rewrite SQL; the failed call sends nothing to the database and is not replayed automatically. Existing database work continues independently. Cold initialization adds latency to the first parse after retirement (about 41 ms in one local sample; workload and machine dependent).

SSH and its crypto runtime load only when opening a tunnel; direct database connections do not need them. SSH modules remain loaded after first use. The 30-second retirement rule applies to the SQL parser, not active SSH tunnels or database connections.

Individual mode starts one server process per configured connection in each client session. Session mode combines that kind's connections in one stdio process per client session. Both use the dedicated runtime directly, avoiding a resident npm/npx wrapper. Convert from Runtime and reconnect clients to load the new layout. Connections to remote services remain lazy.

Package updates take effect in newly started processes. Restart the MCP connection/client after updating; an already running older process does not acquire memory or shutdown fixes from replaced files. Compare process counts and Windows Private Bytes separately from resident memory (RSS), and include npm wrappers when estimating the total.

## 📜 License

MIT — see [LICENSE.md](LICENSE.md).
