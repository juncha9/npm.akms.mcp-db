import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDbMcpServer, type DbMcpServerInstance } from "@/server";
import { startPgliteServer, type PgliteServer } from "./support/pglite-server";

// The tools as an agent sees them: a real MCP client over an in-memory transport, the real
// server, PGlite behind it. Tables are prefixed tl_.

interface ToolText {
    text: string;
    isError: boolean;
}

describe("MCP tools against PGlite", () => {
    let database: PgliteServer;
    let instance: DbMcpServerInstance;
    let client: Client;

    beforeAll(async () => {
        database = await startPgliteServer();
        instance = createDbMcpServer({ DB_DRIVER: "postgres", DB_URL: database.url, DB_SSL: "off", DB_MAX_ROWS: "3" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await instance.server.connect(serverTransport);
        client = new Client({ name: "tools-test", version: "0" });
        await client.connect(clientTransport);
        await callTool("db_query", {
            sql: "CREATE TABLE tl_parent (id int PRIMARY KEY);"
                + " CREATE TABLE tl_child (parent_id int REFERENCES tl_parent DEFERRABLE INITIALLY DEFERRED);"
                + " CREATE TABLE tl_cancel (id int);"
                + " CREATE TABLE tl_do (id int)",
        });
    }, 30000);

    afterAll(async () => {
        await client?.close();
        await instance?.shutdown();
        await database?.stop();
    });

    async function callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<ToolText> {
        const result = await client.callTool({ name: name, arguments: args }, undefined, options);
        const content = result.content as { text: string }[];
        return { text: content.map((part) => part.text).join("\n"), isError: result.isError === true };
    }

    it("tells a syntax error apart from a policy refusal", async () => {
        const typo = await callTool("db_query", { sql: "SELECT id, FROM tl_parent" });
        expect(typo.isError).toBe(true);
        expect(typo.text).toMatch(/^SQL syntax error: /);
        expect(typo.text).toMatch(/fix the statement and send it again/);

        const policy = await callTool("db_query", { sql: "TRUNCATE tl_parent" });
        expect(policy.text).toMatch(/^Refused by the guard: /);
    });

    it("refuses COPY to STDOUT as unsupported and keeps serving", async () => {
        const copy = await callTool("db_query", { sql: "COPY tl_parent TO STDOUT" });
        expect(copy.isError).toBe(true);
        expect(copy.text).toMatch(/^Not supported by this tool: COPY/);

        const after = await callTool("db_query", { sql: "SELECT 1 AS alive" });
        expect(after.text).toMatch(/\{"alive":1\}/);
    });

    it("reports a failed COMMIT with the server's code and that nothing took effect", async () => {
        const commit = await callTool("db_query", { sql: "INSERT INTO tl_parent VALUES (1); INSERT INTO tl_child VALUES (999)" });
        expect(commit.isError).toBe(true);
        expect(commit.text).toMatch(/^COMMIT failed: /);
        expect(commit.text).toMatch(/code 23503/);
        expect(commit.text).toMatch(/none of the 2 statements of this call took effect/);
        expect(commit.text).toMatch(/SET CONSTRAINTS ALL IMMEDIATE/);

        const parents = await callTool("db_query", { sql: "SELECT count(*) AS n FROM tl_parent" });
        expect(parents.text).toMatch(/\{"n":"0"\}/);
    });

    it("shows the committed statements' results when a later autocommit statement fails", async () => {
        const partial = await callTool("db_query", {
            sql: "INSERT INTO tl_parent VALUES (10) RETURNING id; SELECT 1 / 0",
            transaction: false,
        });
        expect(partial.isError).toBe(true);
        expect(partial.text).toMatch(/statement 2 of 2 failed: division by zero/);
        expect(partial.text).toMatch(/statement 1 was committed before it failed\. Its result:\n\[1\] INSERT · 1 row/);
        expect(partial.text).toMatch(/\{"id":10\}/);
        expect(partial.text).toMatch(/Statement 2 did not take effect/);
    });

    it("an autocommit statement whose deferred constraint fails at commit returns an error instead of hanging", async () => {
        const deferred = await callTool("db_query", { sql: "INSERT INTO tl_child VALUES (998)", transaction: false });
        expect(deferred.isError).toBe(true);
        expect(deferred.text).toMatch(/statement 1 of 1 failed: .*foreign key/);
        expect(deferred.text).toMatch(/Statement 1 did not take effect/);
    }, 15000);

    it("does not claim a failed autocommit DO block had no effect — it can COMMIT part of its work first", async () => {
        const failed = await callTool("db_query", {
            sql: "DO $$ BEGIN INSERT INTO tl_do VALUES (1); COMMIT; RAISE EXCEPTION 'boom after commit'; END $$",
            transaction: false,
        });
        expect(failed.isError).toBe(true);
        expect(failed.text).toMatch(/boom after commit/);
        expect(failed.text).toMatch(/can COMMIT inside itself — what it committed before the error stays/);
        expect(failed.text).not.toMatch(/did not take effect/);

        const rows = await callTool("db_query", { sql: "SELECT count(*) AS n FROM tl_do" });
        expect(rows.text).toMatch(/\{"n":"1"\}/);
    }, 15000);

    it("prints json nested thousands of levels deep — a committed write is not reported as failed by the formatter", async () => {
        const result = await callTool("db_query", { sql: "SELECT (repeat('[', 5000) || '1' || repeat(']', 5000))::jsonb AS deep" });
        expect(result.isError).not.toBe(true);
        expect(result.text).toMatch(/^1 statement · \d+ ms · committed\n\[1\] SELECT · 1 row/);
    }, 15000);

    it("shows the notices a failed statement sent — a procedure's progress is how to tell what it committed", async () => {
        const failed = await callTool("db_query", {
            sql: "SELECT 1 AS before; DO $$ BEGIN RAISE NOTICE 'batch 1 committed'; RAISE EXCEPTION 'batch 2 failed'; END $$",
            transaction: false,
        });
        expect(failed.isError).toBe(true);
        expect(failed.text).toMatch(/statement 2 of 2 failed: batch 2 failed/);
        expect(failed.text).toMatch(/Statement 2 sent before it failed:\n {2}NOTICE: batch 1 committed/);
        // The committed statement's result still follows
        expect(failed.text).toMatch(/Autocommit: statement 1 was committed before it failed/);
    }, 15000);

    it("refuses an integer param past 2^53 — it arrived rounded — and binds the same value given as a string", async () => {
        const rounded = await callTool("db_query", { sql: "SELECT $1::int8 AS id", params: [2 ** 53 + 2] });
        expect(rounded.isError).toBe(true);
        expect(rounded.text).toMatch(/pass them as strings/);

        const exact = await callTool("db_query", { sql: "SELECT $1::int8 AS id", params: ["9007199254740993"] });
        expect(exact.text).toMatch(/\{"id":"9007199254740993"\}/);
    });

    it("cuts an error at DB_MAX_OUTPUT too — a server message can quote a whole input value", async () => {
        // The smallest limit allowed: a quoted 5000-character value is capped, so the lines after it still fit
        const smallOutput = createDbMcpServer({ DB_DRIVER: "postgres", DB_URL: database.url, DB_SSL: "off", DB_MAX_OUTPUT: "2000" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await smallOutput.server.connect(serverTransport);
        const smallClient = new Client({ name: "tools-test-small", version: "0" });
        await smallClient.connect(clientTransport);
        try {
            const result = await smallClient.callTool({ name: "db_query", arguments: { sql: `SELECT '${"9".repeat(5000)}x'::int` } });
            const text = (result.content as { text: string }[])[0].text;
            expect(result.isError).toBe(true);
            expect(text).toMatch(/^statement 1 of 1 failed: .*"9{100}/);
            expect(text).toMatch(/… \(\d+ more characters\)/);
            expect(text).toMatch(/The transaction was rolled back — no statement of this call took effect\./);
            expect(text.length).toBeLessThanOrEqual(2000);
        }
        finally {
            await smallClient.close();
            await smallOutput.shutdown();
        }
    });

    describe("db_explain", () => {
        it("says what to send instead of an EXPLAIN-wrapped or non-explainable statement — not a syntax error, not policy", async () => {
            const wrapped = await callTool("db_explain", { sql: "EXPLAIN ANALYZE SELECT 1" });
            expect(wrapped.text).toMatch(/^Not supported by this tool: db_explain adds EXPLAIN itself/);

            const show = await callTool("db_explain", { sql: "SHOW search_path" });
            expect(show.text).toMatch(/^Not supported by this tool: VariableShow cannot be EXPLAINed/);
        });

        it("points a server error into the agent's own statement, not into the EXPLAIN wrapper", async () => {
            const failed = await callTool("db_explain", { sql: "SELECT no_such_column FROM tl_parent" });
            expect(failed.text).toMatch(/column "no_such_column" does not exist/);
            expect(failed.text).toMatch(/at character 8 of that statement/);
        });

        it("tests deny patterns against the statement as written, so an anchored pattern still holds", async () => {
            const anchored = createDbMcpServer({ DB_DRIVER: "postgres", DB_URL: database.url, DB_SSL: "off", DB_DENY_PATTERNS: "^\\s*delete\\b" });
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await anchored.server.connect(serverTransport);
            const anchoredClient = new Client({ name: "tools-test-deny", version: "0" });
            await anchoredClient.connect(clientTransport);
            try {
                const result = await anchoredClient.callTool({ name: "db_explain", arguments: { sql: "DELETE FROM tl_parent WHERE id = 1", analyze: true } });
                const text = (result.content as { text: string }[])[0].text;
                expect(text).toMatch(/^Refused by the guard: matches the deny pattern/);
                expect(text).toMatch(/statement 1: DELETE FROM tl_parent WHERE id = 1/);
            }
            finally {
                await anchoredClient.close();
                await anchored.shutdown();
            }
        });

        it("does not test deny patterns against its own EXPLAIN wrapper — /analyze/ must not refuse every plan", async () => {
            const noAnalyze = createDbMcpServer({ DB_DRIVER: "postgres", DB_URL: database.url, DB_SSL: "off", DB_DENY_PATTERNS: "\\banalyze\\b" });
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await noAnalyze.server.connect(serverTransport);
            const noAnalyzeClient = new Client({ name: "tools-test-wrapper", version: "0" });
            await noAnalyzeClient.connect(clientTransport);
            try {
                const result = await noAnalyzeClient.callTool({ name: "db_explain", arguments: { sql: "SELECT 1" } });
                expect((result.content as { text: string }[])[0].text).toMatch(/^plan \(not executed\)\nResult/);
                // The agent's own text is still screened
                const own = await noAnalyzeClient.callTool({ name: "db_explain", arguments: { sql: "SELECT 1 AS analyze_me, 'analyze' AS word" } });
                expect((own.content as { text: string }[])[0].text).toMatch(/^Refused by the guard: matches the deny pattern/);
            }
            finally {
                await noAnalyzeClient.close();
                await noAnalyze.shutdown();
            }
        });

        it("says how to plan a prepared statement — the PREPARE of an earlier call is gone", async () => {
            const result = await callTool("db_explain", { sql: "EXECUTE tl_q(1)" });
            // Advice a read-only database can follow too — it refuses PREPARE
            expect(result.text).toMatch(/^Not supported by this tool: a prepared statement does not outlive the db_query call that PREPAREd it — send the prepared statement's own SQL to db_explain instead, with its \$1, \$2, … values in params/);
        });

        it("still plans a write without running it", async () => {
            const plan = await callTool("db_explain", { sql: "DELETE FROM tl_parent WHERE id = 1" });
            expect(plan.text).toMatch(/^plan \(not executed\)\nDelete on tl_parent/);
        });
    });

    it("caps a server message that quotes a huge value, so the lines saying what committed still show", async () => {
        const failed = await callTool("db_query", {
            sql: `INSERT INTO tl_parent VALUES (77) RETURNING id; SELECT '${"9".repeat(150000)}'::int`,
            transaction: false,
        });
        expect(failed.isError).toBe(true);
        expect(failed.text).toMatch(/statement 2 of 2 failed: .*… \(\d+ more characters\)/);
        expect(failed.text).toMatch(/Autocommit: statement 1 was committed before it failed/);
        expect(failed.text).toMatch(/\{"id":77\}/);
        expect(failed.text).not.toMatch(/\[truncated/);
        await callTool("db_query", { sql: "DELETE FROM tl_parent WHERE id = 77" });
    });

    it("refuses a float param at or past 2^53 with advice that covers floats too", async () => {
        const result = await client.callTool({ name: "db_query", arguments: { sql: "SELECT $1::float8 AS v", params: [1e20] } }).catch((ex: unknown) => ex);
        expect(JSON.stringify(result)).toMatch(/numbers at or beyond ±2\^53 lose digits as JSON numbers/);
    });

    it("plans a CREATE TABLE … AS with db_explain even when DDL is off — the plan creates nothing", async () => {
        const ddlOff = createDbMcpServer({ DB_DRIVER: "postgres", DB_URL: database.url, DB_SSL: "off", DB_ALLOW_DDL: "false" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await ddlOff.server.connect(serverTransport);
        const ddlOffClient = new Client({ name: "tools-test-ddl-off", version: "0" });
        await ddlOffClient.connect(clientTransport);
        try {
            const plan = await ddlOffClient.callTool({ name: "db_explain", arguments: { sql: "CREATE TABLE tl_never AS SELECT * FROM tl_parent" } });
            expect((plan.content as { text: string }[])[0].text).toMatch(/^plan \(not executed\)/);
            const run = await ddlOffClient.callTool({ name: "db_explain", arguments: { sql: "CREATE TABLE tl_never AS SELECT * FROM tl_parent", analyze: true } });
            expect((run.content as { text: string }[])[0].text).toMatch(/^Refused by the guard: schema changes \(DDL\) are disabled/);
        }
        finally {
            await ddlOffClient.close();
            await ddlOff.shutdown();
        }
    });

    it("a call the client abandons is rolled back, not committed", async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        await expect(callTool(
            "db_query",
            { sql: "INSERT INTO tl_cancel VALUES (1); SELECT pg_sleep(0.4); INSERT INTO tl_cancel VALUES (2)" },
            { signal: controller.signal }
        )).rejects.toThrow();

        // The server finishes the call in the background; give it time to reach its next check and roll back
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const rows = await callTool("db_query", { sql: "SELECT count(*) AS n FROM tl_cancel" });
        expect(rows.text).toMatch(/\{"n":"0"\}/);
    }, 15000);
});
