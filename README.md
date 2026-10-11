# @akms/mcp-db

MCP server that lets an AI agent query **one pre-registered database** — directly, or through an **SSH tunnel it opens itself** — behind a guard that reads every statement with the real PostgreSQL parser.

Built because the database we needed to reach (RDS, not publicly accessible) sits behind a bastion, and the MCP server we used could neither tunnel nor tell `DELETE FROM users` from `DELETE FROM users WHERE id = 1`. The design record, with the measurements behind each choice, is [DESIGN.md](DESIGN.md) in the repository.

## 📦 Installation

```bash
npm install -g @akms/mcp-db   # installs the `akms-mcp-db` command
npx -y @akms/mcp-db --help    # or run it straight from the registry
```

Node ≥ 22. PostgreSQL 12 or later, only PostgreSQL for now.

## ⚙️ MCP client setup

**Let the CLI write it.** `config` opens a small manager for the databases registered in a client's config. It asks plain questions — driver (PostgreSQL, the only one so far), host, database, user, password, SSL, tunnel or not, read-only — tests the connection, offers to pin the SSH host key, and writes the entry. No `DB_*` name has to be remembered.

```bash
npx -y @akms/mcp-db config                  # opens on the first client found on this machine
npx -y @akms/mcp-db config --target codex   # claude-code | codex | claude-desktop | cursor
```

```
Claude Code (user scope)  /home/me/.claude.json

? 1 database — pick it to manage it
❯ pg_aws_akms  app_user@mydb….rds.amazonaws.com:15432/akms  ssh ubuntu@203.0.113.5:20022 · readonly, pinned
  ────────────────────────
  Add a database
  Switch client  also found: Codex CLI
  Quit
↑↓ move · enter select · esc back
```

The databases are the menu: pick one to edit, check, print or remove it. Adding or editing opens a settings form — every setting listed with its value, picked and changed in any order, with **Test the connection** and **Save** below. Choices are picked with the arrow keys — the SSH key from the keys found in `~/.ssh`, the route as "directly / through an SSH tunnel". **Esc goes back one level everywhere** — out of a list, a text field or a question, leaving the setting as it was. Where the terminal cannot send arrow keys (a pipe, Git Bash's mintty), the same lists are numbered and answered by number, and a line of just `ESC` stands for the key.

| Client | Config file | How it is written |
|---|---|---|
| Claude Code | `~/.claude.json` (user scope) | through `claude mcp add-json … -s user`, never by editing the file |
| Codex | `~/.codex/config.toml` | only the `[mcp_servers.<name>]` tables are rewritten; keys you added to them stay |
| Claude Desktop | `claude_desktop_config.json` | `mcpServers.<name>` is set, every other key kept |
| Cursor | `~/.cursor/mcp.json` | same |

Only entries that launch this package are listed or touched. An edit keeps every `DB_*` variable the form does not ask about (`DB_ALIAS`, deny patterns, timeouts, row limits, …). The connection is always written as the split variables — an entry that uses `DB_URL` is read into the form and rewritten without it. **Print** shows an entry as JSON, as a Codex TOML table and as a `claude mcp add-json` line, for when pasting is easier. On Windows the entry launches through `cmd /c npx`, the form Claude Code expects for npx servers there.

**Or by hand — one server entry per database** — plain `DB_*` variables, no config file. The server name (`pg_aws_akms` below) is what the agent sees in its tool list, so name it after the database.

```json
{
    "mcpServers": {
        "pg_aws_akms": {
            "command": "npx",
            "args": ["-y", "@akms/mcp-db"],
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

The server speaks MCP over **stdio**: stdout carries JSON-RPC, every log line goes to stderr.

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

Layout:

- `src/modules/guard/` — `parse.ts` (libpg_query, byte offsets → statement text), `rules.ts` (the tree walk)
- `src/modules/postgres/postgres-driver.ts` — the one way SQL reaches the server: guard → transaction → cursor → reset
- `src/modules/postgres/catalog.ts` — catalog SQL, through the same `execute()`
- `src/modules/tunnel/` — `ssh-tunnel.ts` (ssh2, reconnecting, host key pin), `channel-socket.ts` (the socket `pg` gets)
- `src/modules/tools/` — tool registration and the text the agent reads
- `src/modules/profile.ts` — `DB_*` → profile, failing on anything malformed
- `src/modules/manage/` — the `config` command: `prompter.ts` (arrow-key / numbered prompts over any stream pair), `db-form.ts` (the settings form), `entry.ts` (answers ↔ `DB_*` env block), `connection-check.ts` (the report `--check` and the form share), `targets/` (one writer per client: `claude mcp` CLI, Codex TOML, JSON files)

## 📜 License

MIT — see [LICENSE.md](LICENSE.md).
