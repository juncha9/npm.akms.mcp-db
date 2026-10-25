import fs from "node:fs";
import net from "node:net";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import pg from "pg";
import Cursor from "pg-cursor";
import { APPLICATION_NAME, POOL_IDLE_TIMEOUT_MS, POOL_MAX_CLIENTS, TCP_KEEPALIVE_INITIAL_DELAY_MS } from "@/_defs";
import type { DbProfile, ExecuteResult, ParsedStatement, ResultField, StatementResult, TransactionMode } from "@/_types";
import { $logger } from "@/_libs/logger";
import { describeError } from "@/_libs/text";
import { GuardRejectionError } from "@/modules/guard/guard-error";
import { parseStatementsWithParser } from "@/modules/guard/parse";
import { SqlParser } from "@/modules/guard/sql-parser";
import { changesSchema, checkStatements, writesData } from "@/modules/guard/rules";
import { ChannelSocket } from "@/modules/tunnel/channel-socket";
import { SshTunnel } from "@/modules/tunnel/ssh-tunnel";

/**
 * Types handed back as the server's own text instead of a JS value: `pg` turns `timestamp`
 * (no time zone) into a local-time Date, which JSON then shifts to UTC — `04:19` KST came back
 * as `19:19Z` the day before. Dates, times, intervals and bytea (and their arrays) stay raw.
 */
const RAW_TEXT_TYPE_OIDS = new Set([
    17, 1001,       // bytea, bytea[]
    1082, 1182,     // date
    1083, 1183,     // time
    1114, 1115,     // timestamp
    1184, 1185,     // timestamptz
    1186, 1187,     // interval
    1266, 1270,     // timetz
]);

/** pg's text[] parser — `{1.10,NULL,"a b"}` → `["1.10", null, "a b"]`, nested for multi-dimensional arrays. */
const parseTextArray = (pg.types.getTypeParser as (oid: number, format: "text") => (value: string) => unknown)(1009, "text");

/** Applies `parseElement` to every non-null leaf of a parsed (possibly nested) array. */
function mapArrayElements(value: unknown, parseElement: (element: string) => unknown): unknown {
    if(Array.isArray(value) == true) {
        return (value as unknown[]).map((item) => mapArrayElements(item, parseElement));
    }
    if(value == null) {
        return null;
    }
    return parseElement(value as string);
}

/** A float as a JS number, except NaN / Infinity / -Infinity, which JSON would print as null — indistinguishable from SQL NULL. */
function parseFiniteFloat(text: string): unknown {
    const number = parseFloat(text);
    if(Number.isFinite(number) == false) {
        return text;
    }
    return number;
}

/**
 * A decimal number's exact value as `<sign><digits>e<exponent>`, zeros trimmed: "1.10" and "1.1"
 * give "11e-1", "1e20" and "100000000000000000000" give "1e20", "-0" gives "0".
 */
function decimalValueKey(text: string): string {
    const match = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if(match == null) {
        return text;
    }
    const [, sign, integerDigits, fractionDigits = "", exponentText = "0"] = match;
    let digits = `${integerDigits}${fractionDigits}`.replace(/^0+/, "");
    let exponent = Number(exponentText) - fractionDigits.length;
    while(digits.endsWith("0") == true) {
        digits = digits.slice(0, -1);
        exponent += 1;
    }
    if(digits === "") {
        return "0";
    }
    return `${sign}${digits}e${exponent}`;
}

/** True when the double JSON.parse made of `source` is not the number written there — a bigint past 2^53, 30 significant digits, 1e-400. */
function losesPrecision(value: number, source: string): boolean {
    if(Number.isFinite(value) == false) {
        return true;
    }
    // String(value) is the shortest text that reads back as this double; equal values mean nothing was lost
    return decimalValueKey(String(value)) !== decimalValueKey(source);
}

/** Node 22+: a value JSON.stringify writes out as the given text verbatim. */
const rawJson = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;

/**
 * json / jsonb as a JS value, with every number a double cannot hold kept as the server wrote it
 * (JSON.rawJSON of the reviver's `context.source`) — so JSON.stringify prints the exact digits and
 * an object stays an object. Without rawJSON the whole value falls back to the server's text.
 */
