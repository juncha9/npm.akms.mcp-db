import type pg from "pg";
import { Worker } from "node:worker_threads";
import Cursor from "pg-cursor";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GuardRejectionError } from "@/modules/guard/guard-error";
import { PARSER_IDLE_TIMEOUT_MS } from "@/modules/guard/sql-parser";
import { loadDbProfile } from "@/modules/profile";
import { CallCancelledError, CommitError, PostgresDriver, StatementError } from "@/modules/postgres/postgres-driver";
import { startPgliteServer, type PgliteServer } from "./support/pglite-server";
import { startTcpProxy, type TcpProxy } from "./support/tcp-proxy";

// The driver against a real PostgreSQL backend (PGlite), through a TCP proxy that can cut the
// connection on cue. PGlite shares one backend session between connections, so nothing here
// relies on session isolation — tables are plain and prefixed drv_.

const CANCEL_REQUEST_CODE = 80877102;

describe("PostgresDriver against PGlite", () => {
    let database: PgliteServer;
    let proxy: TcpProxy;
    let driver: PostgresDriver;

    beforeAll(async () => {
        database = await startPgliteServer();
        proxy = await startTcpProxy(database.port);
        const profile = loadDbProfile({
            DB_DRIVER: "postgres",
            DB_URL: `postgres://postgres@127.0.0.1:${proxy.port}/postgres`,
            DB_SSL: "off",
            DB_MAX_ROWS: "3",
        });
        driver = new PostgresDriver(profile!);
        await driver.execute(
            "CREATE TABLE drv_parent (id int PRIMARY KEY);"
            + " CREATE TABLE drv_child (parent_id int REFERENCES drv_parent DEFERRABLE INITIALLY DEFERRED);"
            + " CREATE FUNCTION drv_insert_child(i int) RETURNS int LANGUAGE sql AS $$ INSERT INTO drv_child VALUES (i) RETURNING i $$;"
            + " CREATE TABLE drv_cancel (id int);"
            + " CREATE TABLE drv_fatal (id int);"
            + " CREATE TABLE drv_returning (id int, v int)",
            { transaction: "commit" }
        );
    }, 30000);

    afterAll(async () => {
        await driver?.close();
        await proxy?.stop();
        await database?.stop();
    });

    async function countRows(table: string): Promise<string> {
        const result = await driver.execute(`SELECT count(*) AS n FROM ${table}`, { transaction: "commit" });
        return String(result.statements[0].rows[0].n);
    }

    it.each(["commit", "rollback"] as const)("parser retirement preserves an active %s transaction and its connection", async (transaction) => {
        const isolated = new PostgresDriver(loadDbProfile({ DB_DRIVER: "postgres", DB_URL: database.url, DB_SSL: "off" })!);
        await isolated.execute("CREATE TABLE IF NOT EXISTS drv_parser_idle (id int)", { transaction: "commit" });
        const pool = (isolated as unknown as { pool: pg.Pool }).pool;
        const cursorPrototype = Cursor.prototype as unknown as { read: (...args: unknown[]) => Promise<unknown> };
        const originalRead = cursorPrototype.read;
        let release!: () => void;
        let markReached!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const reached = new Promise<void>(resolve => { markReached = resolve; });
        let held = false;
        const read = vi.spyOn(cursorPrototype, "read").mockImplementation(async function(this: unknown, ...args) {
            const rows = await originalRead.apply(this, args);
            if(!held) {
                held = true;
                markReached();
                await gate; // The write ran, but the driver is still inside its transaction.
            }
            return rows;
        });
        const stopped = vi.spyOn(Worker.prototype, "terminate");
        let outcome: ReturnType<PostgresDriver["execute"]> | undefined;
        try {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            outcome = isolated.execute(`INSERT INTO drv_parser_idle VALUES (${transaction === "commit" ? 1 : 2}) RETURNING id`, { transaction });
            await Promise.race([reached, outcome.then(() => { throw new Error("query did not reach its held result"); })]);
            expect(pool.totalCount).toBe(1);
            expect(pool.idleCount).toBe(0);
            vi.advanceTimersByTime(PARSER_IDLE_TIMEOUT_MS);
            expect(stopped).toHaveBeenCalledTimes(1);
            await stopped.mock.results[0].value;
            expect(pool.totalCount).toBe(1);
            expect(pool.idleCount).toBe(0);
            release();
            const result = await outcome;
            expect(result.transaction).toBe(transaction);
            expect(result.statements[0].rowCount).toBe(1);
            expect(result.statements[0].rows).toEqual([{ id: transaction === "commit" ? 1 : 2 }]);
            const stored = await isolated.execute(`SELECT count(*) AS n FROM drv_parser_idle WHERE id = ${transaction === "commit" ? 1 : 2}`, { transaction: "commit" });
            expect(stored.statements[0].rows[0].n).toBe(transaction === "commit" ? "1" : "0");
            expect(pool.totalCount).toBe(1);
            await isolated.execute("DELETE FROM drv_parser_idle WHERE id > 0", { transaction: "commit" });
        } finally {
            release();
            await outcome?.catch(() => undefined);
            read.mockRestore();
            stopped.mockRestore();
            await isolated.close();
            vi.useRealTimers();
        }
    });

    describe("a connection lost mid-call", () => {
        it("fails that call instead of the process, and the next call gets a fresh connection", async () => {
            proxy.dropWhenSeen("drv_drop_marker_1");
            await expect(driver.execute("SELECT 'drv_drop_marker_1' AS marker", { transaction: "commit" })).rejects.toThrow();

            const result = await driver.execute("SELECT 1 AS ok", { transaction: "commit" });
            expect(result.statements[0].rows).toEqual([{ ok: 1 }]);
        }, 15000);

        it("in autocommit too, after earlier statements already ran on that connection", async () => {
            proxy.dropWhenSeen("drv_drop_marker_2");
            await expect(driver.execute("SELECT 1; SELECT 'drv_drop_marker_2'", { transaction: "autocommit" })).rejects.toThrow();

            const result = await driver.execute("SELECT 2 AS ok", { transaction: "autocommit" });
            expect(result.statements[0].rows).toEqual([{ ok: 2 }]);
        }, 15000);
    });

    describe("a server that stops answering while the socket stays open (a dead hop behind a tunnel)", () => {
        it("a cancelled call ends within the grace period and frees its connection", async () => {
            proxy.blackholeWhenSeen("drv_silent_1");
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 200);
            const startedAt = Date.now();
            await expect(driver.execute("SELECT 'drv_silent_1' AS marker", { transaction: "commit", signal: controller.signal })).rejects.toThrow();
            // 200 ms until the abort, then the 5 s grace before the socket is cut
            expect(Date.now() - startedAt).toBeLessThan(8000);

            const result = await driver.execute("SELECT 1 AS ok", { transaction: "commit" });
            expect(result.statements[0].rows).toEqual([{ ok: 1 }]);
        }, 15000);

        it("abortActiveConnections ends a stuck call — what the process-level safety net uses", async () => {
            proxy.blackholeWhenSeen("drv_silent_2");
            const stuck = driver.execute("SELECT 'drv_silent_2' AS marker", { transaction: "commit" }).catch((ex: unknown) => ex);
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(driver.abortActiveConnections(new Error("test: cut active connections"))).toBe(1);
            expect(await stuck).toBeInstanceOf(StatementError);

            const result = await driver.execute("SELECT 2 AS ok", { transaction: "commit" });
            expect(result.statements[0].rows).toEqual([{ ok: 2 }]);
        }, 15000);

        it("close() does not wait forever on a stuck call", async () => {
            const profile = loadDbProfile({
                DB_DRIVER: "postgres",
                DB_URL: `postgres://postgres@127.0.0.1:${proxy.port}/postgres`,
                DB_SSL: "off",
            });
            const closingDriver = new PostgresDriver(profile!);
            proxy.blackholeWhenSeen("drv_silent_3");
            const stuck = closingDriver.execute("SELECT 'drv_silent_3' AS marker", { transaction: "commit" }).catch((ex: unknown) => ex);
            await new Promise((resolve) => setTimeout(resolve, 200));
            await closingDriver.close();
            expect(await stuck).toBeInstanceOf(Error);
        }, 15000);
    });

    describe("a session ended right after the server answered (shutdown, failover)", () => {
        it("commit mode: a COMMIT that went through is reported as committed, though FATAL follows in the same breath", async () => {
            proxy.fatalAfterReply("COMMIT");
            const result = await driver.execute("INSERT INTO drv_fatal VALUES (1); INSERT INTO drv_fatal VALUES (2)", { transaction: "commit" });
            expect(result.transaction).toBe("commit");
            expect(await countRows("drv_fatal")).toBe("2");
        }, 15000);

        it("autocommit: the statement that committed keeps its result, and the next one is reported as unknown, not as rolled back", async () => {
            proxy.fatalAfterReply("INSERT");
            const failure = await driver.execute("INSERT INTO drv_fatal VALUES (3) RETURNING id; SELECT 1", { transaction: "autocommit" })
                .catch((ex: unknown) => ex);
            expect(failure).toBeInstanceOf(StatementError);
            expect((failure as StatementError).statementIndex).toBe(2);
            expect((failure as StatementError).connectionLost).toBe(true);
            expect((failure as StatementError).completed.map((statement) => statement.rows)).toEqual([[{ id: 3 }]]);
            expect(await countRows("drv_fatal")).toBe("3");
        }, 15000);
    });

    describe("writes whose RETURNING output is longer than the row limit (3 here)", () => {
        it("keeps the full affected count; every row was written", async () => {
            const result = await driver.execute(
                "INSERT INTO drv_returning SELECT g, 0 FROM generate_series(1, 10) g RETURNING id;"
                + " UPDATE drv_returning SET v = v + 1 WHERE id > 0 RETURNING id, v;"
                + " WITH removed AS (DELETE FROM drv_returning WHERE id > 4 RETURNING id) SELECT * FROM removed",
                { transaction: "rollback" }
            );
            expect(result.statements.map((statement) => [statement.command, statement.rowCount, statement.rows.length, statement.truncated])).toEqual([
                ["INSERT", 10, 3, true],
                ["UPDATE", 10, 3, true],
                // A SELECT whose WITH writes is not drained: those writes finish when the portal closes, and with
                // the read stopped early no command tag arrives
                [null, null, 3, true],
            ]);
        });

        it("autocommit: a deferred constraint failing at the commit after the drain is still that statement's error", async () => {
            const failure = await driver.execute(
                "INSERT INTO drv_child SELECT 2000 + g FROM generate_series(1, 10) g RETURNING parent_id",
                { transaction: "autocommit" }
            ).catch((ex: unknown) => ex);
            expect(failure).toBeInstanceOf(StatementError);
            expect(((failure as StatementError).cause as { code: string }).code).toBe("23503");
            expect(await countRows("drv_child")).toBe("0");
        }, 15000);

        it("a plain EXPLAIN of a write is a plan, not a write: nothing is drained or claimed to have run", async () => {
            const result = await driver.execute(
                "EXPLAIN (VERBOSE) INSERT INTO drv_returning SELECT g, g FROM generate_series(1, 5) g ORDER BY g",
                { transaction: "commit" }
            );
            const plan = result.statements[0];
            expect(plan.truncated).toBe(true);
            expect(plan.rowCount).toBeNull();
            expect(plan.writes).toBe(false);
            expect(await countRows("drv_returning")).toBe("0");
        });

        it("a truncated SELECT is not drained — the rows past the limit are never computed", async () => {
            const result = await driver.execute("SELECT g FROM generate_series(1, 1000000) g", { transaction: "commit" });
            expect(result.statements[0].rowCount).toBeNull();
            expect(result.statements[0].truncated).toBe(true);
        });
    });

    describe("values JSON cannot carry through a double", () => {
        it("keeps numeric[] digits, float NaN / Infinity, and json numbers past a double's precision as the server's text", async () => {
            const result = await driver.execute(
                "SELECT ARRAY[12345678901234567890.12, 1.10, NULL]::numeric[] AS amounts,"
                + " 'NaN'::float8 AS nan, '-Infinity'::float4 AS ninf, 2.5::float8 AS plain_float,"
                + " ARRAY[1.5, 'NaN']::float8[] AS floats,"
                + " '{\"id\": 12345678901234567890, \"price\": 1.10}'::jsonb AS big_json,"
                + " '{\"a\": 1, \"b\": [true, null, 2.5]}'::jsonb AS small_json,"
                + " ARRAY['{\"x\": 1}', '{\"y\": 12345678901234567890}']::jsonb[] AS json_array,"
                + " 9007199254740993::int8 AS big_int",
                { transaction: "commit" }
            );
            const row = result.statements[0].rows[0];
            expect(row.amounts).toEqual(["12345678901234567890.12", "1.10", null]);
            expect(row.nan).toBe("NaN");
            expect(row.ninf).toBe("-Infinity");
            expect(row.plain_float).toBe(2.5);
            expect(row.floats).toEqual([1.5, "NaN"]);
            // Still an object; only the number a double cannot hold keeps the server's digits (1.10 is exactly 1.1)
            expect(typeof row.big_json).toBe("object");
            expect(JSON.stringify(row.big_json)).toBe("{\"id\":12345678901234567890,\"price\":1.1}");
            expect(row.small_json).toEqual({ a: 1, b: [true, null, 2.5] });
            expect((row.json_array as unknown[])[0]).toEqual({ x: 1 });
            expect(JSON.stringify((row.json_array as unknown[])[1])).toBe("{\"y\":12345678901234567890}");
            expect(row.big_int).toBe("9007199254740993");
        });

        it("judges json numbers exactly: a 17-digit double that reads back unchanged stays a number; 1e-400 does not become 0", async () => {
            const result = await driver.execute(
                "SELECT to_jsonb(0.1::float8 + 0.2::float8) AS sum, json_build_object('v', 1.0::float8 / 3) AS third,"
                + " '1e20'::jsonb AS big_exact, '1e-400'::json AS tiny",
                { transaction: "commit" }
            );
            const row = result.statements[0].rows[0];
            expect(row.sum).toBe(0.30000000000000004);
            expect(row.third).toEqual({ v: 0.3333333333333333 });
            expect(row.big_exact).toBe(1e20);
            expect(JSON.stringify(row.tiny)).toBe("1e-400");
        });

        it("returns json nested deeper than a reviver's stack allows as the server's text — without throwing inside pg's socket handler", async () => {
            const result = await driver.execute(
                "SELECT (repeat('[', 3000) || '1' || repeat(']', 3000))::jsonb AS deep,"
                + " (repeat('[', 6000) || '12345678901234567890' || repeat(']', 6000))::json AS deeper",
                { transaction: "commit" }
            );
            const row = result.statements[0].rows[0];
            // Text, not a parsed value: JSON.stringify of a value this deep would overflow the stack in the formatter
            expect(row.deep).toBe(`${"[".repeat(3000)}1${"]".repeat(3000)}`);
            expect(row.deeper).toBe(`${"[".repeat(6000)}12345678901234567890${"]".repeat(6000)}`);
        });
    });

    describe("what each statement reports", () => {
        it("carries the server's NOTICE — a skipped CREATE … IF NOT EXISTS says so", async () => {
            const result = await driver.execute("CREATE TABLE IF NOT EXISTS drv_parent (other_column text)", { transaction: "commit" });
            expect(result.statements[0].notices?.[0]).toMatch(/^NOTICE: relation "drv_parent" already exists, skipping/);
        });

        it("keeps a statement's first 20 notices and counts the rest apart, not as a 21st notice", async () => {
            const result = await driver.execute(
                "DO $$ BEGIN FOR i IN 1..25 LOOP RAISE NOTICE 'step %', i; END LOOP; END $$",
                { transaction: "commit" }
            );
            expect(result.statements[0].notices?.length).toBe(20);
            expect(result.statements[0].notices?.[19]).toBe("NOTICE: step 20");
            expect(result.statements[0].droppedNotices).toBe(5);
        });

        it("keeps every column of a result whose names collide, __proto__ included", async () => {
            const result = await driver.execute("SELECT 1 AS a, 2 AS a, 3 AS \"a#2\", 4 AS \"__proto__\"", { transaction: "commit" });
            const row = result.statements[0].rows[0];
            expect(Object.keys(row)).toEqual(["a", "a#3", "a#2", "__proto__"]);
            expect(JSON.stringify(row)).toBe("{\"a\":1,\"a#3\":2,\"a#2\":3,\"__proto__\":4}");
        });

        it("sets the profile's statement_timeout on every call itself, in a transaction and in autocommit", async () => {
            const inTransaction = await driver.execute("SHOW statement_timeout", { transaction: "commit" });
            expect(inTransaction.statements[0].rows[0]).toEqual({ statement_timeout: "1min" });
            const inAutocommit = await driver.execute("SHOW statement_timeout", { transaction: "autocommit" });
            expect(inAutocommit.statements[0].rows[0]).toEqual({ statement_timeout: "1min" });
        });

        it("says the pool is busy — not that the database is unreachable — when no connection frees up in time", async () => {
            const profile = loadDbProfile({
                DB_DRIVER: "postgres",
                DB_URL: `postgres://postgres@127.0.0.1:${proxy.port}/postgres`,
                DB_SSL: "off",
                DB_CONNECT_TIMEOUT_MS: "300",
            });
            const busyDriver = new PostgresDriver(profile!);
            try {
                const holders = [
                    busyDriver.execute("SELECT pg_sleep(1)", { transaction: "commit" }).catch(() => undefined),
                    busyDriver.execute("SELECT pg_sleep(1)", { transaction: "commit" }).catch(() => undefined),
                ];
                await new Promise((resolve) => setTimeout(resolve, 100));
                await expect(busyDriver.execute("SELECT 1", { transaction: "commit" })).rejects.toThrow(/all 2 database connections are busy with other calls/);
                await Promise.all(holders);
            }
            finally {
                await busyDriver.close();
            }
        }, 15000);
    });

    describe("COPY through STDIN / STDOUT", () => {
        it.each([
            "COPY drv_parent TO STDOUT",
            "COPY (SELECT 1) TO STDOUT",
            "COPY drv_parent FROM STDIN",
        ])("%s is refused as unsupported before anything is sent", async (sql) => {
            const failure = await driver.execute(sql, { transaction: "commit" }).catch((ex: unknown) => ex);
            expect(failure).toBeInstanceOf(GuardRejectionError);
            expect((failure as GuardRejectionError).verdict.kind).toBe("unsupported");
        });
    });

    describe("errors raised at commit time", () => {
        it("autocommit: a deferred constraint failing at the implicit commit is that statement's error, not a hang", async () => {
            for(let attempt = 0; attempt < 3; attempt++) {
                const failure = await driver.execute("INSERT INTO drv_child VALUES (999)", { transaction: "autocommit" }).catch((ex: unknown) => ex);
                expect(failure).toBeInstanceOf(StatementError);
                expect((failure as StatementError).statementIndex).toBe(1);
                expect(((failure as StatementError).cause as { code: string }).code).toBe("23503");
            }
            // Three failures did not keep three connections checked out — the pool holds two
            expect(await countRows("drv_child")).toBe("0");
        }, 20000);

        it("autocommit: a truncated read does not report success when the commit then fails", async () => {
            const failure = await driver.execute(
                "SELECT drv_insert_child(1000 + g) AS inserted FROM generate_series(1, 10) g",
                { transaction: "autocommit" }
            ).catch((ex: unknown) => ex);
            expect(failure).toBeInstanceOf(StatementError);
            expect(((failure as StatementError).cause as { code: string }).code).toBe("23503");
            expect(await countRows("drv_child")).toBe("0");
        }, 15000);

        it("commit mode: a failing COMMIT is a CommitError naming the server's code, and nothing persisted", async () => {
            const failure = await driver.execute(
                "INSERT INTO drv_parent VALUES (1); INSERT INTO drv_child VALUES (999)",
                { transaction: "commit" }
            ).catch((ex: unknown) => ex);
            expect(failure).toBeInstanceOf(CommitError);
            expect(((failure as CommitError).cause as { code: string }).code).toBe("23503");
            expect((failure as CommitError).statementCount).toBe(2);
            expect(await countRows("drv_parent")).toBe("0");
        }, 15000);
    });

    describe("autocommit failure after committed statements", () => {
        it("keeps the results of the statements that already committed", async () => {
            const failure = await driver.execute(
                "INSERT INTO drv_parent VALUES (10) RETURNING id; SELECT 1 / 0",
                { transaction: "autocommit" }
            ).catch((ex: unknown) => ex);
            expect(failure).toBeInstanceOf(StatementError);
            expect((failure as StatementError).statementIndex).toBe(2);
            expect((failure as StatementError).completed.map((statement) => statement.rows)).toEqual([[{ id: 10 }]]);
            await driver.execute("DELETE FROM drv_parent WHERE id = 10", { transaction: "commit" });
        }, 15000);

        it("an ordinary ERROR in SQLSTATE class 08 — a wrong number of params — is no lost connection", async () => {
            const failure = await driver.execute("INSERT INTO drv_parent VALUES ($1)", { params: [1, 2], transaction: "autocommit" })
                .catch((ex: unknown) => ex);
            expect(failure).toBeInstanceOf(StatementError);
            expect(((failure as StatementError).cause as { code: string }).code).toBe("08P01");
            expect((failure as StatementError).connectionLost).toBe(false);
        });

        it("keeps the NOTICE lines a failing statement sent — a procedure's progress says what it committed", async () => {
            const failure = await driver.execute(
                "DO $$ BEGIN RAISE NOTICE 'batch 1 committed'; RAISE WARNING 'careful'; PERFORM 1 / 0; END $$",
                { transaction: "autocommit" }
            ).catch((ex: unknown) => ex);
            expect(failure).toBeInstanceOf(StatementError);
            expect((failure as StatementError).notices).toEqual(["NOTICE: batch 1 committed", "WARNING: careful"]);
        });
    });

    describe("cancellation", () => {
        it("an already-aborted call is refused before it reaches the database", async () => {
            const controller = new AbortController();
            controller.abort();
            const failure = await driver.execute("INSERT INTO drv_cancel VALUES (1)", { transaction: "commit", signal: controller.signal })
                .catch((ex: unknown) => ex);
            expect(failure).toBeInstanceOf(CallCancelledError);
            expect(await countRows("drv_cancel")).toBe("0");
        });

        it("aborting mid-call sends a CancelRequest and rolls back instead of committing", async () => {
            const chunksBefore = proxy.firstChunks.length;
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 100);
            const failure = await driver.execute(
                "INSERT INTO drv_cancel VALUES (1); SELECT pg_sleep(0.4); INSERT INTO drv_cancel VALUES (2)",
                { transaction: "commit", signal: controller.signal }
            ).catch((ex: unknown) => ex);

            // PGlite ignores CancelRequest, so the sleep finishes and the next boundary stops the call
            expect(failure).toBeInstanceOf(CallCancelledError);
            expect(await countRows("drv_cancel")).toBe("0");

            const cancelPackets = proxy.firstChunks.slice(chunksBefore).filter((chunk) => {
                return chunk.length === 16 && chunk.readInt32BE(0) === 16 && chunk.readInt32BE(4) === CANCEL_REQUEST_CODE;
            });
            expect(cancelPackets.length).toBe(1);
        }, 15000);

        it("a connection a CancelRequest went out for is discarded — the request could land on the next call's statement", async () => {
            const pool = (driver as unknown as { pool: pg.Pool }).pool;
            // 'release' carries the error the driver passed — an error there is what makes pg-pool destroy the client
            const releaseErrors: (Error | undefined)[] = [];
            const onRelease = (error: Error | undefined) => {
                releaseErrors.push(error);
            };
            pool.on("release", onRelease);
            const controller = new AbortController();
            // Abort once the call holds its connection — an abort before that sends no CancelRequest and keeps the connection
            pool.once("acquire", () => {
                setTimeout(() => controller.abort(), 50);
            });
            await driver.execute("SELECT pg_sleep(0.3)", { transaction: "commit", signal: controller.signal }).catch(() => undefined);
            pool.off("release", onRelease);
            expect(releaseErrors.length).toBe(1);
            expect(releaseErrors[0]?.message).toMatch(/cancel request was sent/);
        }, 15000);

        it("autocommit: a cancel while a write's RETURNING rows are read to the end does not let the closing Sync commit it", async () => {
            const controller = new AbortController();
            // The second read is the first drain batch — abort right before it goes out
            const cursorPrototype = Cursor.prototype as unknown as { read: (...args: unknown[]) => unknown };
            const originalRead = cursorPrototype.read;
            let reads = 0;
            cursorPrototype.read = function(this: unknown, ...args: unknown[]) {
                reads += 1;
                if(reads === 2) {
                    controller.abort();
                }
                return originalRead.apply(this, args);
            };
            let failure: unknown;
            try {
                failure = await driver.execute(
                    "INSERT INTO drv_cancel SELECT g FROM generate_series(1, 5000) g RETURNING id",
                    { transaction: "autocommit", signal: controller.signal }
                ).catch((ex: unknown) => ex);
            }
            finally {
                cursorPrototype.read = originalRead;
            }
            expect(failure).toBeInstanceOf(CallCancelledError);
            expect((failure as Error).message).toMatch(/cancelled during statement 1 of 1, which was rolled back/);
            expect(await countRows("drv_cancel")).toBe("0");
        }, 15000);

        it("autocommit: a cancel during the drain's last, short read comes too late — the write committed and is reported so", async () => {
            const controller = new AbortController();
            const cursorPrototype = Cursor.prototype as unknown as { read: (...args: unknown[]) => unknown };
            const originalRead = cursorPrototype.read;
            let reads = 0;
            cursorPrototype.read = function(this: unknown, ...args: unknown[]) {
                reads += 1;
                const pending = originalRead.apply(this, args) as Promise<unknown>;
                // Read #2 fetches the remaining 496 rows; the cursor sends the committing Sync with them
                if(reads === 2) {
                    controller.abort();
                }
                return pending;
            };
            let outcome: unknown;
            try {
                outcome = await driver.execute(
                    "INSERT INTO drv_cancel SELECT g FROM generate_series(1, 500) g RETURNING id",
                    { transaction: "autocommit", signal: controller.signal }
                ).catch((ex: unknown) => ex);
            }
            finally {
                cursorPrototype.read = originalRead;
            }
            expect(outcome).not.toBeInstanceOf(Error);
            expect((outcome as { statements: { rowCount: number }[] }).statements[0].rowCount).toBe(500);
            expect(await countRows("drv_cancel")).toBe("500");
            await driver.execute("DELETE FROM drv_cancel WHERE id > 0", { transaction: "commit" });
        }, 15000);
    });
});
