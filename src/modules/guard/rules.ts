import type { DbPolicy, GuardRefusalKind, GuardVerdict, ParsedStatement } from "@/_types";

// Threat model: a mistaken agent, not an adversary. A rule here reads the parse tree, so
// `delete from t` in any casing or spacing is the same node — but a DO block's body is a
// PL/pgSQL string the tree does not open, and that is accepted (read-only refuses DO outright).

/** Statement kinds a read-only call may start with. VALUES and TABLE parse as SelectStmt. */
const READ_KINDS = new Set(["SelectStmt", "ExplainStmt", "VariableShowStmt"]);

/** Nodes that write wherever they appear — a top-level statement or a `WITH x AS (DELETE …)`. */
const WRITE_NODE_KINDS = new Set(["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"]);

const DDL_KIND_PATTERN = /^(Create|Alter|Drop|Define|Rename|Comment|Grant|Revoke)/;
const DDL_EXTRA_KINDS = new Set([
    "IndexStmt",
    "ViewStmt",
    "CompositeTypeStmt",
    "RuleStmt",
    "RefreshMatViewStmt",
    "ReindexStmt",
    "ClusterStmt",
    "SecLabelStmt",
    "ImportForeignSchemaStmt",
    "ReassignOwnedStmt",
]);

/**
 * Functions whose effect lands outside the transaction — on other sessions, the server,
 * replication, files or a remote database — so BEGIN READ ONLY … ROLLBACK neither stops nor
 * undoes them.
 */
const OUTSIDE_TRANSACTION_FUNCTIONS = new Set([
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_reload_conf",
    "pg_rotate_logfile",
    "pg_switch_wal",
    "pg_create_restore_point",
    "pg_logical_emit_message",
    "pg_backup_start",
    "pg_backup_stop",
    "pg_promote",
    "pg_wal_replay_pause",
    "pg_wal_replay_resume",
    "pg_import_system_collations",
    "pg_stat_statements_reset",
    "pg_replication_slot_advance",
    "lo_export",
    "pg_file_write",
    "pg_file_rename",
    "pg_file_unlink",
    "pg_file_sync",
]);
/** pg_{create,drop,copy}_…replication_slot · replication-origin changes · pg_stat_reset* · slot-consuming reads · dblink* */
const OUTSIDE_TRANSACTION_FUNCTION_PATTERN =
    /^(pg_(create|drop|copy)_\w*replication_slot|pg_replication_origin_(create|drop|advance|session_setup|session_reset|xact_setup|xact_reset)|pg_stat_reset|pg_logical_slot_get_|dblink)/;

/**
 * The time limits a read-only call must keep. set_config is otherwise harmless there — a setting it
 * changes is undone by the closing ROLLBACK — but lifting these would let the call run unbounded.
 */
const TIME_LIMIT_SETTINGS = new Set(["statement_timeout", "transaction_timeout"]);

interface NodeVisit {
    kind: string;
    fields: Record<string, unknown>;
}

/** True for statement kinds that change the schema rather than the data. */
export function isDdlKind(kind: string): boolean {
    if(DDL_KIND_PATTERN.test(kind) == true) {
        return true;
    }
    return DDL_EXTRA_KINDS.has(kind);
}

/** Every node in the tree. libpg_query wraps each node as `{ NodeName: fields }`; field names start lowercase. */
function collectNodes(value: unknown, visits: NodeVisit[]): void {
    if(Array.isArray(value) == true) {
        for(const item of value as unknown[]) {
            collectNodes(item, visits);
        }
        return;
    }
    if(value == null || typeof value !== "object") {
        return;
    }
    for(const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const isObject = child != null && typeof child === "object" && Array.isArray(child) == false;
        if(/^[A-Z]/.test(key) == true && isObject == true) {
            visits.push({ kind: key, fields: child as Record<string, unknown> });
        }
        // A UNION's branches are typed fields, so libpg_query leaves those SelectStmts unwrapped
        if((key === "larg" || key === "rarg") && isObject == true) {
            visits.push({ kind: "SelectStmt", fields: child as Record<string, unknown> });
        }
        collectNodes(child, visits);
    }
}

/** The statement itself plus every node inside it. */
function collectStatementNodes(statement: ParsedStatement): NodeVisit[] {
    const visits: NodeVisit[] = [{ kind: statement.kind, fields: statement.node }];
    collectNodes(statement.node, visits);
    return visits;
}