function parseJsonKeepingPrecision(text: string): unknown {
    const scan = { lossy: false };
    const reviver = (_key: string, value: unknown, context?: { source?: string }) => {
        if(typeof value !== "number" || context?.source == null || losesPrecision(value, context.source) == false) {
            return value;
        }
        if(rawJson != null) {
            return rawJson(context.source);
        }
        scan.lossy = true;
        return value;
    };
    let parsed: unknown;
    try {
        parsed = JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
    }
    catch {
        // V8 applies a reviver recursively: ~2000 levels of nesting overflow its stack. Thrown from a type parser, the
        // error would escape inside pg's socket handler, past every caller. Not parsed without the reviver either:
        // JSON.stringify recurses too and fails at ~4800 levels, after the call has committed.
        return text;
    }
    if(scan.lossy == true) {
        return text;
    }
    return parsed;
}

/**
 * pg's defaults, except where they would lose or blur a value: `numeric[]` would become doubles
 * (scalar numeric and int8 are already strings), json numbers past a double's precision would be
 * rounded, and a float NaN / Infinity would print as null.
 */
const TYPE_PARSERS = {
    getTypeParser(oid: number, format?: "text" | "binary"): (value: string) => unknown {
        if(RAW_TEXT_TYPE_OIDS.has(oid) == true) {
            return (value: string) => value;
        }
        switch(oid) {
            case 700:       // float4
            case 701:       // float8
                return parseFiniteFloat;
            case 1021:      // float4[]
            case 1022:      // float8[]
                return (value: string) => mapArrayElements(parseTextArray(value), parseFiniteFloat);
            case 1231:      // numeric[]
                return parseTextArray;
            case 114:       // json
            case 3802:      // jsonb
                return parseJsonKeepingPrecision;
            case 199:       // json[]
            case 3807:      // jsonb[]
                return (value: string) => mapArrayElements(parseTextArray(value), parseJsonKeepingPrecision);
            default:
                return pg.types.getTypeParser(oid, format ?? "text") as (value: string) => unknown;
        }
    },
};

/** Second int32 of a CancelRequest packet: [length 16][this code][backend pid][secret key]. */
const CANCEL_REQUEST_CODE = 80877102;
/** How long a cancelled call may keep running before its socket is cut. A healthy server stops the statement in milliseconds. */
const CANCEL_GRACE_MS = 5000;
/** Rows fetched per round when draining a truncated write's RETURNING output for its row count. */
const DRAIN_BATCH_ROWS = 1000;
/** A DO block raising a notice per row would otherwise flood the output. */
const MAX_NOTICES_PER_STATEMENT = 20;
/** Statements read to the end when the row limit cuts them — writes whose RETURNING output is already complete on the server. */
const DRAINED_KINDS = new Set(["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"]);

export interface ExecuteOptions {
    params?: unknown[];
    transaction: TransactionMode;
    /** Forces read-only for this call; a read-only profile is read-only regardless. */
    readOnly?: boolean;
    /** Defaults to the profile's `maxRows`. */
    maxRows?: number;
    /**
     * `DISCARD ALL` before the connection goes back to the pool (default true). Without it a
     * `SET statement_timeout = 0` or `set_config(…, false)` outlives the call on one of the pooled
     * connections — the next call may or may not see it, and the profile's timeout is gone there.
     * The catalog tools pass false: their SQL is fixed and changes no session state.
     */
    resetSession?: boolean;
    /**
     * Aborted when the MCP client cancels the call or gives up waiting. The running statement is
     * cancelled on the server, nothing further runs, and an open transaction is rolled back.
     */
    signal?: AbortSignal;
    /**
     * SQL the tool wrote itself — the catalog tools' fixed queries, db_explain's EXPLAIN wrapper around a
     * statement it already screened as written: the profile's deny patterns and DDL switch are not applied.
     * A pattern like /drop/ would otherwise match `attisdropped` and refuse db_describe, /analyze/ every plan.
     * The always-refused rules and read-only still apply.
     */
    internalSql?: boolean;
}

/**
 * SQLSTATEs the server sends as it ends the session: 57P01 terminated (pg_terminate_backend, fast
 * shutdown, failover), 57P02 crash, 57P03 cannot connect now, 57P04 database dropped, 57P05 idle
 * session timeout, 25P03 idle-in-transaction timeout, 25P04 transaction timeout (PostgreSQL 17+).
 * 57014 (statement cancelled) is not one of them, and neither is class 08: 08P01 is also the
 * ordinary ERROR for a wrong number of params, 08001 / 08006 a dblink or postgres_fdw remote failing.
 */
const SESSION_ENDING_SQLSTATES = new Set(["57P01", "57P02", "57P03", "57P04", "57P05", "25P03", "25P04"]);

