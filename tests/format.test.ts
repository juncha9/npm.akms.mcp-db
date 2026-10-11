import { describe, expect, it } from "vitest";
import type { ExecuteResult } from "@/_types";
import { formatGuardRejection } from "@/modules/guard/guard-error";
import { formatDbSummary, formatExecuteResult, formatRelationDescription } from "@/modules/tools/format";
import type { RelationDescription } from "@/modules/postgres/catalog";

describe("formatExecuteResult", () => {
    it("one JSON object per row, the counts, and how the transaction ended", () => {
        const result: ExecuteResult = {
            transaction: "commit",
            readOnly: false,
            durationMs: 9,
            statements: [
                {
                    index: 1, kind: "SelectStmt", command: "SELECT", rowCount: 2, truncated: false, ddl: false, durationMs: 3,
                    fields: [{ name: "id", dataTypeId: 23 }, { name: "at", dataTypeId: 1114 }],
                    rows: [{ id: 1, at: "2026-10-11 04:19:18.491" }, { id: 2, at: null }],
                },
                {
                    index: 2, kind: "UpdateStmt", command: "UPDATE", rowCount: 10, truncated: false, ddl: false, durationMs: 2,
                    fields: [], rows: [],
                },
                {
                    index: 3, kind: "CreateStmt", command: "CREATE", rowCount: null, truncated: false, ddl: true, durationMs: 4,
                    fields: [], rows: [],
                },
            ],
        };
        expect(formatExecuteResult(result)).toBe([
            "3 statements · 9 ms · committed",
            "[1] SELECT · 2 rows · 3 ms",
            "{\"id\":1,\"at\":\"2026-10-11 04:19:18.491\"}",
            "{\"id\":2,\"at\":null}",
            "[2] UPDATE · 10 rows affected · 2 ms",
            "[3] CREATE · DDL · 4 ms",
        ].join("\n"));
    });

    it("says when rows were cut and when a result is empty", () => {
        const result: ExecuteResult = {
            transaction: "rollback",
            readOnly: true,
            durationMs: 5,
            statements: [
                {
                    index: 1, kind: "SelectStmt", command: null, rowCount: null, truncated: true, ddl: false, durationMs: 4,
                    fields: [{ name: "a", dataTypeId: 23 }], rows: [{ a: 1 }],
                },
                {
                    index: 2, kind: "SelectStmt", command: "SELECT", rowCount: 0, truncated: false, ddl: false, durationMs: 1,
                    fields: [{ name: "a", dataTypeId: 23 }, { name: "b", dataTypeId: 25 }], rows: [],
                },
            ],
        };
        const text = formatExecuteResult(result);
        expect(text).toContain("read-only, rolled back");
        expect(text).toContain("[1] SELECT · first 1 row — reading stopped one row past these (to tell there are more); narrow it with WHERE / LIMIT");
        // Below a sort or DISTINCT every row was computed — the heading must not claim otherwise
        expect(text).not.toContain("computed nothing");
        expect(text).toContain("(no rows) columns: a, b");
    });

    it("gives a truncated write its full affected count, and says the cut is only in the listing", () => {
        const base = { truncated: true, ddl: false, durationMs: 1, fields: [{ name: "id", dataTypeId: 23 }], rows: [{ id: 1 }, { id: 2 }] };
        const result: ExecuteResult = {
            transaction: "commit",
            readOnly: false,
            durationMs: 3,
            statements: [
                { ...base, index: 1, kind: "UpdateStmt", command: "UPDATE", rowCount: 1200 },
                { ...base, index: 2, kind: "SelectStmt", command: null, rowCount: null, writes: true },
                { ...base, index: 3, kind: "FetchStmt", command: null, rowCount: null },
                { ...base, index: 4, kind: "VariableShowStmt", command: null, rowCount: null },
            ],
        };
        const text = formatExecuteResult(result);
        expect(text).toContain("[1] UPDATE · 1200 rows affected · first 2 of the RETURNING rows read");
        expect(text).toContain("[2] SELECT · first 2 rows — the statement ran in full (a WITH that writes computes every row); only these were read");
        expect(text).toContain("[3] FETCH · first 2 rows — the cursor has already moved past the rest");
        expect(text).toContain("[4] SHOW · first 2 rows");
        expect(text).not.toContain("narrow it with WHERE / LIMIT · 1 ms\n{\"id\":1}\n{\"id\":2}\n[2]");
    });

    it("counts rows a CREATE TABLE … AS wrote, uses the singular, and prints nothing for zero-column rows", () => {
        const result: ExecuteResult = {
            transaction: "commit",
            readOnly: false,
            durationMs: 3,
            statements: [
                { index: 1, kind: "CreateTableAsStmt", command: "SELECT", rowCount: 5, truncated: false, ddl: true, durationMs: 1, fields: [], rows: [] },
                { index: 2, kind: "InsertStmt", command: "INSERT", rowCount: 1, truncated: false, ddl: false, durationMs: 1, fields: [], rows: [] },
                { index: 3, kind: "SelectStmt", command: "SELECT", rowCount: 2, truncated: false, ddl: false, durationMs: 1, fields: [], rows: [{}, {}] },
            ],
        };
        expect(formatExecuteResult(result)).toBe([
            "3 statements · 3 ms · committed",
            "[1] SELECT · 5 rows written · DDL · 1 ms",
            "[2] INSERT · 1 row affected · 1 ms",
            "[3] SELECT · 2 rows (no columns) · 1 ms",
        ].join("\n"));
    });
});

