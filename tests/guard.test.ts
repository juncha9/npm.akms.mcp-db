import { describe, expect, it } from "vitest";
import type { DbPolicy } from "@/_types";
import { formatGuardRejection, GuardRejectionError } from "@/modules/guard/guard-error";
import { parseStatements } from "@/modules/guard/parse";
import { changesSchema, checkStatements, isDdlKind, writesData } from "@/modules/guard/rules";

function policy(overrides: Partial<DbPolicy> = {}): DbPolicy {
    return {
        readonly: false,
        allowDdl: true,
        denyPatterns: [],
        statementTimeoutMs: 60000,
        connectTimeoutMs: 20000,
        maxRows: 500,
        maxOutputCharacters: 100000,
        ...overrides,
    };
}

async function verdictOf(sql: string, options: { policy?: Partial<DbPolicy>; readOnly?: boolean } = {}) {
    const statements = await parseStatements(sql);
    return checkStatements(statements, policy(options.policy), options.readOnly == true);
}

describe("parseStatements", () => {
    it("slices each statement by byte offsets, so a Korean comment does not shift the next one", async () => {
        const statements = await parseStatements("SELECT 1; -- 한글 주석\nDELETE FROM t WHERE a = '가'");
        expect(statements.map((statement) => [statement.index, statement.kind, statement.text])).toEqual([
            [1, "SelectStmt", "SELECT 1"],
            [2, "DeleteStmt", "DELETE FROM t WHERE a = '가'"],
        ]);
    });

    it("trims only PostgreSQL's whitespace — a trailing U+3000 is part of the name the server will read", async () => {
        const [statement] = await parseStatements("DROP TABLE staging　");
        expect(statement.text).toBe("DROP TABLE staging　");
        const [padded] = await parseStatements("  \n SELECT 1 \t\n");
        expect(padded.text).toBe("SELECT 1");
    });

    it("refuses empty input and comment-only input", async () => {
        await expect(parseStatements("   ")).rejects.toBeInstanceOf(GuardRejectionError);
        await expect(parseStatements("-- nothing here\n;")).rejects.toThrow(/only comments/);
    });

    it("refuses what does not parse, with the position, as a syntax error rather than a policy refusal", async () => {
        const failure = await parseStatements("SELEC 1").catch((ex: unknown) => ex);
        expect(failure).toBeInstanceOf(GuardRejectionError);
        expect((failure as GuardRejectionError).verdict.kind).toBe("syntax");
        expect((failure as GuardRejectionError).message).toMatch(/syntax error.*near character 1/);
        expect(formatGuardRejection((failure as GuardRejectionError).verdict)).toMatch(/^SQL syntax error: .*\n.*fix the statement and send it again/);
    });

    it("reads statements the pure-JS parser could not (ALTER TYPE ADD VALUE, MERGE, GRANT, CREATE POLICY)", async () => {
        const kinds: string[] = [];
        for(const sql of [
            "ALTER TYPE status ADD VALUE IF NOT EXISTS 'archived'",
            "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a",
            "GRANT SELECT ON ALL TABLES IN SCHEMA public TO reader",
            "CREATE POLICY p ON t USING (owner = current_user)",
        ]) {
            const statements = await parseStatements(sql);
            kinds.push(statements[0].kind);
        }
        expect(kinds).toEqual(["AlterEnumStmt", "MergeStmt", "GrantStmt", "CreatePolicyStmt"]);
    });
});

