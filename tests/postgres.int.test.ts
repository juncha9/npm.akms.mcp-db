import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDbProfile } from "@/modules/profile";
import { describeRelation, listRelations } from "@/modules/postgres/catalog";
import { PostgresDriver, StatementError } from "@/modules/postgres/postgres-driver";

// Runs against a real PostgreSQL only when MCP_DB_TEST_URL is set. Everything it creates is a
// TEMP table — gone when the session ends — so it is safe on a shared test database.
// The pool holds up to two connections and a TEMP table lives in one of them, so every
// statement touching it runs inside a single execute() call.

const TEST_URL = process.env.MCP_DB_TEST_URL;

describe.skipIf(TEST_URL == null)("PostgresDriver against a real database", () => {
    let driver: PostgresDriver;

    beforeAll(() => {
        const profile = loadDbProfile({ DB_DRIVER: "postgres", DB_URL: TEST_URL, DB_SSL: process.env.MCP_DB_TEST_SSL ?? "off", DB_MAX_ROWS: "3" });
        driver = new PostgresDriver(profile!);
    });

    afterAll(async () => {
        await driver.close();
    });

    it("reads only maxRows + 1 and says there is more", async () => {
        const result = await driver.execute("SELECT g FROM generate_series(1, 1000) g", { transaction: "commit" });
        const statement = result.statements[0];
        expect(statement.rows).toEqual([{ g: 1 }, { g: 2 }, { g: 3 }]);
        expect(statement.truncated).toBe(true);
    });

    it("keeps timestamps as the server's text and repeated column names apart", async () => {
        const result = await driver.execute(
            "SELECT '2026-10-11 04:19:18.491'::timestamp AS at, '2026-10-11'::date AS d, 9007199254740993::bigint AS big, 1 AS a, 2 AS a",
            { transaction: "commit" }
        );
        expect(result.statements[0].rows[0]).toEqual({ "at": "2026-10-11 04:19:18.491", "d": "2026-10-11", "big": "9007199254740993", "a": 1, "a#2": 2 });
    });

    it("commit mode: a failing statement rolls back the ones before it", async () => {
        let caught: unknown;
        try {
            await driver.execute(
                "CREATE TEMP TABLE mcp_db_t1 (id int PRIMARY KEY); INSERT INTO mcp_db_t1 VALUES (1); INSERT INTO mcp_db_t1 VALUES (1)",
                { transaction: "commit" }
            );
        }
        catch(ex) {
            caught = ex;
        }
        expect(caught).toBeInstanceOf(StatementError);
        expect((caught as StatementError).statementIndex).toBe(3);
        expect(((caught as StatementError).cause as { code: string }).code).toBe("23505");

        const check = await driver.execute("SELECT to_regclass('pg_temp.mcp_db_t1') IS NULL AS gone", { transaction: "commit" });
        expect(check.statements[0].rows[0]).toEqual({ gone: true });
    });

    it("rollback mode leaves nothing behind; DML reports affected rows; DDL is flagged", async () => {
        const result = await driver.execute(
            "CREATE TEMP TABLE mcp_db_t2 (id int); INSERT INTO mcp_db_t2 SELECT generate_series(1, 10); UPDATE mcp_db_t2 SET id = id + 1 WHERE id <= 4",
            { transaction: "rollback" }
        );
        expect(result.statements.map((statement) => [statement.command, statement.rowCount, statement.ddl])).toEqual([
            ["CREATE", null, true],
            ["INSERT", 10, false],
            ["UPDATE", 4, false],
        ]);
        const check = await driver.execute("SELECT to_regclass('pg_temp.mcp_db_t2') IS NULL AS gone", { transaction: "commit" });
        expect(check.statements[0].rows[0]).toEqual({ gone: true });
    });

    it("a read-only call runs in a READ ONLY transaction, so writes inside functions are stopped by the server", async () => {
        const mode = await driver.execute("SELECT current_setting('transaction_read_only') AS ro", { transaction: "commit", readOnly: true });
        expect(mode.statements[0].rows[0]).toEqual({ ro: "on" });
        expect(mode.transaction).toBe("rollback");
    });

    it("session settings do not outlive the call — the profile's timeout comes back on every pooled connection", async () => {
        await driver.execute("SET statement_timeout = 0; SELECT set_config('application_name', 'leaked', false)", { transaction: "commit" });
        for(let attempt = 0; attempt < 4; attempt++) {
            const result = await driver.execute(
                "SELECT current_setting('statement_timeout') AS timeout, current_setting('application_name') AS app",
                { transaction: "commit" }
            );
            expect(result.statements[0].rows[0]).toEqual({ timeout: "1min", app: "akms-mcp-db" });
        }
    });

    it("params bind to a single statement", async () => {
        const result = await driver.execute("SELECT $1::int + $2::int AS sum", { transaction: "commit", params: [2, 3] });
        expect(result.statements[0].rows[0]).toEqual({ sum: 5 });
        await expect(driver.execute("SELECT $1; SELECT 2", { transaction: "commit", params: [1] })).rejects.toThrow(/single statement/);
    });

    it("a wrong number of params is an ordinary error (08P01, severity ERROR) — not a lost connection", async () => {
        const failure = await driver.execute("SELECT $1::int AS x", { transaction: "autocommit", params: [1, 2] }).catch((ex: unknown) => ex);
        expect(failure).toBeInstanceOf(StatementError);
        expect(((failure as StatementError).cause as { code: string }).code).toBe("08P01");
        expect((failure as StatementError).connectionLost).toBe(false);
    });

    // What PGlite cannot show: it ignores CancelRequest, startup parameters and timers, and has one session

    it("a CancelRequest stops the running statement on the server, and the call is rolled back", async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 300);
        const startedAt = Date.now();
        const failure = await driver.execute(
            "CREATE TEMP TABLE mcp_db_cancel (id int); INSERT INTO mcp_db_cancel VALUES (1); SELECT pg_sleep(10)",
            { transaction: "commit", signal: controller.signal }
        ).catch((ex: unknown) => ex);
        expect(Date.now() - startedAt).toBeLessThan(3000);
        expect(failure).toBeInstanceOf(StatementError);
        expect(((failure as StatementError).cause as { code: string }).code).toBe("57014");
        expect((failure as StatementError).statementIndex).toBe(3);
    }, 15000);

    it("enforces the profile's statement_timeout on the server, in a transaction and in autocommit", async () => {
        const profile = loadDbProfile({ DB_DRIVER: "postgres", DB_URL: TEST_URL, DB_SSL: process.env.MCP_DB_TEST_SSL ?? "off", DB_STATEMENT_TIMEOUT_MS: "500" });
        const shortDriver = new PostgresDriver(profile!);
        try {
            for(const transaction of ["commit", "autocommit"] as const) {
                const startedAt = Date.now();
                const failure = await shortDriver.execute("SELECT pg_sleep(3)", { transaction: transaction }).catch((ex: unknown) => ex);
                expect(Date.now() - startedAt, transaction).toBeLessThan(2500);
                // 57014 for a timeout and a cancel alike; the message is in the server's lc_messages language
                expect(((failure as StatementError).cause as { code: string }).code, transaction).toBe("57014");
            }
        }
        finally {
            await shortDriver.close();
        }
    }, 15000);

    it("pins standard_conforming_strings on, the way the guard lexes string literals", async () => {
        const result = await driver.execute("SHOW standard_conforming_strings", { transaction: "commit" });
        expect(result.statements[0].rows[0]).toEqual({ standard_conforming_strings: "on" });
    });

    it("a statement that terminates its own backend fails that call, not the process — and the next call works", async () => {
        const failure = await driver.execute("SELECT pg_terminate_backend(pg_backend_pid())", { transaction: "autocommit" })
            .catch((ex: unknown) => ex);
        expect(failure).toBeInstanceOf(StatementError);
        expect((failure as StatementError).connectionLost).toBe(true);

        const result = await driver.execute("SELECT 1 AS ok", { transaction: "commit" });
        expect(result.statements[0].rows).toEqual([{ ok: 1 }]);
    }, 15000);

    it("autocommit: a deferred constraint failing at the implicit commit is that statement's error, without a hang", async () => {
        const failure = await driver.execute(
            "CREATE TEMP TABLE mcp_db_parent (id int PRIMARY KEY);"
            + " CREATE TEMP TABLE mcp_db_child (parent_id int REFERENCES mcp_db_parent DEFERRABLE INITIALLY DEFERRED);"
            + " INSERT INTO mcp_db_child VALUES (999)",
            { transaction: "autocommit" }
        ).catch((ex: unknown) => ex);
        expect(failure).toBeInstanceOf(StatementError);
        expect((failure as StatementError).statementIndex).toBe(3);
        expect(((failure as StatementError).cause as { code: string }).code).toBe("23503");
    }, 15000);

    it("a write whose RETURNING passes the row limit reports every affected row", async () => {
        const result = await driver.execute(
            "CREATE TEMP TABLE mcp_db_returning AS SELECT g AS id FROM generate_series(1, 10) g; UPDATE mcp_db_returning SET id = id + 100 WHERE id > 0 RETURNING id",
            { transaction: "rollback" }
        );
        const update = result.statements[1];
        expect([update.command, update.rowCount, update.rows.length, update.truncated]).toEqual(["UPDATE", 10, 3, true]);
    });

    it("carries the server's NOTICE, in the server's own language", async () => {
        const result = await driver.execute("DROP TABLE IF EXISTS mcp_db_no_such_table", { transaction: "rollback" });
        expect(result.statements[0].notices?.length).toBe(1);
        expect(result.statements[0].notices?.[0]).toMatch(/mcp_db_no_such_table/);
    });

    it("catalog reads the system catalogs", async () => {
        const listing = await listRelations(driver, "pg_catalog");
        expect(listing.relations.rows.some((relation) => relation.name === "pg_class")).toBe(true);
        const description = await describeRelation(driver, ["pg_catalog"], ["pg_class"]);
        expect(description?.columns.some((column) => column.name === "relname")).toBe(true);
        expect(await describeRelation(driver, ["public"], ["mcp_db_no_such_table"])).toBeNull();
        // No schema: the search_path, as SQL resolves an unqualified name
        const unqualified = await describeRelation(driver, null, ["pg_class"]);
        expect(unqualified?.schema).toBe("pg_catalog");
    });
});