describe("what a cut says about what ran", () => {
    it("EXECUTE / SHOW / EXPLAIN ran in full; a zero-column SELECT says there were more", () => {
        const base = { truncated: true, ddl: false, durationMs: 1, fields: [{ name: "x", dataTypeId: 23 }], rows: [{ x: 1 }], rowCount: null, command: null };
        const result: ExecuteResult = {
            transaction: "commit",
            readOnly: false,
            durationMs: 3,
            statements: [
                { ...base, index: 1, kind: "ExecuteStmt" },
                { ...base, index: 2, kind: "SelectStmt", fields: [], rows: [{}, {}, {}] },
            ],
        };
        const text = formatExecuteResult(result);
        expect(text).toContain("[1] EXECUTE · first 1 row — the statement ran in full; only these were read");
        expect(text).toContain("[2] SELECT · more than 3 rows (no columns) — stopped at the row limit");
    });

    it("an EXPLAIN cut says nothing about running; a zero-column SELECT that writes in its WITH says it ran in full", () => {
        const base = { truncated: true, ddl: false, durationMs: 1, fields: [{ name: "QUERY PLAN", dataTypeId: 25 }], rows: [{ "QUERY PLAN": "Seq Scan" }], rowCount: null, command: null };
        const result: ExecuteResult = {
            transaction: "commit",
            readOnly: false,
            durationMs: 3,
            statements: [
                { ...base, index: 1, kind: "ExplainStmt" },
                { ...base, index: 2, kind: "SelectStmt", fields: [], rows: [{}, {}, {}], writes: true },
            ],
        };
        const text = formatExecuteResult(result);
        // Without ANALYZE the explained INSERT did not run — "ran in full" would read as if it had
        expect(text).toContain("[1] EXPLAIN · first 1 row of the plan — the row limit cut the rest");
        expect(text).not.toContain("ran in full; only these");
        expect(text).toContain("[2] SELECT · more than 3 rows (no columns) — the statement ran in full; counting stopped at the row limit");
    });

    it("pays for both cut lines of a statement whose notices and rows are both cut, so every later heading stays", () => {
        const rows = Array.from({ length: 5 }, (_value, position) => ({ k: position, pad: "y".repeat(300) }));
        const noisy = {
            kind: "SelectStmt", command: "SELECT", rowCount: 5, truncated: false, ddl: false, durationMs: 0,
            fields: [{ name: "k", dataTypeId: 23 }, { name: "pad", dataTypeId: 25 }], rows: rows,
            notices: [`NOTICE: ${"n".repeat(300)}`, `NOTICE: ${"n".repeat(300)}`],
        };
        const statements = Array.from({ length: 11 }, (_value, position) => ({ ...noisy, index: position + 1 }));
        const result: ExecuteResult = {
            transaction: "commit",
            readOnly: false,
            durationMs: 3,
            statements: [
                ...statements,
                { index: 12, kind: "UpdateStmt", command: "UPDATE", rowCount: 5, truncated: false, ddl: false, durationMs: 1, fields: [], rows: [] },
            ],
        };
        for(const limit of [1500, 2000, 4000]) {
            const text = formatExecuteResult(result, limit);
            expect(text.length).toBeLessThanOrEqual(limit);
            expect(text).toContain("[12] UPDATE · 5 rows affected");
        }
    });

    it("still shows a small result that fits after a large one was cut — a count after a wide listing", () => {
        const wide = Array.from({ length: 500 }, (_value, position) => ({ id: position, body: "x".repeat(300) }));
        const result: ExecuteResult = {
            transaction: "commit",
            readOnly: false,
            durationMs: 3,
            statements: [
                { index: 1, kind: "SelectStmt", command: "SELECT", rowCount: 500, truncated: false, ddl: false, durationMs: 1, fields: [{ name: "id", dataTypeId: 23 }, { name: "body", dataTypeId: 25 }], rows: wide },
                { index: 2, kind: "SelectStmt", command: "SELECT", rowCount: 1, truncated: false, ddl: false, durationMs: 1, fields: [{ name: "n", dataTypeId: 20 }], rows: [{ n: "500" }] },
            ],
        };
        const text = formatExecuteResult(result, 100000);
        expect(text.length).toBeLessThanOrEqual(100000);
        // The cut line counts what is missing: shown + missing is the whole listing
        const missing = Number(/… (\d+) of 500 rows not shown — the output limit \(DB_MAX_OUTPUT\) is reached/.exec(text)?.[1]);
        expect(text.split("\n").filter((line) => line.startsWith("{\"id\":")).length + missing).toBe(500);
        expect(text).toMatch(/\[2\] SELECT · 1 row · 1 ms\n\{"n":"500"\}$/);

        // Whatever the listing's width, the count still shows: the smallest results are the ones kept whole
        for(let width = 200; width <= 400; width++) {
            const rows = Array.from({ length: 500 }, (_value, position) => ({ id: position, body: "x".repeat(width) }));
            const statements = [{ ...result.statements[0], rows: rows }, result.statements[1]];
            const output = formatExecuteResult({ ...result, statements: statements }, 100000);
            expect(output.length, `width ${width}`).toBeLessThanOrEqual(100000);
            expect(output, `width ${width}`).toMatch(/\{"n":"500"\}$/);
        }

        // A few grouped rows too — smaller than the listing, so they stay whole and the listing gives way
        const groups = Array.from({ length: 8 }, (_value, position) => ({ status: `status_${position}`, n: String(position * 10) }));
        const grouped = { ...result.statements[1], rowCount: 8, fields: [{ name: "status", dataTypeId: 25 }, { name: "n", dataTypeId: 20 }], rows: groups };
        for(let width = 150; width <= 250; width++) {
            const rows = Array.from({ length: 500 }, (_value, position) => ({ id: position, body: "x".repeat(width) }));
            const output = formatExecuteResult({ ...result, statements: [{ ...result.statements[0], rows: rows }, grouped] }, 100000);
            expect(output.length, `width ${width}`).toBeLessThanOrEqual(100000);
            expect(output, `width ${width}`).toMatch(/\{"status":"status_7","n":"70"\}$/);
        }
    });

    it("shows everything, without a word about a limit, when everything fits", () => {
        const statements = Array.from({ length: 20 }, (_value, position) => ({
            index: position + 1, kind: "InsertStmt", command: "INSERT", rowCount: 1, truncated: false, ddl: false, durationMs: 1,
            fields: [{ name: "id", dataTypeId: 23 }], rows: [{ id: position + 1 }],
        }));
        const result: ExecuteResult = { transaction: "autocommit", readOnly: false, durationMs: 3, statements: statements };
        const whole = formatExecuteResult(result);
        for(const limit of [whole.length, 2000, 3000]) {
            const text = formatExecuteResult(result, limit);
            expect(text, `limit ${limit}`).toBe(whole);
        }
    });

    it("keeps every heading when there are too many statements for a cut line each", () => {
        const statements = Array.from({ length: 60 }, (_value, position) => ({
            index: position + 1, kind: "InsertStmt", command: "INSERT", rowCount: 1, truncated: false, ddl: false, durationMs: 1,
            fields: [{ name: "id", dataTypeId: 23 }], rows: [{ id: position + 1 }],
        }));
        const result: ExecuteResult = { transaction: "autocommit", readOnly: false, durationMs: 3, statements: statements };
        const text = formatExecuteResult(result, 2000);
        expect(text.length).toBeLessThanOrEqual(2000);
        for(let index = 1; index <= 60; index++) {
            expect(text).toContain(`[${index}] INSERT · 1 row · 1 ms`);
        }
        // The room the headings leave still goes to whole statements, in order; the line counts the rest
        const shown = text.split("\n").filter((line) => line.startsWith("{\"id\":")).length;
        expect(shown).toBeGreaterThan(0);
        expect(text).toMatch(new RegExp(`… the notices and rows of ${60 - shown} of these statements are not shown — the output limit \\(DB_MAX_OUTPUT\\) is reached$`));
    });

    it("folds runs of alike headings into one line each when even the headings do not fit", () => {
        const create = (index: number) => ({
            index: index, kind: "CreateStmt", command: "CREATE", rowCount: null, truncated: false, ddl: true, durationMs: 1 + (index % 3),
            fields: [], rows: [], notices: [`NOTICE: relation "t${index}" already exists, skipping`],
        });
        const statements = [
            ...Array.from({ length: 100 }, (_value, position) => create(position + 1)),
            { index: 101, kind: "SelectStmt", command: "SELECT", rowCount: 1, truncated: false, ddl: false, durationMs: 1, fields: [{ name: "n", dataTypeId: 20 }], rows: [{ n: "1" }] },
            ...Array.from({ length: 100 }, (_value, position) => create(position + 102)),
        ];
        const result: ExecuteResult = { transaction: "commit", readOnly: false, durationMs: 9, statements: statements };
        const text = formatExecuteResult(result, 1500);
        expect(text.length).toBeLessThanOrEqual(1500);
        // A run folds only as far as it must: part of the first run, the whole second one
        expect(text).toMatch(/^\[1–\d+\] CREATE · \d+ statements · DDL · 1–3 ms each — the notices and rows of \d+ of them are not shown \(output limit\)$/m);
        expect(text).toMatch(/^\[102–201\] CREATE · 100 statements · DDL · 1–3 ms each/m);
        // The statement between the runs keeps its own heading, and its one row fits
        expect(text).toMatch(/\[101\] SELECT · 1 row · 1 ms\n\{"n":"1"\}/);
        // Every statement is accounted for exactly once
        const covered: number[] = [];
        for(const match of text.matchAll(/^\[(\d+)(?:–(\d+))?\] /gm)) {
            for(let index = Number(match[1]); index <= Number(match[2] ?? match[1]); index++) {
                covered.push(index);
            }
        }
        expect(covered).toEqual(Array.from({ length: 201 }, (_value, position) => position + 1));
        // Nothing folds while the headings fit
        expect(formatExecuteResult(result, 20000)).not.toMatch(/statements · DDL/);
    });

    it("holds its promises on any mix of results and limits", () => {
        let seed = 7;
        const random = (low: number, high: number) => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return low + Math.floor((seed / 2147483648) * (high - low + 1));
        };
        for(let attempt = 0; attempt < 400; attempt++) {
            const statements = Array.from({ length: random(1, 40) }, (_value, position) => {
                const notices = Array.from({ length: random(0, 4) }, (_notice, noticeIndex) => `NOTICE: n${noticeIndex} ${"y".repeat(random(0, 60))}`);
                const kind = random(0, 2);
                if(kind === 0) {
                    return { index: position + 1, kind: "CreateStmt", command: "CREATE", rowCount: null, truncated: false, ddl: true, durationMs: 1, fields: [], rows: [], notices: notices };
                }
                const rows = Array.from({ length: random(0, 30) }, (_row, rowIndex) => ({ id: rowIndex, pad: "x".repeat(random(0, 200)) }));
                return {
                    index: position + 1, kind: "SelectStmt", command: "SELECT", rowCount: rows.length, truncated: false, ddl: false, durationMs: 1,
                    fields: [{ name: "id", dataTypeId: 23 }, { name: "pad", dataTypeId: 25 }], rows: rows, notices: notices,
                    droppedNotices: random(0, 1) * (notices.length > 0 ? random(1, 9) : 0),
                };
            });
            const result: ExecuteResult = { transaction: "commit", readOnly: false, durationMs: 1, statements: statements };
            const whole = formatExecuteResult(result);
            const limit = random(60, whole.length + 20);
            const text = formatExecuteResult(result, limit);
            const lines = text.split("\n").slice(1);
            const context = `attempt ${attempt}, limit ${limit}`;

            // Every statement is still accounted for: its own heading, or inside a folded range
            const covered = new Set<number>();
            for(const line of lines) {
                const heading = /^\[(\d+)(?:–(\d+))?\] /.exec(line);
                if(heading != null) {
                    for(let index = Number(heading[1]); index <= Number(heading[2] ?? heading[1]); index++) {
                        covered.add(index);
                    }
                }
            }
            expect(covered.size, context).toBe(statements.length);

            // Over the limit only when nothing but headings is left
            if(text.length > limit) {
                expect(lines.every((line) => /^\[\d+/.test(line) || line.startsWith("(no rows)")), context).toBe(true);
            }

            // A cut line counts exactly what its statement does not show
            for(const statement of statements) {
                const start = lines.findIndex((line) => line.startsWith(`[${statement.index}] `));
                if(start < 0) {
                    continue;
                }
                let end = lines.findIndex((line, position) => position > start && /^(\[\d+|… the notices and rows of)/.test(line));
                if(end < 0) {
                    end = lines.length;
                }
                const segment = lines.slice(start + 1, end);
                const rowsShown = segment.filter((line) => line.startsWith("{")).length;
                const rowCut = /^… (\d+) of (\d+) rows? not shown/.exec(segment.find((line) => /^… \d+ of \d+ rows? not shown/.test(line)) ?? "");
                if(rowCut != null) {
                    expect(Number(rowCut[1]) + rowsShown, context).toBe(statement.rows.length);
                }
                const noticesShown = segment.filter((line) => line.startsWith("  NOTICE")).length;
                const noticeCut = /^ {2}… (\d+) more notices? not shown — the output limit/.exec(segment.find((line) => / more notices? not shown — the output limit/.test(line)) ?? "");
                if(noticeCut != null) {
                    // The driver's own cap is named apart, so only kept notices count as cut by the limit
                    expect(Number(noticeCut[1]) + noticesShown, context).toBe(statement.notices.length);
                }
            }
        }
    });

    it("counts the notices the driver did not keep, and says why they are missing", () => {
        const notices = Array.from({ length: 20 }, (_value, position) => `NOTICE: step ${position + 1}`);
        const noisy = {
            index: 1, kind: "DoStmt", command: "DO", rowCount: null, truncated: false, ddl: false, durationMs: 1,
            fields: [], rows: [], notices: notices, droppedNotices: 5,
        };
        const whole = formatExecuteResult({ transaction: "commit", readOnly: false, durationMs: 1, statements: [noisy] });
        expect(whole).toMatch(/ {2}NOTICE: step 20\n {2}… 5 more notices not shown — a statement keeps its first 20$/);

        // Behind a cut: the 5 dropped count among the missing — 25 sent, so shown + missing is 25, not 21
        const wideRow = { index: 1, kind: "SelectStmt", command: "SELECT", rowCount: 1, truncated: false, ddl: false, durationMs: 1, fields: [{ name: "w", dataTypeId: 25 }], rows: [{ w: "x".repeat(3000) }] };
        const cut = formatExecuteResult({ transaction: "commit", readOnly: false, durationMs: 1, statements: [wideRow, { ...noisy, index: 2 }] }, 400);
        const tail = cut.slice(cut.indexOf("[2] DO"));
        const shown = tail.match(/^ {2}NOTICE: step \d+$/gm)?.length ?? 0;
        // Only the kept notices count as cut by the limit; the 5 the driver did not keep are named apart
        expect(tail).toMatch(new RegExp(`… ${20 - shown} more notices not shown — the output limit \\(DB_MAX_OUTPUT\\) is reached; the statement sent 5 more than were kept$`));
    });

    it("caps a long notice and counts notices against the output limit, so a later heading still shows", () => {
        const result: ExecuteResult = {
            transaction: "commit",
            readOnly: false,
            durationMs: 3,
            statements: [
                { index: 1, kind: "DoStmt", command: "DO", rowCount: null, truncated: false, ddl: false, durationMs: 1, fields: [], rows: [],
                    notices: [`NOTICE: ${"d".repeat(5000)}`, "NOTICE: second", "NOTICE: third"] },
                { index: 2, kind: "UpdateStmt", command: "UPDATE", rowCount: 5, truncated: false, ddl: false, durationMs: 1, fields: [], rows: [] },
            ],
        };
        const text = formatExecuteResult(result, 1000);
        expect(text).toContain("[2] UPDATE · 5 rows affected");
        expect(text).toMatch(/NOTICE: d{100,}… \(\d+ more characters\)/);
        expect(text.length).toBeLessThanOrEqual(1000);

        const tight = formatExecuteResult(result, 300);
        expect(tight).toContain("[2] UPDATE · 5 rows affected");
        expect(tight).toMatch(/… \d more notices not shown/);
    });
});

describe("formatExecuteResult under an output limit", () => {
    it("keeps every statement's heading — a later write's result is never cut away — and says how many rows it shows", () => {
        const rows = Array.from({ length: 20 }, (_value, position) => ({ id: position + 1, note: "x".repeat(20) }));
        const result: ExecuteResult = {
            transaction: "commit",
            readOnly: false,
            durationMs: 5,
            statements: [
                { index: 1, kind: "SelectStmt", command: "SELECT", rowCount: 20, truncated: false, ddl: false, durationMs: 1, fields: [{ name: "id", dataTypeId: 23 }, { name: "note", dataTypeId: 25 }], rows: rows },
                { index: 2, kind: "DeleteStmt", command: "DELETE", rowCount: 15, truncated: false, ddl: false, durationMs: 1, fields: [], rows: [] },
            ],
        };
        const text = formatExecuteResult(result, 400);
        expect(text.length).toBeLessThanOrEqual(400);
        expect(text).toContain("[2] DELETE · 15 rows affected");
        const missing = Number(/… (\d+) of 20 rows not shown — the output limit \(DB_MAX_OUTPUT\) is reached/.exec(text)?.[1]);
        expect(text.split("\n").filter((line) => line.startsWith("{")).length + missing).toBe(20);
        // Every row line that is shown is whole JSON
        for(const line of text.split("\n").filter((candidate) => candidate.startsWith("{"))) {
            expect(() => JSON.parse(line)).not.toThrow();
        }
    });
});

describe("formatDbSummary", () => {
    it("does not call DDL allowed on a read-only database", () => {
        const summary = {
            name: "d@h", driver: "postgres", host: "h", port: 5432, database: "d", user: "u", ssl: "require", tunnel: null,
            readonly: true, allowDdl: true, denyPatternCount: 0, statementTimeoutMs: 60000, maxRows: 500,
        } as unknown as Parameters<typeof formatDbSummary>[0];
        const text = formatDbSummary(summary);
        expect(text).toContain("read-only (every call runs in BEGIN READ ONLY … ROLLBACK) · no DDL (read-only)");
        expect(text).not.toContain("DDL allowed");
    });
});

describe("formatRelationDescription", () => {
    it("says the INHERITS children were cut too — they are read with the partitions", () => {
        const description: RelationDescription = {
            schema: "app", name: "logs", relkind: "r", kind: "table", approxRows: null, size: null, comment: null,
            viewDefinition: null, partitionKey: null, partitionBound: null, inheritsFrom: null,
            columns: [], constraints: [], referencedBy: [], indexes: [], triggers: [], partitions: [],
            partitionsTruncated: true,
            inheritedBy: Array.from({ length: 3 }, (_value, position) => ({ name: `app.c_${position}` })),
            sequence: null, alsoMatches: [],
        };
        const text = formatRelationDescription(description);
        expect(text).toMatch(/inherited by \(INHERITS — not partitions\):\n {2}app\.c_0\n {2}app\.c_1\n {2}app\.c_2\n {2}… only the first 3 INHERITS children are listed — more exist$/);
    });
});

describe("formatGuardRejection", () => {
    it("names the statement and says nothing ran", () => {
        const text = formatGuardRejection({ allowed: false, reason: "TRUNCATE empties whole tables", statementIndex: 2, offendingText: "TRUNCATE\n  users" });
        expect(text).toBe([
            "Refused by the guard: TRUNCATE empties whole tables",
            "statement 2: TRUNCATE users",
            "Nothing was sent to the database.",
        ].join("\n"));
    });
});
