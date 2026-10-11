# @akms/mcp-db — Design record

> Why the server is built the way it is. Usage and behavior are documented in [README.md](README.md) and not repeated here. The pre-implementation design and the round-by-round log of the 2026-10-11 review (rounds 1–8) are in this file as of commit `18994aa`, in Korean.

## 1. Why

- `postgres-mcp` (0.3.0), the server we were using, **does not know SSH tunnels**. Its only options are `database_url`, `--access-mode` and `--transport`. Reaching a database that is not publicly exposed, such as RDS, means keeping a separate `ssh -N -L` forward running and pointing the server at `localhost` — and when that process dies, the MCP server goes down with it.
- Its guard has two settings, "read-only" and "unrestricted", which leaves no place for our rules (never `TRUNCATE`, never `UPDATE`/`DELETE` without `WHERE`).
- The database server takes the same shape as `@akms/mcp-ssh` and `@akms/mcp-wsl`: one server entry per target, environment variables only, a three-tier guard, `--check`.

## 2. Scope

| | Now | Later |
| --- | --- | --- |
| DBMS | **PostgreSQL** 12+ (`pg`) | MySQL/MariaDB (`mysql2`), SQLite (`better-sqlite3` — no tunnel) |
| Connection | Direct TCP · **through an SSH tunnel** | — |
| Authentication | Password · SSH key or password | No IAM tokens and the like |

The driver boundary is three places: connecting, running a query, and the catalog SQL. The abstraction does not grow past them.

The `config` form's first row is the driver, with PostgreSQL as its only choice (2026-10-11: the user wanted the type visible and selectable from the start, even with one option). A second driver widens `DbDriverName`, adds its label to the form's driver list, and makes the port default, the SSL wording and the connection check follow the pick; `entryToAnswers` then reads `DB_DRIVER` back instead of assuming `postgres`.

`postgres-mcp`'s `analyze_db_health`, `get_top_queries` and index recommendations are not reproduced. When they are needed, read `pg_stat_statements` through `db_query`. Reviewed again against postgres-mcp 0.3.0 on 2026-10-11: the one piece taken is the index scan count (`pg_stat_all_indexes.idx_scan`) on `db_describe`'s index lines, since dropping an index is a decision made from that screen; `GENERIC_PLAN` for `db_explain`, sequence usage, the extension list and the health checks were judged not worth their surface until a real need shows.

## 3. User decisions

**Initial design** (2026-10-11: "1 오케이 2 오케이 3 추천대로 할게 4 추천대로" — "1 OK, 2 OK, 3 and 4 as recommended")

1. PostgreSQL only at first; only the driver boundary is left open.
2. `DB_READONLY` defaults to `false` — permissive by default, like mcp-ssh. Only production entries set it to `true`.
3. Several statements run in one transaction. `transaction: false` autocommits statement by statement.
4. The parser is `libpg-query` (WASM) — see §5.

**After the review** (2026-10-11: "권장대로 하자" — "go with the recommendations")

5. **An uncaught exception does not stop the server.** It is logged, and every connection in use is cut (`abortActiveConnections`). A dead MCP server takes all of its tools away until the client restarts it, whereas a cut connection is simply reopened by the next call. This is the last safety net; the actual remedy is in §4, "Connections and transactions".
6. **In json/jsonb, only numbers that would lose precision keep the server's text** (`JSON.rawJSON`). Returning the whole value as a string would make it indistinguishable from a JSON string value. Loss is judged on normalized decimal notation — `1.10` and `1.1`, or `1e20` and `100000000000000000000`, lose nothing.
   - A value nested deeper than about 2,000 levels comes back whole as the server's text. V8 runs the reviver recursively and overflows the stack, and an exception thrown inside a type parser is raised in pg's socket handler, where nothing can catch it.
   - Reparsing without a reviver is no way out either: the formatter's `JSON.stringify` overflows the same way at about 4,800 levels, and an already committed call is reported as "db_query failed".