/**
 * True when the server answered the statement with an ordinary error and the session goes on.
 * A FATAL is a DatabaseError too, but it ends the session — often right after the server finished
 * the work it reports on (a COMMIT done, then 57P01 from a shutdown or failover).
 * Read from the SQLSTATE first: the severity pg exposes is localized ("치명적오류" with lc_messages=ko).
 * A localized FATAL outside the list still aborted its statement, and the connection it closed is
 * found dead by the ROLLBACK or DISCARD ALL that follows.
 */
function isStatementLevelError(cause: unknown): boolean {
    if(cause instanceof pg.DatabaseError == false) {
        return false;
    }
    const error = cause as pg.DatabaseError;
    if(SESSION_ENDING_SQLSTATES.has(error.code ?? "") == true) {
        return false;
    }
    return error.severity !== "FATAL" && error.severity !== "PANIC";
}

/** A statement the server rejected, with where it sat in the call and what that meant for the others. */
export class StatementError extends Error {
    readonly statement: ParsedStatement;
    readonly statementIndex: number;
    readonly statementCount: number;
    readonly transaction: TransactionMode;
    readonly cause: unknown;
    /** Statements that finished before this one — in autocommit they are already committed. */
    readonly completed: StatementResult[];
    /** True when the session ended instead of the server answering the statement — its outcome is then unknown in autocommit. */
    readonly connectionLost: boolean;
    /** NOTICE / WARNING lines the statement sent before it failed — a procedure's "batch 2 committed" says what stays. */
    readonly notices?: string[];
    /** How many more it sent past those kept in `notices`. */
    readonly droppedNotices?: number;

    constructor(
        statement: ParsedStatement,
        statementCount: number,
        transaction: TransactionMode,
        cause: unknown,
        completed: StatementResult[],
        notices?: { kept: string[]; dropped: number }
    ) {
        super(describeError(cause));
        this.name = "StatementError";
        this.statement = statement;
        this.statementIndex = statement.index;
        this.statementCount = statementCount;
        this.transaction = transaction;
        this.cause = cause;
        this.completed = completed;
        this.connectionLost = isStatementLevelError(cause) == false;
        this.notices = notices?.kept;
        if(notices != null && notices.dropped > 0) {
            this.droppedNotices = notices.dropped;
        }
    }
}

/** COMMIT itself failed — a deferred constraint or a serialization failure, checked only at commit. */
export class CommitError extends Error {
    readonly statementCount: number;
    readonly cause: unknown;
    /** True when the session ended during COMMIT — whether the transaction committed is then unknown. */
    readonly connectionLost: boolean;

    constructor(statementCount: number, cause: unknown) {
        super(describeError(cause));
        this.name = "CommitError";
        this.statementCount = statementCount;
        this.cause = cause;
        this.connectionLost = isStatementLevelError(cause) == false;
    }
}

/** The MCP client cancelled or abandoned the call; what had not committed was rolled back. */
export class CallCancelledError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CallCancelledError";
    }
}

export interface CheckReport {
    ssh: { ok: boolean; endpoint: string; durationMs: number; hostKeyFingerprint: string | null; pinned: boolean; error?: string } | null;
    database: {
        ok: boolean;
        durationMs: number;
        error?: string;
        version?: string;
        database?: string;
        user?: string;
        ssl?: boolean;
        statementTimeout?: string;
    } | null;
}

/** pg-cursor internals that LateErrorCursor reads; the published typings do not declare them. */
interface CursorInternals {
    state: string;
    _cb: ((error: Error | null) => void) | null;
}

/**
 * A pg-cursor that keeps an error arriving after its portal closed. In autocommit the implicit
 * transaction commits at the cursor's own Sync, so a deferred-constraint or serialization
 * failure arrives then — stock pg-cursor ignores errors once 'done', and a pending read()
 * would never settle while the connection stays checked out.
 */
class LateErrorCursor extends Cursor {
    lateError: Error | null = null;

    handleError(error: Error): void {
        const internals = this as unknown as CursorInternals;
        if(internals.state !== "done") {
            (Cursor.prototype as unknown as { handleError(error: Error): void }).handleError.call(this, error);
            return;
        }
        this.lateError = error;
        const pendingRead = internals._cb;
        internals._cb = null;
        if(pendingRead != null) {
            pendingRead(error);
        }
    }
}

/**
 * The one way statements reach PostgreSQL. It owns the guard, so a new tool cannot forget it:
 * every call is parsed, screened, and run inside the transaction mode it asked for.
 */
export class PostgresDriver {
    readonly profile: DbProfile;
    readonly tunnel: SshTunnel | null = null;
    private readonly pool: pg.Pool;
    private readonly parser = new SqlParser();
    /** Clients checked out by a running execute() — what abortActiveConnections() and close() cut. */
    private readonly activeClients = new Set<pg.PoolClient>();