/** An EXPLAIN without ANALYZE plans what it wraps and runs none of it — nothing inside it creates or writes. */
function runsNothing(statement: ParsedStatement): boolean {
    return statement.kind === "ExplainStmt" && explainRunsStatement(statement.node) == false;
}

/** By its kind, or through a table created inside it: `EXPLAIN ANALYZE CREATE TABLE … AS`, `PREPARE … AS SELECT … INTO`, `SELECT … INTO`. */
function changesSchemaThrough(statement: ParsedStatement, visits: NodeVisit[]): boolean {
    if(isDdlKind(statement.kind) == true) {
        return true;
    }
    if(runsNothing(statement) == true) {
        return false;
    }
    for(const visit of visits) {
        if(visit.kind === "CreateTableAsStmt") {
            return true;
        }
        if(visit.kind === "SelectStmt" && visit.fields.intoClause != null) {
            return true;
        }
    }
    return false;
}

/** True when running the statement changes the schema — what the DDL switch refuses and a result's `ddl` flag reports. */
export function changesSchema(statement: ParsedStatement): boolean {
    const visits = collectStatementNodes(statement);
    return changesSchemaThrough(statement, visits);
}

/** True when running the statement inserts, updates, deletes or merges rows — at its top or inside a WITH. */
export function writesData(statement: ParsedStatement): boolean {
    if(runsNothing(statement) == true) {
        return false;
    }
    const visits = collectStatementNodes(statement);
    return visits.some((visit) => WRITE_NODE_KINDS.has(visit.kind));
}

/**
 * A constant argument as text — `'on'`, `'statement_timeout'`, the integer `1` of `SET … = 1` — or null
 * when it is anything else: a column, an expression, a parameter.
 */
function constantText(argument: unknown): string | null {
    // { A_Const: { sval: { sval: "on" } } } · { A_Const: { ival: { ival: 1 } } } — and 0 is { ival: {} }
    const constant = (argument as { A_Const?: { sval?: { sval?: string }; ival?: { ival?: number } } } | undefined)?.A_Const;
    if(constant?.sval?.sval != null) {
        return constant.sval.sval;
    }
    if(constant?.ival != null) {
        return String(constant.ival.ival ?? 0);
    }
    return null;
}

/** Values that leave standard_conforming_strings on — what the connection already pins and the guard assumes. */
const STANDARD_STRINGS_ON = new Set(["on", "true", "yes", "1"]);

const STANDARD_STRINGS_KEPT_ON = "standard_conforming_strings stays on, as the connection set it — the guard reads string literals that way; write E'…' for backslash escapes";

/**
 * Why the statement may switch standard_conforming_strings off, or null: `SET [LOCAL]` to anything but
 * on, `RESET` / `SET … TO DEFAULT` (which return to a value the database or role may have set to off),
 * set_config with that name — or with a name that is not a constant — and UPDATE pg_settings, whose
 * rule calls set_config. A pg_dump header's `SET standard_conforming_strings = on` changes nothing and passes.
 */
function findStringLexingChange(statement: ParsedStatement, visits: NodeVisit[]): string | null {
    if(statement.kind === "VariableSetStmt") {
        // RESET ALL / SET SESSION AUTHORIZATION … carry no name, and RESET ALL keeps the startup value
        if(String(statement.node.name ?? "").toLowerCase() !== "standard_conforming_strings") {
            return null;
        }
        if(statement.node.kind !== "VAR_SET_VALUE") {
            return STANDARD_STRINGS_KEPT_ON;
        }
        const [value] = (statement.node.args ?? []) as unknown[];
        if(STANDARD_STRINGS_ON.has(String(constantText(value)).toLowerCase()) == false) {
            return STANDARD_STRINGS_KEPT_ON;
        }
        return null;
    }
    for(const visit of visits) {
        // pg_settings is a view; its UPDATE rule runs set_config for each matched row. Unqualified, the name always
        // means that view (pg_catalog is searched first); a table of that name elsewhere has to be schema-qualified.
        const updated = visit.fields.relation as { schemaname?: string; relname?: string } | undefined;
        if(visit.kind === "UpdateStmt" && updated?.relname === "pg_settings" && (updated.schemaname == null || updated.schemaname === "pg_catalog")) {
            return "UPDATE pg_settings could switch standard_conforming_strings off, which the guard cannot follow — use SET name = value or set_config('name', …)";
        }
        if(calledFunctionName(visit) !== "set_config") {
            continue;
        }
        const [settingArgument, valueArgument] = (visit.fields.args ?? []) as unknown[];
        if(STANDARD_STRINGS_ON.has(String(constantText(valueArgument)).toLowerCase()) == true) {
            continue;
        }
        const settingName = constantText(settingArgument);
        if(settingName == null) {
            return "set_config() with a setting name that is not a string constant could switch standard_conforming_strings off, which the guard cannot follow — name the setting directly";
        }
        if(settingName.toLowerCase() === "standard_conforming_strings") {
            return STANDARD_STRINGS_KEPT_ON;
        }
    }
    return null;
}