7. **Partitions are listed under their parent.** `db_tables` shows only the parent, as `partitioned table (N partitions)`; `db_describe` lists the partitions. A table with hundreds of partitions does not bury the listing.
8. **PGlite is a devDependency only.**
9. **An MCP cancellation stops the statement on the server too.** A CancelRequest is sent, and the socket is cut if the connection does not come back within 5 s. A cancelled call's connection is discarded rather than reset — there is no telling between which messages the cancellation landed.
   - While an autocommit write's `RETURNING` rows are still being read, or before a cut-short portal is closed, the socket is cut without sending Sync. That Sync is the commit: sending it would commit the cancelled write and report success.
   - If the last read returned fewer than 1,000 rows, the Sync has already gone out with it, and the committed result is returned as is.

**Output floor** (2026-10-11: "1번은 진행하자" — "go ahead with option 1")

10. A `DB_MAX_OUTPUT` below 2000 fails startup. The server text that one error quotes runs up to 1,000 characters, and at limits of about 800 or less even the outcome line was cut by the final truncation. Laying out error output backwards from the budget was possible, but it would add one more heuristic for a limit nobody uses.

## 4. Why not the obvious alternative

Each item below is a case where the obvious alternative produced a wrong result. Each has a regression test.

### Configuration

- **Environment variables only.** What this server can reach, and how far, is answered by reading one entry. `DB_URL` is accepted to ease moving from `postgres-mcp`, but mixing it with the split variables fails startup.
- **`DB_SSL` defaults to `require`, through a tunnel too.** RDS refuses an unencrypted session even from inside the tunnel (measured: `no pg_hba.conf entry … no encryption`).
- **A misspelled policy variable fails startup; any other misspelling is only logged.** A misspelled `DB_READONLY` silently leaves a writable server, while an unrelated `DB_*` inherited from the environment must not keep the server from starting.
  - The check ignores case. On case-sensitive POSIX, `db_readonly` is not `DB_READONLY`, and the server came up writable without a warning.
  - Ties need two rules: a name with characters appended goes to the longer candidate (`DB_SSH_HOST_KEY_SHA256` → `DB_SSH_HOST_KEY`), a truncated name to the shortest completion (`DB_SS` → `DB_SSL`). Unifying them under either rule turns a policy typo on the other side into a mere warning.
- **`DB_DENY_PATTERNS` is read as JSON when its first item is a closed string followed by `,`, `]` or `"`** — unless that string starts with `]`, in which case it is a regex (`["]?secrets["]?`).
  - Widening the test reads a regex such as `["']\s*or` as JSON and blocks startup.
  - Narrowing it reads JSON with trailing text as one regex, and the deny patterns silently vanish.
  - A value that is genuinely ambiguous fails startup, and so does a `\b` written with one backslash (a backspace in JSON, so a pattern that never matches).

### Connections and transactions

- **Read-only wraps each call in `BEGIN READ ONLY … ROLLBACK` instead of setting a session default.** That way the server also stops writes inside functions (`nextval` and the like). postgres-mcp does the same.
- **`statement_timeout` is enforced on the server.** postgres-mcp's client-side `asyncio.timeout` ends the call but leaves the query running on the server.
- **Every call ends with `DISCARD ALL`.** With two pooled connections, a leftover `SET` may or may not be visible to the next call, and `SET statement_timeout = 0` lifts that connection's policy timeout. The catalog tools skip it, since their SQL is fixed.
- **A borrowed connection gets an `'error'` listener on every call.** pg-pool removes its own listener while a connection is lent out, so without ours, a database or tunnel dropping mid-query raised an unhandled `'error'` event and killed the process. The drop is raced against the query so that only that call fails, and the connection is discarded with `release(err)`.
- **Whether the session ended is decided by SQLSTATE (57P01–57P05, 25P03, 25P04), not by severity.** A server with `lc_messages=ko` sends the severity as `치명적오류`, and pg-protocol drops the unlocalized `V` field.
  - Class 08 is left out. 08P01 is also the ordinary ERROR for a wrong number of params, and including it reported a statement that never ran as "outcome unknown, connection lost".