    constructor(profile: DbProfile) {
        this.profile = profile;
        const _logger = $logger.child({ context: "PostgresDriver", profile: profile.name });

        let ssl: pg.PoolConfig["ssl"] = false;
        if(profile.ssl === "require") {
            ssl = { rejectUnauthorized: false };
        }
        else if(profile.ssl === "verify") {
            ssl = { rejectUnauthorized: true };
            if(profile.sslCaPath != null) {
                ssl.ca = fs.readFileSync(profile.sslCaPath, "utf8");
            }
        }

        const poolConfig: pg.PoolConfig = {
            host: profile.host,
            port: profile.port,
            database: profile.database,
            user: profile.user,
            password: profile.password,
            ssl: ssl,
            application_name: APPLICATION_NAME,
            statement_timeout: profile.policy.statementTimeoutMs,
            // The guard reads string literals with standard_conforming_strings=on; a database or role set to off would
            // read `'C:\dir\' WHERE …` as one string, so a WHERE the guard saw would vanish. Startup options outrank both.
            options: "-c standard_conforming_strings=on",
            connectionTimeoutMillis: profile.policy.connectTimeoutMs,
            keepAlive: true,
            keepAliveInitialDelayMillis: TCP_KEEPALIVE_INITIAL_DELAY_MS,
            max: POOL_MAX_CLIENTS,
            idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
            types: TYPE_PARSERS,
        };

        if(profile.tunnel != null) {
            const tunnel = new SshTunnel(profile.tunnel, profile.policy.connectTimeoutMs);
            this.tunnel = tunnel;
            poolConfig.stream = () => new ChannelSocket((host, port) => tunnel.openChannel(host, port));
        }

        this.pool = new pg.Pool(poolConfig);
        // An idle client whose connection drops emits here; without a listener the process would exit.
        this.pool.on("error", (error) => {
            _logger.warn("idle database connection dropped; the next query opens a new one", { error_message: error.message });
        });
    }

    /** Parse without executing, sharing the driver's worker with tool preflight checks. */
    parse(sql: string): Promise<ParsedStatement[]> {
        return parseStatementsWithParser(sql, this.parser);
    }