/** `pg_catalog.pg_terminate_backend` → `pg_terminate_backend`; null for anything but a function call. */
function calledFunctionName(visit: NodeVisit): string | null {
    if(visit.kind !== "FuncCall") {
        return null;
    }
    // [{ String: { sval: "pg_catalog" } }, { String: { sval: "pg_terminate_backend" } }]
    const nameParts = (visit.fields.funcname ?? []) as { String?: { sval?: string } }[];
    const lastPart = nameParts[nameParts.length - 1]?.String?.sval;
    if(lastPart == null) {
        return null;
    }
    return lastPart.toLowerCase();
}

/** The always-refused operations. Returns the reason, or null when the node is fine. */
function findCatastrophe(visit: NodeVisit): string | null {
    switch(visit.kind) {
        case "TruncateStmt":
            return "TRUNCATE empties whole tables";
        case "UpdateStmt":
            if(visit.fields.whereClause == null) {
                return "UPDATE without WHERE changes every row of the table";
            }
            return null;
        case "DeleteStmt":
            if(visit.fields.whereClause == null) {
                return "DELETE without WHERE removes every row of the table";
            }
            return null;
        case "DropdbStmt":
            return "DROP DATABASE removes the whole database";
        case "DropStmt":
            if(visit.fields.removeType === "OBJECT_SCHEMA") {
                return "DROP SCHEMA removes every object in the schema";
            }
            return null;
        case "DropTableSpaceStmt":
            return "DROP TABLESPACE removes a storage location";
        case "DropOwnedStmt":
            return "DROP OWNED removes everything a role owns";
        case "AlterSystemStmt":
            return "ALTER SYSTEM rewrites the server's configuration";
        case "CopyStmt":
            if(visit.fields.is_program === true) {
                return "COPY … PROGRAM runs a shell command on the database server";
            }
            return null;
        default:
            return null;
    }
}

/**
 * `EXPLAIN ANALYZE` and `EXPLAIN (ANALYZE [true|on|1])` run the statement; `(ANALYZE false)` does not.
 * A repeated option counts by its last occurrence, as PostgreSQL reads it: `(ANALYZE false, ANALYZE true)` runs.
 */
function explainRunsStatement(fields: Record<string, unknown>): boolean {
    const options = (fields.options ?? []) as { DefElem?: { defname?: string; arg?: Record<string, Record<string, unknown>> } }[];
    let runs = false;
    for(const option of options) {
        if(option.DefElem?.defname !== "analyze") {
            continue;
        }
        const arg = option.DefElem.arg;
        if(arg == null) {
            runs = true;
        }
        else if(arg.Boolean != null) {
            runs = arg.Boolean.boolval === true;
        }
        else if(arg.String != null) {
            const value = String(arg.String.sval ?? "").toLowerCase();
            runs = value === "true" || value === "on" || value === "1";
        }
        else if(arg.Integer != null) {
            runs = Number(arg.Integer.ival ?? 0) !== 0;
        }
        else {
            runs = true;
        }
    }
    return runs;
}

function reject(statement: ParsedStatement, reason: string, kind: GuardRefusalKind = "policy"): GuardVerdict {
    return { allowed: false, kind: kind, reason: reason, statementIndex: statement.index, offendingText: statement.text };
}

/**
 * Screens every statement of one call. The first rule that fires refuses the whole call.
 *
 * Order: transaction control → always-refused → standard_conforming_strings → deny patterns → DDL switch → read-only → COPY over STDIN / STDOUT.
 */