- **`LateErrorCursor`.** In autocommit, a deferred foreign key fails at the cursor's Sync (the implicit commit), and pg-cursor drops errors that arrive after it reached `done`. The call then hung forever and leaked its connection.
- **`COPY … FROM STDIN / TO STDOUT` is refused.** pg-cursor cannot handle the CopyIn response, and the connection stalls.

### Row limit

- **A cursor reads `maxRows + 1` rows.** A large table never lands in memory whole; the extra row tells whether there are more.
- **A top-level `INSERT` / `UPDATE` / `DELETE` / `MERGE` is read to the end (1,000 rows at a time) and its rows are counted directly.** When a portal is executed several times, the command tag (`INSERT 0 N`) counts only the last Execute's rows.
- **How many rows a `SELECT`'s select-list function ran for is never stated as a number.** It depends on whether the function is a sort key, whether the planner defers it above the sort, and on aggregates, `DISTINCT ON`, set operations and joined `WITH`s. Across five rewrites, every wording that committed to a count was wrong in some case. The current wording is in the README's "Past the row limit".
- **A `SELECT` with a data-modifying `WITH`, and `EXECUTE`, `SHOW` and `CALL`, run to completion at the first Execute.** Their output says the statement ran in full, not that reading stopped one row past the limit. `EXPLAIN` says nothing about execution — without `ANALYZE`, the explained statement does not run.

### Values

- **Dates, times, intervals and `bytea` stay as the server's text.** `pg`'s default parser turns a `timestamp` into a local-time `Date`, which JSON shifts to UTC: 04:19 KST came out as `19:19Z` on the previous day (measured).
- **`numeric[]` and `bigint[]` are strings too.** A float `NaN` / `Infinity` stays text — as `null` it could not be told apart from SQL NULL.
- **Rows are built with `Object.create(null)`,** so a `__proto__` column does not vanish. A repeated column name becomes `a#2`, or the next free number when `a#2` already exists.
- **A JSON number in `params` beyond ±2^53 is refused,** with a hint to send it as a string.

### Guard

- **The guard runs in one place, the driver's execution path,** so a new tool cannot skip it.
- **DDL is judged over the whole AST, not by the top-level statement kind.** Looking only at the top lets `SELECT … INTO`, `EXPLAIN ANALYZE CREATE TABLE AS`, `PREPARE … SELECT INTO` and `REASSIGN OWNED` through. An `EXPLAIN` without `ANALYZE` runs nothing, so it is neither DDL nor a write.
- **Read-only refuses functions that a rollback cannot undo** (`pg_terminate_backend`, replication slots, `pg_stat_reset`, `lo_export`, …). A `READ ONLY` transaction does not stop them.
  - `set_config` is refused only for the timeouts and for a non-constant name. Refusing it outright blocked `search_path` too.
- **`pg_terminate_backend` is not in the "always" tier.** Ending one particular pid is ordinary work, and the line between that and ending all of them is blurry.
- **`standard_conforming_strings` is pinned on at connect, and every way of turning it off is refused** (`SET`, `set_config` with a non-constant name, `UPDATE pg_settings`). The guard's parser always lexes with it on, so with the server's setting off, a `WHERE` the guard saw ends up inside a string literal on the server. This was reproduced with the next statement of the same call.
- **Splitting statements strips only PostgreSQL's six whitespace characters, not `trim()`'s set.** `trim()` also removes U+3000 and U+00A0, which PostgreSQL reads as identifier characters, so the statement the server ran differed from the one the guard saw.
- **`db_explain` checks deny patterns and policy against the statement before its wrapper.** Deny patterns are applied neither to the wrapper nor to the tools' own catalog SQL (`internalSql`). Checked after wrapping, a `^`-anchored pattern missed, and a single `\banalyze\b` pattern blocked every plan.
- **`db_explain` does not accept `EXECUTE`.** A `PREPARE` from an earlier call is gone with that call's `DISCARD ALL`, and sending `PREPARE …; EXPLAIN EXECUTE …` in one call fails on a read-only profile, which refuses `PREPARE`.
  - So the hint is to send the prepared statement's SQL with `params`, and its declared types as casts (`$1::numeric`). Without the casts, the server infers the column types and shows a different plan from the one in question.