    /**
     * Parses, screens and runs `sql`.
     *
     * Flow:
     *  1) Resolve the effective mode — a read-only call always ends in ROLLBACK
     *  2) Parse and screen every statement (nothing is sent if any is refused)
     *  3) Check out a connection, watching it for loss and the call for cancellation
     *  4) BEGIN [READ ONLY] unless autocommit
     *  5) Run each statement through a cursor that stops at maxRows + 1
     *  6) COMMIT or ROLLBACK; on a failure, ROLLBACK and report which statement failed
     *  7) DISCARD ALL and return the connection — or drop it when it is no longer trustworthy
     *
     * @throws {GuardRejectionError} When the guard refuses a statement.
     * @throws {StatementError} When the server rejects a statement or the connection dies during one.
     * @throws {CommitError} When COMMIT fails.
     * @throws {CallCancelledError} When `options.signal` aborts the call.
     */
    async execute(sql: string, options: ExecuteOptions): Promise<ExecuteResult> {
        const startedAt = Date.now();
        const policy = this.profile.policy;
        const signal = options.signal;
        // A call, not a property read: TypeScript would narrow `signal.aborted` to false after the first check, but the abort arrives asynchronously
        const isCancelled = () => signal?.aborted == true;

        // (1) Effective mode
        const readOnly = options.readOnly == true || policy.readonly == true;
        let transaction = options.transaction;
        if(readOnly == true) {
            transaction = "rollback";
        }
        const maxRows = options.maxRows ?? policy.maxRows;
        const params = options.params ?? [];

        // (2) Guard
        const statements = await this.parse(sql);
        let guardPolicy = policy;
        if(options.internalSql == true) {
            guardPolicy = { ...policy, denyPatterns: [], allowDdl: true };
        }
        const verdict = checkStatements(statements, guardPolicy, readOnly);
        if(verdict.allowed == false) {
            throw new GuardRejectionError(verdict);
        }
        if(params.length > 0 && statements.length > 1) {
            throw new Error(`params ($1, $2, …) work with a single statement; this call has ${statements.length}`);
        }
        if(isCancelled() == true) {
            throw new CallCancelledError("the call was cancelled before it reached the database");
        }

        let _logger = $logger.child({
            context: "PostgresDriver.execute",
            profile: this.profile.name,
            statement_count: statements.length,
            transaction: transaction,
            read_only: readOnly,
        });

        // (3) Connection — pg-pool drops its own 'error' listener while a client is checked out,
        // so without this one a connection dying mid-call is an uncaught exception
        let client: pg.PoolClient;
        try {
            client = await this.pool.connect();
        }
        catch(ex) {
            // pg-pool's wording for "no slot freed up in time" reads like a network failure
            if(describeError(ex) === "timeout exceeded when trying to connect") {
                throw new Error(`all ${POOL_MAX_CLIENTS} database connections are busy with other calls, and none freed up within ${policy.connectTimeoutMs} ms — retry shortly`);
            }
            throw ex;
        }
        let brokenConnection: Error | undefined;
        let markConnectionLost: (error: Error) => void = () => undefined;
        // Rejects when the connection dies — every wait on this client races it, so none outlives the connection
        const connectionLost = new Promise<never>((_resolve, reject) => {
            markConnectionLost = reject;
        });
        connectionLost.catch(() => undefined);
        const onClientError = (error: Error) => {
            brokenConnection = error;
            markConnectionLost(error);
            _logger.warn("database connection lost during the call", { error_message: error.message });
        };
        client.on("error", onClientError);
        // NOTICE / WARNING sent while a statement runs — "relation … already exists, skipping", RAISE NOTICE output
        const notices: { current: string[]; dropped: number } = { current: [], dropped: 0 };
        const onNotice = (notice: { severity?: string; message?: string }) => {
            if(notices.current.length >= MAX_NOTICES_PER_STATEMENT) {
                notices.dropped += 1;
                return;
            }
            notices.current.push(`${notice.severity ?? "NOTICE"}: ${notice.message ?? ""}`);
        };
        client.on("notice", onNotice);
        this.activeClients.add(client);
        const cancellation: { requested: boolean; deadline?: NodeJS.Timeout } = { requested: false };
        const onAbort = () => {
            cancellation.requested = true;
            _logger.info("call cancelled by the client; asking the server to stop the running statement");
            this.sendCancelRequest(client).catch((error: unknown) => {
                _logger.warn("cancel request could not be sent", { error_message: describeError(error) });
            });
            // A server that stopped answering ignores the CancelRequest too — through a tunnel the socket stays open,
            // so cutting it is what ends the call, frees its connection and makes the server roll back
            cancellation.deadline = setTimeout(() => {
                _logger.warn("cancelled call still running after the grace period; closing its connection", { grace_ms: CANCEL_GRACE_MS });
                destroyClientSocket(client, new Error(`the call was cancelled and the server did not stop it within ${CANCEL_GRACE_MS} ms; its connection was closed`));
            }, CANCEL_GRACE_MS);
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        let inTransaction = false;
        const results: StatementResult[] = [];
        try {
            // Waiting for a free connection can outlast the client's patience
            if(isCancelled() == true) {
                throw new CallCancelledError("the call was cancelled before it reached the database");
            }

            // (4) Transaction
            if(transaction !== "autocommit") {
                let beginCommand = "BEGIN";
                if(readOnly == true) {
                    beginCommand = "BEGIN READ ONLY";
                }
                // The profile's timeout set for this transaction too: a pooler that drops startup parameters
                // (PgBouncer's ignore_startup_parameters) would otherwise leave the server's default, often none
                await untilConnectionLost(client.query(`${beginCommand}; SET LOCAL statement_timeout = ${policy.statementTimeoutMs}`), connectionLost);
                inTransaction = true;
            }
            else {
                // Session-level here; the closing DISCARD ALL returns it to the connection's start value
                await untilConnectionLost(client.query(`SET statement_timeout = ${policy.statementTimeoutMs}`), connectionLost);
            }

            // (5) Statements, one at a time — results and failures stay attributable to each
            for(const statement of statements) {
                if(isCancelled() == true) {
                    let committedNote = "nothing was committed";
                    if(transaction === "autocommit" && statement.index > 1) {
                        committedNote = `statements 1–${statement.index - 1} were already committed (autocommit)`;
                    }
                    throw new CallCancelledError(`the call was cancelled before statement ${statement.index} of ${statements.length} ran; ${committedNote}`);
                }
                _logger = _logger.child({ statement_index: statement.index, statement_kind: statement.kind });
                notices.current = [];
                notices.dropped = 0;
                const takeNotices = () => {
                    if(notices.current.length == 0) {
                        return undefined;
                    }
                    return { kept: [...notices.current], dropped: notices.dropped };
                };
                try {
                    const result = await runStatement(client, statement, params, maxRows, connectionLost, isCancelled);
                    const statementNotices = takeNotices();
                    if(statementNotices != null) {
                        result.notices = statementNotices.kept;
                        if(statementNotices.dropped > 0) {
                            result.droppedNotices = statementNotices.dropped;
                        }
                    }
                    results.push(result);
                }
                catch(ex) {
                    if(ex instanceof CallCancelledError) {
                        // The statement's portal is still open: closing it would send the Sync that commits an autocommit
                        // statement. Cutting the socket instead makes the server roll it back.
                        destroyClientSocket(client, ex);
                        brokenConnection = ex;
                        let committedNote = "nothing was committed";
                        if(transaction === "autocommit" && statement.index > 1) {
                            committedNote = `statements 1–${statement.index - 1} were already committed (autocommit)`;
                        }
                        throw new CallCancelledError(`the call was cancelled during statement ${statement.index} of ${statements.length}, which was rolled back; ${committedNote}`);
                    }
                    throw new StatementError(statement, statements.length, transaction, ex, [...results], takeNotices());
                }
            }

            // (6) End
            if(inTransaction == true) {
                if(transaction === "commit") {
                    if(isCancelled() == true) {
                        throw new CallCancelledError("the call was cancelled before COMMIT; the transaction was rolled back");
                    }
                    // COMMIT ends the transaction whether it succeeds or not — a failed COMMIT has already rolled back
                    inTransaction = false;
                    try {
                        await untilConnectionLost(client.query("COMMIT"), connectionLost);
                    }
                    catch(ex) {
                        throw new CommitError(statements.length, ex);
                    }
                }
                else {
                    await untilConnectionLost(client.query("ROLLBACK"), connectionLost);
                    inTransaction = false;
                }
            }

            const executeResult: ExecuteResult = {
                statements: results,
                transaction: transaction,
                readOnly: readOnly,
                durationMs: Date.now() - startedAt,
            };
            return executeResult;
        }
        catch(ex) {
            let cause: unknown = ex;
            if(ex instanceof StatementError || ex instanceof CommitError) {
                cause = ex.cause;
            }
            // Only an ordinary answer from the server leaves the connection in a known state; anything else may have stopped it mid-protocol
            if(brokenConnection == null && isStatementLevelError(cause) == false && ex instanceof CallCancelledError == false) {
                brokenConnection = new Error(describeError(cause));
            }
            if(inTransaction == true && brokenConnection == null) {
                try {
                    await untilConnectionLost(client.query("ROLLBACK"), connectionLost);
                }
                catch(rollbackError) {
                    brokenConnection = rollbackError as Error;
                }
            }
            _logger.warn("call failed", { error_message: describeError(cause), sql_state: (cause as { code?: unknown }).code });
            throw ex;
        }
        finally {
            signal?.removeEventListener("abort", onAbort);
            clearTimeout(cancellation.deadline);
            // The CancelRequest travels on its own connection and may land after this call is over —
            // on the next call's statement, if this backend went back to the pool
            if(cancellation.requested == true && brokenConnection == null) {
                brokenConnection = new Error("a cancel request was sent to this connection's backend");
            }
            // (7) Session state set by this call (SET, set_config, temp tables) must not reach the next one.
            // RESET returns each setting to its connection-start value, so the profile's timeout comes back.
            if(brokenConnection == null && options.resetSession != false) {
                try {
                    await untilConnectionLost(client.query("DISCARD ALL"), connectionLost);
                }
                catch(discardError) {
                    brokenConnection = discardError as Error;
                }
            }
            // Detached right before release, which hands the client back to pg-pool's own listener
            this.activeClients.delete(client);
            client.removeListener("notice", onNotice);
            client.removeListener("error", onClientError);
            // Passing an error makes the pool destroy the client instead of reusing a dead connection
            client.release(brokenConnection);
        }
    }

    /**
     * The wire protocol's CancelRequest for the statement `client` is running, sent on a
     * connection of its own (through the tunnel when there is one). Best effort: a backend that
     * is idle by the time it arrives ignores it, and the call's own checks stop what follows.
     */
    private async sendCancelRequest(client: pg.PoolClient): Promise<void> {
        const backend = client as unknown as { processID: number | null; secretKey: number | null };
        if(backend.processID == null || backend.secretKey == null) {
            return;
        }
        const packet = Buffer.alloc(16);
        packet.writeInt32BE(16, 0);
        packet.writeInt32BE(CANCEL_REQUEST_CODE, 4);
        packet.writeInt32BE(backend.processID, 8);
        packet.writeInt32BE(backend.secretKey, 12);

        const timeoutMs = this.profile.policy.connectTimeoutMs;
        let stream: Duplex;
        if(this.tunnel != null) {
            stream = await this.tunnel.openChannel(this.profile.host, this.profile.port);
        }
        else {
            const socket = net.connect(this.profile.port, this.profile.host);
            socket.setTimeout(timeoutMs, () => {
                socket.destroy(new Error("cancel request connection timed out"));
            });
            await once(socket, "connect");
            stream = socket;
        }

        // The server reads the packet and closes the connection without replying
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                stream.destroy();
                resolve();
            }, timeoutMs);
            stream.on("error", () => undefined);
            stream.once("close", () => {
                clearTimeout(timer);
                resolve();
            });
            stream.end(packet);
        });
    }

    /** Connects step by step — SSH, then the database — and reports each, for `--check`. */
    async check(onProgress?: (stage: "ssh" | "database") => void): Promise<CheckReport> {
        const report: CheckReport = { ssh: null, database: null };

        if(this.tunnel != null) {
            const sshStartedAt = Date.now();
            try {
                onProgress?.("ssh");
                await this.tunnel.connect();
                report.ssh = {
                    ok: true,
                    endpoint: this.tunnel.endpoint,
                    durationMs: Date.now() - sshStartedAt,
                    hostKeyFingerprint: this.tunnel.hostKeyFingerprint,
                    pinned: this.tunnel.profile.hostKeyFingerprint != null,
                };
            }
            catch(ex) {
                report.ssh = {
                    ok: false,
                    endpoint: this.tunnel.endpoint,
                    durationMs: Date.now() - sshStartedAt,
                    hostKeyFingerprint: this.tunnel.hostKeyFingerprint,
                    pinned: this.tunnel.profile.hostKeyFingerprint != null,
                    error: describeError(ex),
                };
                return report;
            }
        }

        const databaseStartedAt = Date.now();
        try {
            onProgress?.("database");
            const result = await this.pool.query(
                "SELECT split_part(version(), ' ', 2) AS version, current_database() AS database, current_user AS user_name, "
                + "(SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl, current_setting('statement_timeout') AS statement_timeout"
            );
            const row = result.rows[0];
            report.database = {
                ok: true,
                durationMs: Date.now() - databaseStartedAt,
                version: row.version,
                database: row.database,
                user: row.user_name,
                ssl: row.ssl,
                statementTimeout: row.statement_timeout,
            };
        }
        catch(ex) {
            report.database = { ok: false, durationMs: Date.now() - databaseStartedAt, error: describeError(ex) };
        }
        return report;
    }

    /**
     * Cuts the socket of every call still running. Each fails with the given reason, frees its
     * connection, and the server rolls back what it had not committed. For a process-level failure
     * that may have left a connection stopped mid-protocol (an exception inside pg's parser), and for shutdown.
     *
     * @returns How many connections were cut.
     */
    abortActiveConnections(reason: Error): number {
        const clients = [...this.activeClients];
        for(const client of clients) {
            destroyClientSocket(client, reason);
        }
        return clients.length;
    }

    async close(): Promise<void> {
        // pool.end() waits for checked-out clients; a call stuck on an unresponsive server would hold shutdown forever
        this.abortActiveConnections(new Error("the server is shutting down"));
        try {
            await Promise.all([this.parser.close(), this.pool.end()]);
        } finally {
            this.tunnel?.close();
        }
    }
}