export function checkStatements(
    statements: ParsedStatement[],
    policy: DbPolicy,
    readOnly: boolean
): GuardVerdict {
    for(const statement of statements) {
        // (1) The tool owns the transaction; a COMMIT inside the call would end it early. The agent should rewrite, not report it
        if(statement.kind === "TransactionStmt") {
            return reject(statement, "transaction control (BEGIN / COMMIT / ROLLBACK / SAVEPOINT) is managed by the tool — the statements of one call already run in one transaction; pass transaction: false to run them one by one", "unsupported");
        }

        const visits = collectStatementNodes(statement);

        // (2) Always refused, whatever the profile says — first, so an UPDATE pg_settings without WHERE reads as policy
        for(const visit of visits) {
            const catastrophe = findCatastrophe(visit);
            if(catastrophe != null) {
                return reject(statement, `refused on every database — ${catastrophe}`);
            }
        }

        // The guard lexes strings as standard_conforming_strings=on; switching it off mid-call would make the
        // server read the following statements differently from what was screened (a WHERE inside a string)
        const stringLexingChange = findStringLexingChange(statement, visits);
        if(stringLexingChange != null) {
            return reject(statement, stringLexingChange, "unsupported");
        }

        // (3) Profile deny patterns, against the statement's own text
        for(const pattern of policy.denyPatterns) {
            if(pattern.test(statement.text) == true) {
                return reject(statement, `matches the deny pattern /${pattern.source}/`);
            }
        }

        // (4) Schema changes switched off — SELECT … INTO and EXPLAIN ANALYZE CREATE TABLE … AS create tables too
        if(policy.allowDdl == false && changesSchemaThrough(statement, visits) == true) {
            return reject(statement, "schema changes (DDL) are disabled on this database");
        }

        // (5) Read-only — the transaction is READ ONLY as well; this refuses early with a clear reason,
        // and refuses what READ ONLY … ROLLBACK cannot stop
        if(readOnly == true) {
            if(READ_KINDS.has(statement.kind) == false) {
                return reject(statement, "this call is read-only — only SELECT, VALUES, TABLE, SHOW and EXPLAIN run");
            }
            if(statement.kind === "ExplainStmt" && explainRunsStatement(statement.node) == false) {
                continue;
            }
            for(const visit of visits) {
                if(WRITE_NODE_KINDS.has(visit.kind) == true) {
                    return reject(statement, "this call is read-only — the statement writes data (a data-modifying WITH counts)");
                }
                if(visit.kind === "SelectStmt" && visit.fields.intoClause != null) {
                    return reject(statement, "this call is read-only — SELECT … INTO creates a table");
                }
                // The server's READ ONLY check does not cover the table EXPLAIN ANALYZE creates; only the final ROLLBACK would remove it
                if(visit.kind === "CreateTableAsStmt") {
                    return reject(statement, "this call is read-only — CREATE TABLE … AS creates a table");
                }
                const functionName = calledFunctionName(visit);
                if(functionName == null) {
                    continue;
                }
                if(OUTSIDE_TRANSACTION_FUNCTIONS.has(functionName) == true || OUTSIDE_TRANSACTION_FUNCTION_PATTERN.test(functionName) == true) {
                    return reject(statement, `this call is read-only — ${functionName}() acts outside the transaction, so the closing ROLLBACK cannot undo it`);
                }
                if(functionName === "set_config") {
                    // set_config('search_path', …) is fine: the closing ROLLBACK undoes it. A time limit is another matter
                    const settingName = constantText(((visit.fields.args ?? []) as unknown[])[0])?.toLowerCase();
                    if(settingName == null) {
                        return reject(statement, "this call is read-only — set_config() with a setting name that is not a string constant cannot be checked; name the setting directly");
                    }
                    if(TIME_LIMIT_SETTINGS.has(settingName) == true) {
                        return reject(statement, `this call is read-only — set_config('${settingName}', …) would lift the profile's time limit for this call`);
                    }
                }
            }
        }

        // (6) After the policy rules, so a COPY the profile forbids anyway is reported as policy — "rewrite it as INSERT" would mislead there.
        // No filename = STDIN / STDOUT — a COPY stream the statement cursor cannot carry (pg throws outside any handler)
        if(statement.kind === "CopyStmt" && statement.node.filename == null) {
            return reject(statement, "COPY … FROM STDIN / TO STDOUT streams rows over the connection, which this tool cannot carry — use INSERT … VALUES or SELECT instead, or COPY to / from a file on the database server", "unsupported");
        }
    }
    return { allowed: true };
}
