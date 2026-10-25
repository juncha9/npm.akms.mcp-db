import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqlParser, SqlParserUnavailableError } from "@/modules/guard/sql-parser";
import { parseStatementsWithParser } from "@/modules/guard/parse";

const parsers: SqlParser[] = [];
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

function createParser() {
    const parser = new SqlParser(1000);
    parsers.push(parser);
    return parser;
}

afterEach(async () => {
    await Promise.all(parsers.splice(0).map(parser => parser.close()));
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("reclaimable PostgreSQL parser", () => {
    it("shares concurrent work, keeps in-flight parsing alive, retires on idle and starts again", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const stopped = vi.spyOn(Worker.prototype, "terminate");
        const posted = vi.spyOn(Worker.prototype, "postMessage");
        const parser = createParser();
        const results = await Promise.all(Array.from({ length: 8 }, (_, i) => parser.parse(`SELECT ${i}`)));
        expect(results.every(statements => Object.hasOwn(statements[0].stmt, "SelectStmt"))).toBe(true);
        const firstWorker = posted.mock.contexts[0] as Worker;
        expect(posted.mock.contexts.every(worker => worker === firstWorker)).toBe(true);
        vi.advanceTimersByTime(900);
        expect(stopped).not.toHaveBeenCalled();

        const next = parser.parse("SELECT 9");
        await Promise.resolve(); // Dispatch the request before advancing the idle clock.
        vi.advanceTimersByTime(2000); // Do not deliver the worker reply until after this assertion.
        expect(stopped).not.toHaveBeenCalled();
        await next;
        vi.advanceTimersByTime(999);
        expect(stopped).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(stopped).toHaveBeenCalledTimes(1);
        await stopped.mock.results[0].value;
        expect(firstWorker.threadId).toBe(-1);

        const [statement] = await parseStatementsWithParser("SELECT 'after idle'", parser);
        expect(statement.kind).toBe("SelectStmt");
        expect(posted.mock.contexts.at(-1)).not.toBe(firstWorker);
    });

    it("rejects pending parsing on close and never opens a worker after closure", async () => {
        const posted = vi.spyOn(Worker.prototype, "postMessage");
        const parser = createParser();
        const pending = parser.parse("SELECT 1");
        const rejection = expect(pending).rejects.toThrow("closed");
        await Promise.resolve();
        await Promise.all([parser.close(), rejection]);
        expect((posted.mock.contexts[0] as Worker).threadId).toBe(-1);
        await expect(parser.parse("SELECT 2")).rejects.toThrow("closed");
        expect(posted).toHaveBeenCalledTimes(1);
    });

    it("queues concurrent requests during retirement and preserves each request's result", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const original = Worker.prototype.terminate;
        const gate = deferred();
        vi.spyOn(Worker.prototype, "terminate").mockImplementationOnce(async function(this: Worker) {
            const code = await original.call(this);
            await gate.promise;
            return code;
        });
        const posted = vi.spyOn(Worker.prototype, "postMessage");
        const parser = createParser();
        await parser.parse("SELECT 0");
        const firstWorker = posted.mock.contexts[0] as Worker;
        vi.advanceTimersByTime(1000);
        const requests = Array.from({ length: 8 }, (_, i) => parseStatementsWithParser(`SELECT ${i} AS n`, parser));
        const invalid = expect(parseStatementsWithParser("SELEC 1", parser)).rejects.toMatchObject({ verdict: { kind: "syntax" } });
        try {
            await Promise.resolve();
            expect(posted).toHaveBeenCalledTimes(1);
        } finally {
            gate.resolve();
        }
        const results = await Promise.all(requests);
        await invalid;
        expect(firstWorker.threadId).toBe(-1);
        expect(results.map(statements => statements[0].text)).toEqual(Array.from({ length: 8 }, (_, i) => `SELECT ${i} AS n`));
        const replacement = posted.mock.contexts[1];
        expect(replacement).not.toBe(firstWorker);
        expect(posted.mock.contexts.slice(1).every(worker => worker === replacement)).toBe(true);
    });

    it("does not restart when closed while requests wait for retirement", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const original = Worker.prototype.terminate;
        const gate = deferred();
        vi.spyOn(Worker.prototype, "terminate").mockImplementationOnce(async function(this: Worker) {
            const code = await original.call(this);
            await gate.promise;
            return code;
        });
        const posted = vi.spyOn(Worker.prototype, "postMessage");
        const parser = createParser();
        await parser.parse("SELECT 0");
        vi.advanceTimersByTime(1000);
        const result = expect(parseStatementsWithParser("SELECT 1", parser)).rejects.toBeInstanceOf(SqlParserUnavailableError);
        const closing = parser.close();
        gate.resolve();
        await Promise.all([closing, result]);
        expect(posted).toHaveBeenCalledTimes(1);
    });

    it("reports dispatch failure as infrastructure failure and recovers without replaying SQL", async () => {
        vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(() => {
            throw new Error("internal transport details");
        });
        const parser = createParser();
        const failure = await parseStatementsWithParser("SELECT 1", parser).catch(error => error);
        expect(failure).toBeInstanceOf(SqlParserUnavailableError);
        expect(failure.message).toContain("Nothing was sent to the database.");
        expect(failure.message).not.toContain("internal transport details");
        expect((await parseStatementsWithParser("SELECT 2", parser))[0].text).toBe("SELECT 2");
    });

    it("fails every pending request on unexpected worker exit and can recover on the next request", async () => {
        const original = Worker.prototype.postMessage;
        let interrupted = false;
        vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function(this: Worker, message, transferList) {
            original.call(this, message, transferList);
            if(!interrupted) {
                interrupted = true;
                void this.terminate();
            }
        });
        const parser = createParser();
        const results = await Promise.allSettled([parseStatementsWithParser("SELECT 1", parser), parseStatementsWithParser("SELECT 2", parser)]);
        expect(results.every(result => result.status === "rejected" && result.reason instanceof SqlParserUnavailableError)).toBe(true);
        const [statement] = await parseStatementsWithParser("SELECT 3", parser);
        expect(statement.kind).toBe("SelectStmt");
    });

    it("preserves SQL error positions and keeps another owner's parser usable after shutdown", async () => {
        const first = createParser();
        const second = createParser();
        const result = await parseStatementsWithParser("SELEC 1", first).catch(error => error);
        expect(result.verdict.kind).toBe("syntax");
        expect(result.message).toMatch(/syntax error.*near character 1/);
        await parseStatementsWithParser("SELECT 1", second);
        await first.close();
        const statements = await parseStatementsWithParser("SELECT 2; SELECT 3", second);
        expect(statements).toHaveLength(2);
    });
});