/** Closes `client`'s socket: pg fails whatever runs on it, and the server, seeing the connection go, rolls back. */
function destroyClientSocket(client: pg.PoolClient, reason: Error): void {
    const connection = (client as unknown as { connection?: { stream?: Duplex } }).connection;
    connection?.stream?.destroy(reason);
}

/**
 * `work`, unless the connection dies first — pg-cursor would otherwise wait for a ReadyForQuery a
 * dead connection never sends. A reply that arrived in the same packet as a FATAL still counts:
 * pg settles client.query a microtask late and pg-cursor's read on setImmediate, so the loss wins
 * the race against an answer the server did give. One more turn tells them apart.
 */
async function untilConnectionLost<T>(work: Promise<T>, connectionLost: Promise<never>): Promise<T> {
    const outcome: { settled: boolean; value?: T } = { settled: false };
    const tracked = work.then((value) => {
        outcome.settled = true;
        outcome.value = value;
        return value;
    });
    try {
        const value = await Promise.race([tracked, connectionLost]);
        return value;
    }
    catch(ex) {
        if(outcome.settled == false) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        if(outcome.settled == true) {
            return outcome.value as T;
        }
        throw ex;
    }
}

/**
 * One statement through a cursor: reads at most maxRows + 1 rows, so the extra one only says "there is more".
 * Every wait goes through `untilConnectionLost`.
 *
 * @throws {CallCancelledError} When the call is cancelled while the portal is still open — before
 *   a drain read or the closing Sync, which would commit an autocommit statement. The caller cuts the socket.
 */