describe("always refused", () => {
    it.each([
        ["TRUNCATE users", /TRUNCATE/],
        ["truncate table a, b cascade", /TRUNCATE/],
        ["UPDATE users SET name = 'x'", /UPDATE without WHERE/],
        ["DELETE FROM users", /DELETE without WHERE/],
        ["delete   from\n  users", /DELETE without WHERE/],
        ["WITH d AS (DELETE FROM logs RETURNING *) SELECT count(*) FROM d", /DELETE without WHERE/],
        ["SELECT 1; DELETE FROM users", /DELETE without WHERE/],
        ["DROP DATABASE akms", /DROP DATABASE/],
        ["DROP SCHEMA app CASCADE", /DROP SCHEMA/],
        ["DROP TABLESPACE ts", /DROP TABLESPACE/],
        ["DROP OWNED BY bob", /DROP OWNED/],
        ["ALTER SYSTEM SET work_mem = '1GB'", /ALTER SYSTEM/],
        ["COPY users TO PROGRAM 'gzip > /tmp/x'", /PROGRAM/],
        ["COPY users FROM PROGRAM 'cat /etc/passwd'", /PROGRAM/],
    ])("%s", async (sql, reason) => {
        const verdict = await verdictOf(sql);
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toMatch(reason);
        expect(verdict.reason).toMatch(/refused on every database/);
    });

    it("names the statement that fired", async () => {
        const verdict = await verdictOf("SELECT 1; SELECT 2; TRUNCATE t");
        expect(verdict.statementIndex).toBe(3);
        expect(verdict.offendingText).toBe("TRUNCATE t");
    });

    it("lets the ordinary forms through", async () => {
        for(const sql of [
            "UPDATE users SET name = 'x' WHERE id = 1",
            "DELETE FROM users WHERE created_at < now() - interval '1 day'",
            "WITH d AS (DELETE FROM logs WHERE at < now() RETURNING *) SELECT count(*) FROM d",
            "DROP TABLE users",
            "COPY users TO '/tmp/users.csv'",
            "COPY users FROM '/tmp/users.csv' WITH (FORMAT csv)",
            "INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = excluded.a",
            "SELECT pg_terminate_backend(12345)",
        ]) {
            const verdict = await verdictOf(sql);
            expect(verdict, sql).toEqual({ allowed: true });
        }
    });

    it("refuses transaction control as unsupported — the tool owns the transaction", async () => {
        for(const sql of ["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT a", "BEGIN READ WRITE"]) {
            const verdict = await verdictOf(sql);
            expect(verdict.reason, sql).toMatch(/transaction control/);
            expect(verdict.kind, sql).toBe("unsupported");
        }
    });

    it.each([
        "COPY users TO STDOUT",
        "COPY (SELECT * FROM users) TO STDOUT WITH (FORMAT csv)",
        "COPY users FROM STDIN",
        "SELECT 1; COPY users FROM STDIN",
    ])("refuses %s as unsupported — pg crashes on a COPY stream through the statement cursor", async (sql) => {
        const verdict = await verdictOf(sql);
        expect(verdict.allowed).toBe(false);
        expect(verdict.kind).toBe("unsupported");
        expect(verdict.reason).toMatch(/STDIN \/ TO STDOUT/);
        expect(formatGuardRejection(verdict)).toMatch(/^Not supported by this tool: /);
    });

    it.each([
        "SET standard_conforming_strings = off",
        "SET LOCAL standard_conforming_strings TO off",
        "SELECT set_config('standard_conforming_strings', 'off', true)",
        "SELECT 1; SET standard_conforming_strings = off; UPDATE t SET note = 'C:\\dir\\' WHERE id = 1",
        "SET standard_conforming_strings = 0",
        // A name the guard cannot read could be this one
        "SELECT set_config('standard_conforming_strings'::text, 'off', false)",
        "SELECT set_config(name, 'off', false) FROM pg_settings WHERE name = 'standard_conforming_strings'",
        "SELECT set_config('standard_' || 'conforming_strings', 'off', false)",
        // pg_settings' UPDATE rule calls set_config
        "UPDATE pg_settings SET setting = 'off' WHERE name = 'standard_conforming_strings'",
        "UPDATE pg_catalog.pg_settings SET setting = 'off' WHERE name = 'standard_conforming_strings'",
    ])("refuses %s — the server would read later strings differently from the guard", async (sql) => {
        const verdict = await verdictOf(sql);
        expect(verdict.allowed).toBe(false);
        expect(verdict.kind).toBe("unsupported");
        expect(verdict.reason).toMatch(/standard_conforming_strings/);
    });

    it.each([
        "RESET standard_conforming_strings",
        "SET standard_conforming_strings TO DEFAULT",
    ])("refuses %s — the default may be a database or role setting of off", async (sql) => {
        const verdict = await verdictOf(sql);
        expect(verdict.kind).toBe("unsupported");
    });

    it("reports an UPDATE pg_settings without WHERE as the always-refused rule, which comes first", async () => {
        const verdict = await verdictOf("UPDATE pg_settings SET setting = 'off'");
        expect(verdict.kind).toBe("policy");
        expect(verdict.reason).toMatch(/UPDATE without WHERE/);
    });

    it("leaves other settings alone — and setting standard_conforming_strings to on, as a pg_dump header does", async () => {
        for(const sql of [
            "SET search_path TO app",
            "RESET ALL",
            "SELECT set_config('search_path', 'app', true)",
            "SET statement_timeout = 0",
            "SET standard_conforming_strings = on",
            "SET standard_conforming_strings TO 'on'",
            "SET standard_conforming_strings = true",
            "SET standard_conforming_strings = 1",
            "SELECT pg_catalog.set_config('standard_conforming_strings', 'on', false)",
            // Whatever the name turns out to be, 'on' leaves the lexing as it is
            "SELECT set_config(name, 'on', false) FROM pg_settings WHERE name = 'standard_conforming_strings'",
            // A table of that name in another schema is just a table
            "UPDATE app.pg_settings SET v = 1 WHERE k = 'x'",
            "SET backslash_quote = on",
            "SET statement_timeout = 0; SET lock_timeout = 0; SET client_encoding = 'UTF8'; SET standard_conforming_strings = on; SELECT pg_catalog.set_config('search_path', '', false)",
        ]) {
            const verdict = await verdictOf(sql);
            expect(verdict, sql).toEqual({ allowed: true });
        }
    });

    it("reports a COPY the profile forbids anyway as policy, not as a shape to rewrite", async () => {
        const readOnly = await verdictOf("COPY users FROM STDIN", { readOnly: true });
        expect(readOnly.kind).toBe("policy");
        expect(readOnly.reason).toMatch(/read-only/);

        const denied = await verdictOf("COPY users TO STDOUT", { policy: { denyPatterns: [/\busers\b/i] } });
        expect(denied.kind).toBe("policy");
        expect(denied.reason).toMatch(/deny pattern/);
    });

    it("labels every other refusal as policy", async () => {
        const verdict = await verdictOf("TRUNCATE t");
        expect(verdict.kind).toBe("policy");
        expect(formatGuardRejection(verdict)).toMatch(/^Refused by the guard: /);
    });
});

