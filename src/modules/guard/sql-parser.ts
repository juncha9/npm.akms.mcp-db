import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

export const PARSER_IDLE_TIMEOUT_MS = 30_000;

/** Infrastructure failures must not tell callers to rewrite valid SQL. */
export class SqlParserUnavailableError extends Error {
    constructor(reason: string) {
        super(`${reason} Nothing was sent to the database.`);
        this.name = "SqlParserUnavailableError";
    }
}

export interface RawStatement {
    stmt: Record<string, Record<string, unknown>>;
    stmt_location?: number;
    stmt_len?: number;
}

interface Reply {
    id: number;
    statements?: RawStatement[];
    error?: { message: string; cursorPosition?: number; syntax: boolean };
}

// A fixed CommonJS entry keeps the worker independent of TS loaders, bundler chunk
// names and the caller's working directory. Only SQL and an absolute dependency
// path cross this boundary; the parser is never imported into the main isolate.
const WORKER_SOURCE = String.raw`
    const { parentPort, workerData } = require("node:worker_threads");
    const { parse } = require(workerData.parserPath);
    parentPort.on("message", async ({ id, sql }) => {
        try {
            const result = await parse(sql);
            parentPort.postMessage({ id, statements: result.stmts || [] });
        } catch (error) {
            parentPort.postMessage({ id, error: {
                message: error instanceof Error ? error.message : String(error),
                cursorPosition: error?.sqlDetails?.cursorPosition,
                syntax: error?.sqlDetails != null,
            } });
        }
    });
`;

/** One parser worker, reused while busy and fully terminated after idle time. */
export class SqlParser {
    private worker: Worker | null = null;
    private stopping: Promise<void> = Promise.resolve();
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;
    private nextId = 0;
    private readonly pending = new Map<number, {
        resolve(value: RawStatement[]): void;
        reject(error: Error): void;
    }>();

    constructor(private readonly idleTimeoutMs = PARSER_IDLE_TIMEOUT_MS) {
        if(!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > 2147483647) {
            throw new Error("Parser idle timeout must be a positive timer duration.");
        }
    }

    async parse(sql: string): Promise<RawStatement[]> {
        // A request arriving during retirement waits for the previous worker to
        // exit, rather than briefly allocating two WASM instances.
        try {
            await this.stopping;
        } catch {
            throw new SqlParserUnavailableError("SQL parser could not finish shutting down.");
        }
        if(this.closed) throw new SqlParserUnavailableError("SQL parser is closed.");
        this.clearIdleTimer();
        let worker: Worker;
        try {
            worker = this.worker ?? this.startWorker();
        } catch {
            throw new SqlParserUnavailableError("SQL parser worker could not start.");
        }
        worker.ref();
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                worker.postMessage({ id, sql });
            } catch {
                void this.retire(worker, new SqlParserUnavailableError("SQL parser worker could not accept the request."));
            }
        });
    }

    async close(): Promise<void> {
        this.closed = true;
        this.clearIdleTimer();
        if(this.worker != null) {
            await this.retire(this.worker, new SqlParserUnavailableError("SQL parser is closed."));
        } else {
            await this.stopping;
        }
    }

    private startWorker(): Worker {
        const require = createRequire(import.meta.url);
        const worker = new Worker(WORKER_SOURCE, {
            eval: true,
            workerData: { parserPath: require.resolve("libpg-query") },
            // Do not replay application/tsx preloads inside every worker.
            execArgv: [],
            env: {},
            stdout: true,
            stderr: true,
        });
        this.worker = worker;
        // Keep worker output away from MCP stdout and secrets out of diagnostics.
        // Draining these streams would reference Node's internal stdio port even
        // after worker.unref(), keeping library callers alive until retirement.
        worker.stdout.destroy();
        worker.stderr.destroy();
        worker.on("message", (reply: Reply) => {
            if(this.worker !== worker) return;
            const request = this.pending.get(reply.id);
            if(request == null) return;
            if(reply.error != null && reply.error.syntax !== true) {
                void this.retire(worker, new SqlParserUnavailableError("SQL parser runtime failed."));
                return;
            }
            this.pending.delete(reply.id);
            if(reply.error != null) {
                const error = Object.assign(new Error(reply.error.message), {
                    sqlDetails: { cursorPosition: reply.error.cursorPosition },
                });
                request.reject(error);
            } else {
                request.resolve(reply.statements ?? []);
            }
            this.scheduleIdle(worker);
        });
        worker.on("error", () => {
            if(this.worker === worker) {
                void this.retire(worker, new SqlParserUnavailableError("SQL parser worker failed."));
            }
        });
        worker.on("exit", () => {
            if(this.worker === worker) {
                void this.retire(worker, new SqlParserUnavailableError("SQL parser worker exited before returning a result."));
            }
        });
        return worker;
    }

    private clearIdleTimer(): void {
        if(this.idleTimer != null) clearTimeout(this.idleTimer);
        this.idleTimer = null;
    }

    private scheduleIdle(worker: Worker): void {
        if(this.worker !== worker || this.pending.size !== 0) return;
        this.clearIdleTimer();
        // An idle library parser must not keep a caller's process alive.
        worker.unref();
        this.idleTimer = setTimeout(() => {
            if(this.worker === worker && this.pending.size === 0) {
                void this.retire(worker, new Error("SQL parser retired after idle time."));
            }
        }, this.idleTimeoutMs);
        this.idleTimer.unref();
    }

    private retire(worker: Worker, reason: Error): Promise<void> {
        if(this.worker !== worker) return this.stopping;
        this.clearIdleTimer();
        this.worker = null;
        for(const request of this.pending.values()) request.reject(reason);
        this.pending.clear();
        this.stopping = worker.terminate().then(() => {});
        // Preserve a termination failure for close()/the next parse, while idle
        // retirement itself has no awaiting caller and must not reject unhandled.
        void this.stopping.catch(() => {});
        return this.stopping;
    }
}