async function runStatement(
    client: pg.PoolClient,
    statement: ParsedStatement,
    params: unknown[],
    maxRows: number,
    connectionLost: Promise<never>,
    isCancelled: () => boolean
): Promise<StatementResult> {
    const startedAt = Date.now();
    const cursor = client.query(new LateErrorCursor(statement.text, params, { rowMode: "array", types: TYPE_PARSERS }));
    // A rejected read leaves nothing to close: the error ended the portal and pg-cursor already sent Sync
    const rawRows = (await untilConnectionLost(cursor.read(maxRows + 1), connectionLost)) as unknown[][];

    // pg-cursor keeps the server's row description and command tag on its private Result
    const serverResult = (cursor as unknown as {
        _result: { command: string | null; rowCount: number | null; fields: { name: string; dataTypeID: number }[] };
    })._result;
    const fields: ResultField[] = serverResult.fields.map((field) => ({ name: field.name, dataTypeId: field.dataTypeID }));

    // A repeated column name (SELECT 1 AS a, 2 AS a) would overwrite itself in an object: a, a#2, a#3 —
    // skipping a suffix that is itself a column name, so `a#2` as a real column keeps its value
    const keys: string[] = [];
    const taken = new Set<string>();
    const fieldNames = new Set(fields.map((field) => field.name));
    for(const field of fields) {
        let key = field.name;
        let suffix = 1;
        while(taken.has(key) == true || (key !== field.name && fieldNames.has(key) == true)) {
            suffix += 1;
            key = `${field.name}#${suffix}`;
        }
        taken.add(key);
        keys.push(key);
    }

    const truncated = rawRows.length > maxRows;
    // An INSERT / UPDATE / DELETE / MERGE … RETURNING ran to completion on the first fetch (its rows wait
    // in a server-side store), so stopping here would hide only the count: read the rest, dropping it, and count.
    // The command tag can't give the count — PostgreSQL puts only the last fetch's rows in it. A SELECT whose
    // WITH writes is not drained: its writes finish when the portal closes, and its outer rows may be millions.
    let drainedRowCount: number | null = null;
    if(truncated == true && DRAINED_KINDS.has(statement.kind) == true) {
        drainedRowCount = rawRows.length;
        let batch: unknown[];
        // A full batch leaves the portal suspended; a short one means the end came, and pg-cursor already sent the Sync
        // that commits an autocommit statement — a cancel after that is too late to undo it, so it is not checked
        do {
            if(isCancelled() == true) {
                throw new CallCancelledError("cancelled while reading the rest of a write's RETURNING rows");
            }
            batch = (await untilConnectionLost(cursor.read(DRAIN_BATCH_ROWS), connectionLost)) as unknown[];
            drainedRowCount += batch.length;
        } while(batch.length === DRAIN_BATCH_ROWS);
    }

    const rows = rawRows.slice(0, maxRows).map((rawRow) => {
        // No prototype: a column named __proto__ would otherwise set it instead of becoming a key
        const row: Record<string, unknown> = Object.create(null);
        for(const [position, key] of keys.entries()) {
            row[key] = rawRow[position];
        }
        return row;
    });

    // A truncated portal is still open here; a finished one already sent its Sync on CommandComplete
    if(truncated == true && drainedRowCount == null && isCancelled() == true) {
        throw new CallCancelledError("cancelled before the statement's portal was closed");
    }
    await untilConnectionLost(cursor.close(), connectionLost);
    // Truncated autocommit read: the implicit commit happens at close's Sync, so its failure arrives only now
    if(cursor.lateError != null) {
        throw cursor.lateError;
    }

    const result: StatementResult = {
        index: statement.index,
        kind: statement.kind,
        command: serverResult.command ?? null,
        rowCount: drainedRowCount ?? serverResult.rowCount ?? null,
        fields: fields,
        rows: rows,
        truncated: truncated,
        ddl: changesSchema(statement),
        writes: writesData(statement),
        durationMs: Date.now() - startedAt,
    };
    return result;
}