- **Refusals come in three kinds** (`Refused by the guard`, `Not supported by this tool`, `SQL syntax error`), so that the agent does not read a policy refusal as a problem to rephrase around.
- **"Confirm before `DROP TABLE`, `ALTER TYPE`, `RENAME`, `NOT NULL`" cannot be done by the tool.** MCP cannot stop to ask a human. That rule stays with the agent's conversation rules, and the tool refuses only what is never right.

### Output budget (`DB_MAX_OUTPUT`)

- **Plan first, then render.** A single pass in statement order that reserves room for cut lines up front does not work: which statements will be cut is unknown until the pass ends, so the reservation can only be an upper bound, and every rule added to hand back unused reservation made results vanish in some other shape.
- **Cut lines count what is missing** ("… 15 of 20 rows not shown"). They only get shorter as more is shown, so their length with nothing shown is an exact upper bound.
- **Results are kept whole in size order, and the leftover budget goes to the cut ones, smallest first.** A statement costs min(whole, cut lines alone). The output stays in statement order. So a small result is never cut for a larger one (0 in 60,000 random cases).
- **When the cut lines alone overflow, one summary line replaces them.** When even the headings overflow, runs of alike statements fold — only as far as needed, runs with no content first; past that, mixed neighbours are grouped into ranges. Folding whole runs hid `RETURNING` ids while budget was still left. At any limit, every statement number stays in the output.
- **On the error path, the server text (message, hint, detail, where) shares one 1,000-character allowance.** At 1,000 each, limits in the low thousands lost the outcome line and the committed headings to the final truncation.
- **When autocommit fails, the committed part's minimum is all of its headings, unfolded.** The failed statement's notices always keep at least a one-line count, because a procedure that commits in batches tells through its progress notices what was committed.
- **A cut `RETURNING` list of a write says "the write itself is complete".** With only "select fewer columns or rows", the agent reran a write that had already committed.
- **No array spread (`...`).** Past about 125,000 rows it throws a RangeError, and an already committed write is reported as failed.

### Catalog names

- **Names are shown the way SQL has to write them (`quote_ident`), and read back by the same rules,** so a name copied from the output finds the same object.
- **Names that point at another table (partition of, inherits from, owned by, …) are always schema-qualified.** `::regclass::text` omits schemas visible on the search_path.
- **A name without a schema is looked up on the session's search_path (`current_schemas(true)`), not in `public`.** A name that PostgreSQL printed without its schema in a constraint or trigger definition must resolve to the object SQL would find. As in SQL, the spelling order comes before the schema order.
- **An unquoted name folds only A–Z,** as SQL does.

### Tunnel

- **A channel adapter, `ChannelSocket` (a Duplex).** When `stream` is a function, `pg` calls it **synchronously** for each connection, immediately calls `connect(port, host)` on the result and waits for `'connect'`. ssh2's `forwardOut` is asynchronous.
  - So the adapter opens `forwardOut` inside `connect`, buffers writes until the channel opens, then flushes them and emits `'connect'`. `pg` layers TLS on this Duplex unchanged.
- **No local port is opened.** The SSH host (sshd) resolves the RDS name — `forwardOut` gets the name as its destination host.

## 5. Parser choice — following postgres-mcp

**What postgres-mcp (0.3.0) does** (`postgres_mcp/sql/safe_sql.py`, `sql_driver.py`):

- The parser is **`pglast`**, the Python binding of PostgreSQL's own parser, libpg_query. A statement that fails to parse is refused.
- `restricted` mode has three allow-lists: statement kinds, every AST node kind, every function name. Execution runs inside `BEGIN TRANSACTION READ ONLY` … `ROLLBACK`.
- `unrestricted` mode has no parsing and no guard.

**Taken**: the real PostgreSQL parser, parse failure means refusal, read-only as `BEGIN READ ONLY` … `ROLLBACK`.
**Not taken**: the node and function allow-lists. Ordinary functions (`jsonb_path_query`, …) are blocked unless listed, which costs constant upkeep, while writes are already stopped on the server by the `READ ONLY` transaction.