describe("read-only", () => {
    it.each([
        "SELECT * FROM users WHERE id = $1",
        "VALUES (1), (2)",
        "TABLE users",
        "SHOW work_mem",
        "EXPLAIN SELECT 1",
        "EXPLAIN (ANALYZE) SELECT 1",
        "EXPLAIN DELETE FROM t WHERE a = 1",
        "EXPLAIN (ANALYZE false) UPDATE t SET a = 1 WHERE b = 2",
    ])("allows %s", async (sql) => {
        const verdict = await verdictOf(sql, { readOnly: true });
        expect(verdict).toEqual({ allowed: true });
    });

    it.each([
        ["INSERT INTO t VALUES (1)", /only SELECT/],
        ["UPDATE t SET a = 1 WHERE b = 2", /only SELECT/],
        ["CREATE TABLE t (a int)", /only SELECT/],
        ["DO $$ BEGIN PERFORM 1; END $$", /only SELECT/],
        ["SET work_mem = '1GB'", /only SELECT/],
        ["WITH d AS (DELETE FROM t WHERE a = 1 RETURNING *) SELECT * FROM d", /writes data/],
        ["SELECT * INTO copy_t FROM t", /SELECT … INTO/],
        ["SELECT 1 AS a INTO copy_t UNION SELECT 2", /SELECT … INTO/],
        ["EXPLAIN ANALYZE DELETE FROM t WHERE a = 1", /writes data/],
        ["EXPLAIN (ANALYZE true) DELETE FROM t WHERE a = 1", /writes data/],
        ["EXPLAIN (ANALYZE false, ANALYZE true) INSERT INTO t VALUES (1)", /writes data/],
        ["EXPLAIN ANALYZE CREATE TABLE big_copy AS SELECT * FROM t", /CREATE TABLE … AS/],
        ["EXPLAIN (ANALYZE) CREATE MATERIALIZED VIEW mv AS SELECT 1", /CREATE TABLE … AS/],
    ])("refuses %s", async (sql, reason) => {
        const verdict = await verdictOf(sql, { readOnly: true });
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toMatch(reason);
    });

    it.each([
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle in transaction'",
        "SELECT pg_catalog.pg_cancel_backend(12345)",
        "SELECT pg_drop_replication_slot('inactive_slot')",
        "SELECT * FROM pg_create_physical_replication_slot('s')",
        "SELECT pg_create_logical_replication_slot('s', 'pgoutput')",
        "SELECT * FROM pg_logical_slot_get_changes('s', NULL, NULL)",
        "SELECT pg_stat_reset()",
        "SELECT pg_stat_reset_shared('io')",
        "SELECT pg_stat_statements_reset()",
        "SELECT pg_reload_conf()",
        "SELECT dblink_exec('remote', 'DELETE FROM t WHERE true')",
        "SELECT lo_export(16400, '/tmp/x')",
        "SELECT 1 WHERE EXISTS (SELECT pg_terminate_backend(1))",
        "EXPLAIN ANALYZE SELECT pg_terminate_backend(1)",
    ])("refuses %s — its effect outlives the ROLLBACK", async (sql) => {
        const verdict = await verdictOf(sql, { readOnly: true });
        expect(verdict.allowed).toBe(false);
        expect(verdict.kind).toBe("policy");
        expect(verdict.reason).toMatch(/acts outside the transaction/);
    });

    it("still runs ordinary functions, peeks, and plans that do not execute", async () => {
        for(const sql of [
            "SELECT now(), current_setting('statement_timeout'), pg_size_pretty(pg_database_size(current_database()))",
            "SELECT jsonb_path_query('{\"a\":1}', '$.a')",
            "SELECT * FROM pg_logical_slot_peek_changes('s', NULL, NULL)",
            "SELECT pg_backend_pid(), pg_stat_get_activity(NULL)",
            "EXPLAIN SELECT pg_terminate_backend(1)",
        ]) {
            const verdict = await verdictOf(sql, { readOnly: true });
            expect(verdict, sql).toEqual({ allowed: true });
        }
    });

    it("lets set_config through except for a time limit — the closing ROLLBACK undoes any other setting", async () => {
        for(const sql of [
            "SELECT set_config('search_path', 'app, public', true); SELECT * FROM items",
            "SELECT set_config('work_mem', '64MB', true)",
        ]) {
            const verdict = await verdictOf(sql, { readOnly: true });
            expect(verdict, sql).toEqual({ allowed: true });
        }
        const timeout = await verdictOf("SELECT set_config('statement_timeout', '0', true)", { readOnly: true });
        expect(timeout.reason).toMatch(/set_config\('statement_timeout', …\) would lift the profile's time limit/);
        const computed = await verdictOf("SELECT set_config(name, '0', true) FROM pg_settings", { readOnly: true });
        expect(computed.reason).toMatch(/not a string constant/);
        // A read-write profile may change its own session's limits
        expect(await verdictOf("SELECT set_config('statement_timeout', '0', false)")).toEqual({ allowed: true });
    });

    it("leaves the admin functions to a read-write profile, where they are ordinary work", async () => {
        const verdict = await verdictOf("SELECT pg_terminate_backend(12345)");
        expect(verdict).toEqual({ allowed: true });
    });
});

describe("profile switches", () => {
    it("DB_ALLOW_DDL=false refuses schema changes but not data changes", async () => {
        const off = { policy: { allowDdl: false } };
        for(const sql of [
            "CREATE TABLE t (a int)",
            "ALTER TABLE t ADD COLUMN b int",
            "DROP TABLE t",
            "CREATE INDEX ix ON t (a)",
            "CREATE VIEW v AS SELECT 1",
            "COMMENT ON TABLE t IS 'x'",
            "GRANT SELECT ON t TO r",
            "ALTER TYPE s ADD VALUE 'x'",
        ]) {
            const verdict = await verdictOf(sql, off);
            expect(verdict.reason, sql).toMatch(/DDL/);
        }
        const verdict = await verdictOf("INSERT INTO t VALUES (1)", off);
        expect(verdict).toEqual({ allowed: true });
    });

    it.each([
        "SELECT * INTO users_backup FROM users",
        "SELECT 1 AS a INTO t UNION SELECT 2",
        "EXPLAIN ANALYZE CREATE TABLE t AS SELECT 1",
        "EXPLAIN (ANALYZE) CREATE MATERIALIZED VIEW mv AS SELECT 1",
        "PREPARE p AS SELECT 1 AS a INTO t",
        "REASSIGN OWNED BY app TO other",
    ])("DB_ALLOW_DDL=false also refuses %s — it creates or re-owns objects without a DDL keyword on top", async (sql) => {
        const verdict = await verdictOf(sql, { policy: { allowDdl: false } });
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toMatch(/DDL/);
    });

    it("a plan alone creates nothing: EXPLAIN without ANALYZE of CREATE TABLE … AS / SELECT … INTO passes DB_ALLOW_DDL=false", async () => {
        for(const sql of ["EXPLAIN CREATE TABLE x AS SELECT 1", "EXPLAIN SELECT 1 AS a INTO x", "EXPLAIN (ANALYZE false) CREATE TABLE x AS SELECT 1"]) {
            const verdict = await verdictOf(sql, { policy: { allowDdl: false } });
            expect(verdict, sql).toEqual({ allowed: true });
            const [statement] = await parseStatements(sql);
            expect(changesSchema(statement), sql).toBe(false);
        }
    });

    it("writesData counts what runs: not the INSERT under a plain EXPLAIN, but the one under EXPLAIN ANALYZE or in a WITH", async () => {
        const flags: boolean[] = [];
        for(const sql of [
            "EXPLAIN (VERBOSE) INSERT INTO t SELECT 1",
            "EXPLAIN ANALYZE INSERT INTO t SELECT 1",
            "WITH d AS (DELETE FROM t WHERE a = 1 RETURNING *) SELECT * FROM d",
            "SELECT 1",
        ]) {
            const [statement] = await parseStatements(sql);
            flags.push(writesData(statement));
        }
        expect(flags).toEqual([false, true, true, false]);
    });

    it("changesSchema flags a table created inside another statement, so a result's ddl flag does not miss it", async () => {
        const flags: [string, boolean][] = [];
        for(const sql of ["SELECT * INTO b FROM t", "EXPLAIN ANALYZE CREATE TABLE b AS SELECT 1", "CREATE TABLE b (a int)", "SELECT * FROM t", "INSERT INTO t VALUES (1)"]) {
            const [statement] = await parseStatements(sql);
            flags.push([sql, changesSchema(statement)]);
        }
        expect(flags.map(([, flag]) => flag)).toEqual([true, true, true, false, false]);
    });

    it("deny patterns are tested against each statement's own text", async () => {
        const verdict = await verdictOf("SELECT 1; select * from secrets", { policy: { denyPatterns: [/\bsecrets\b/i] } });
        expect(verdict.statementIndex).toBe(2);
        expect(verdict.reason).toMatch(/deny pattern/);
    });

    it("classifies DDL kinds", () => {
        expect(["CreateStmt", "AlterTableStmt", "DropStmt", "IndexStmt", "RenameStmt", "GrantStmt", "CreateTableAsStmt"].every(isDdlKind)).toBe(true);
        expect(["SelectStmt", "InsertStmt", "UpdateStmt", "DeleteStmt", "VariableSetStmt"].some(isDdlKind)).toBe(false);
    });
});
