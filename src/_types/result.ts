/**
 * How one tool call ends its transaction.
 * `commit` — every statement in one transaction, committed at the end (rolled back on the first failure).
 * `autocommit` — each statement on its own, no surrounding transaction.
 * `rollback` — one transaction, always rolled back (read-only profiles, EXPLAIN, catalog lookups).
 */
export type TransactionMode = "commit" | "autocommit" | "rollback";

/** One statement of a call, as the parser split it. */
export interface ParsedStatement {
    /** 1-based position in the call. */
    index: number;
    /** libpg_query node name, e.g. `SelectStmt`, `DeleteStmt`. */
    kind: string;
    /** The statement's own source text, sliced from the call by the parser's byte offsets. */
    text: string;
    /** The parser's node fields for `kind`. */
    node: Record<string, unknown>;
}

/**
 * Why a call was refused before anything was sent.
 * `policy` — the profile forbids it; the agent should report it, not rephrase around it.
 * `unsupported` — a shape this tool cannot run (COPY over STDIN/STDOUT, BEGIN/COMMIT); rewrite it.
 * `syntax` — the text does not parse as PostgreSQL; fix it.
 */
export type GuardRefusalKind = "policy" | "unsupported" | "syntax";

/** Verdict from the statement guard. */
export interface GuardVerdict {
    allowed: boolean;
    /** Only set when `allowed` is false. */
    kind?: GuardRefusalKind;
    /** Human-readable rejection cause; only set when `allowed` is false. */
    reason?: string;
    /** 1-based statement that tripped the rule. */
    statementIndex?: number;
    offendingText?: string;
}

export interface ResultField {
    name: string;
    dataTypeId: number;
}

/** Outcome of one statement. */
export interface StatementResult {
    index: number;
    kind: string;
    /** Command tag from the server (`SELECT`, `UPDATE`, …); null when the cursor stopped early. */
    command: string | null;
    /** Rows affected or returned as the server counted them; null when the cursor stopped early. */
    rowCount: number | null;
    fields: ResultField[];
    /** Rows as objects; a repeated column name gets a `#2`, `#3` suffix so no value is lost. */
    rows: Record<string, unknown>[];
    /** True when more rows existed than were read. */
    truncated: boolean;
    /** True for schema-changing statements, so a report can't miss them. */
    ddl: boolean;
    /** True when the statement writes rows — at its top or in a WITH; false for an EXPLAIN that runs nothing. */
    writes?: boolean;
    durationMs: number;
    /** `NOTICE: relation "t" already exists, skipping` — what the server said while the statement ran, the first 20. */
    notices?: string[];
    /** How many more notices the statement sent past those kept in `notices`. */
    droppedNotices?: number;
}

/** Outcome of one tool call. */
export interface ExecuteResult {
    statements: StatementResult[];
    transaction: TransactionMode;
    readOnly: boolean;
    durationMs: number;
}