**JS candidates — the same 29 statements (measured 2026-10-11)**:

| | Version · size | Parse failures | Could not read |
| --- | --- | --- | --- |
| `pgsql-ast-parser` (pure JS, its own grammar) | 12.0.2 · 2.0 MB | **9 / 29** | `DROP SCHEMA`, `DROP DATABASE`, `ALTER SYSTEM`, `COPY … TO PROGRAM` — the very statements to block — plus `ALTER TYPE … ADD VALUE`, `MERGE`, `GRANT`, `CREATE POLICY`, `EXPLAIN (ANALYZE)` |
| **`libpg-query`** (libpg_query compiled to WASM) | 18.1.5 · 1.8 MB · no install script | **0 / 29** | — |

"A native binding, heavy to install" was outdated information: it is WASM now. Meanwhile, in a guard where a parse failure means refusal, failing 9 of 29 would block everyday work.

## 6. Testing

Unit tests cannot reproduce dropped connections, late errors or command-tag row counts, so there are three test environments.

- **PGlite** (PostgreSQL 18 in WASM) + `pglite-socket`: `npm test` runs against the real server protocol. Its limits: several connections share one session, and CancelRequest and startup parameters are ignored.
- **Fault-injecting TCP proxy** (`tests/support/tcp-proxy.ts`): drops the connection at a given message, swallows a response, or slips a `FATAL 57P01` in after one.
- **Real PostgreSQL** (`MCP_DB_TEST_URL`, TEMP tables only): cancellation, session termination and localized messages (`lc_messages=ko`) — what PGlite cannot imitate.

The query path went through eight rounds of adversarial review on 2026-10-11. Each finding was reproduced on its own and an attempt was made to refute it; only what survived was fixed.

## 7. Measurements (2026-10-11, RDS PostgreSQL 18.6 through a bastion)

- SSH connect takes about 0.2 s; the first database connection about 1.2 s (TLS + SCRAM).
- After that, about 110 ms per call — tunnel round trips × (`BEGIN`, cursor, close, `DISCARD`). `db_describe` takes about 0.6 s.
- RDS refuses `DB_SSL=off`. `verify` needs a CA file, because the RDS bundle (rds-ca-rsa2048-g1) is not in Node's default trust store.

## 8. Known limitations

- `DO $$ … $$` and function bodies are strings the guard cannot see. Read-only refuses `DO` and runs inside a `READ ONLY` transaction; on a read-write profile, the database role's privileges are the real boundary.
- PGlite ignores the server-side effect of cancellation (CancelRequest), so only the real-PostgreSQL integration tests confirm it.
- A select-list function of a `SELECT` stopped at the row limit may have run for more rows than are shown. Reading to the end would defeat the limit's purpose (not computing a large result), so the output says so instead.
- The output budget's last resorts lose information:
  - Grouping mixed neighbours into a range drops their row counts and keeps only counts per kind. Within such a range, `CREATE TABLE AS` and `SELECT INTO` are counted as `SELECT`, their command tag.
  - The summarized layout does not say whose notices were hidden — a `CREATE` whose `already exists, skipping` was hidden looks the same as one that created the table.
  - Folding works by runs, so a small result inside a folded run can be hidden before a larger one outside it.
  - The failed statement's notice count line takes about 60 characters, so when the room left falls short of the committed headings' minimum by about that much, a few headings fold. Accepted as better than dropping the notices without a word.
- Cut lines name `DB_MAX_OUTPUT` but not its value, so the agent cannot judge how much to narrow. The natural place for the value is `db_list_hosts`'s Policy line.
- The loop that shares budget among cut blocks rebuilds every cut line on each pass, so it turns quadratic when cut-line and row lengths line up exactly and the limit is in the hundreds of thousands.
- The fast path that checks whether everything fits joins the whole output, so a single statement whose rows total more than V8's maximum string length (about 500 million characters) crashes it.
- Hints the tools build in JS (`No schema named …`) do not know reserved words, so a name that needs quotes (`user`, `order`) is written in lowercase as is. They are display text only, so this was left alone.
