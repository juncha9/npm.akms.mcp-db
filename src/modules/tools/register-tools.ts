import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CATALOG_MAX_ROWS, DB_ENV } from "@/_defs";
import type { DbProfile, DbSummary, ExecuteResult } from "@/_types";
import { $logger } from "@/_libs/logger";
import { describeError, truncateOutput } from "@/_libs/text";
import { formatGuardRejection, GuardRejectionError } from "@/modules/guard/guard-error";
import { parseStatements } from "@/modules/guard/parse";
import { checkStatements } from "@/modules/guard/rules";
import { describeRelation, findSchemas, listRelations, listSchemas, readSearchPath } from "@/modules/postgres/catalog";
import { CallCancelledError, CommitError, type PostgresDriver, StatementError } from "@/modules/postgres/postgres-driver";
import { toDbSummary } from "@/modules/profile";
import {
    formatDbSummary,
    formatExecuteResult,
    formatRelationDescription,
    formatRelations,
    formatSchemas,
    formatStatementLines,
    capText,
    MAX_NOTICE_CHARACTERS,
    minimumStatementLinesLength,
} from "./format";

export interface ToolContext {
    profile: DbProfile | null;
    driver: PostgresDriver | null;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** What EXPLAIN accepts after it. VALUES parses as SelectStmt. */
const EXPLAINABLE_KINDS = new Set([
    "SelectStmt",
    "InsertStmt",
    "UpdateStmt",
    "DeleteStmt",
    "MergeStmt",
    "DeclareCursorStmt",
    "CreateTableAsStmt",
]);

// A JSON integer past 2^53 is already rounded when it arrives, so binding it would silently target another value
const PARAM_VALUE_SCHEMA = z.union([
    z.string(),
    z.number().refine((value) => Number.isInteger(value) == false || Number.isSafeInteger(value) == true, {
        message: "numbers at or beyond ±2^53 lose digits as JSON numbers — pass them as strings (\"1712345678901234567\", \"6.02e23\")",
    }),
    z.boolean(),
    z.null(),
]);

/** DB_MAX_OUTPUT, or no limit when no database is registered. */
function outputLimit(context: ToolContext): number {
    return context.profile?.policy.maxOutputCharacters ?? Number.POSITIVE_INFINITY;
}

/** The last guard on size: formatters that know the shape cut by statement or row first. */
function textResult(context: ToolContext, text: string): ToolResult {
    const shown = truncateOutput(text, outputLimit(context)).text;
    return { content: [{ type: "text", text: shown }] };
}

/** Errors obey DB_MAX_OUTPUT too — a server message can quote a whole input value, an unterminated string the rest of the script. */
function errorResult(context: ToolContext, message: string): ToolResult {
    const shown = truncateOutput(message, outputLimit(context)).text;
    return { content: [{ type: "text", text: shown }], isError: true };
}

function requireDriver(context: ToolContext): PostgresDriver {
    if(context.driver == null) {
        throw new Error(`no database is registered — set ${DB_ENV.DRIVER} and ${DB_ENV.URL} (or ${DB_ENV.HOST} / ${DB_ENV.NAME} / ${DB_ENV.USER}) in this server's env block, then restart it`);
    }
    return context.driver;
}

/**
 * A server's quoted text — its message, hint, detail and where together — at most this long: one that quotes
 * a 100 kB input value must not push the outcome lines past DB_MAX_OUTPUT, whose floor (MIN_OUTPUT_CHARACTERS)
 * counts on this total.
 */
const MAX_SERVER_TEXT_CHARACTERS = 1000;

/**
 * The failure line and the fields a server error carries besides its message — code, position, detail, hint,
 * where — one indented line each. The quoted texts share one allowance, the message first, then the hint
 * (what to do), the detail and the where (mostly a call stack).
 */
function describeServerError(error: StatementError | CommitError, heading: string): string[] {
    const fields = error.cause as {
        code?: string;
        detail?: string;
        hint?: string;
        position?: string;
        where?: string;
    };
    let allowance = MAX_SERVER_TEXT_CHARACTERS;
    const quote = (text: string) => {
        const shown = capText(text, allowance);
        allowance = Math.max(0, allowance - text.length);
        return shown;
    };
    const lines = [`${heading}: ${quote(error.message)}`];
    const facts: string[] = [];
    if(fields.code != null) {
        facts.push(`code ${fields.code}`);
    }
    if(fields.position != null) {
        facts.push(`at character ${fields.position} of that statement`);
    }
    if(facts.length > 0) {
        lines.push(`  ${facts.join(" · ")}`);
    }
    let hint: string | null = null;
    if(fields.hint != null) {
        hint = quote(fields.hint);
    }
    if(fields.detail != null) {
        lines.push(`  detail: ${quote(fields.detail)}`);
    }
    if(hint != null) {
        lines.push(`  hint: ${hint}`);
    }
    if(fields.where != null) {
        lines.push(`  where: ${quote(fields.where)}`);
    }
    return lines;
}

/** The server's own words, plus where it pointed and what that meant for the other statements. */
function formatStatementError(error: StatementError, maxCharacters: number): string {
    const lines = describeServerError(error, `statement ${error.statementIndex} of ${error.statementCount} failed`);

    if(error.transaction !== "autocommit") {
        lines.push("The transaction was rolled back — no statement of this call took effect.");
        lines.push(...formatFailedStatementNotices(error, maxCharacters - lines.join("\n").length));
        return lines.join("\n");
    }

    const statement = error.statement;
    const index = error.statementIndex;
    const buildsConcurrently = (statement.kind === "IndexStmt" && statement.node.concurrent === true)
        || (statement.kind === "ReindexStmt" && JSON.stringify(statement.node.params ?? []).includes("\"concurrently\"") == true);
    if(error.connectionLost == true) {
        lines.push(`The connection was lost during statement ${index}: whether it took effect is unknown — check before running it again. The statements after it did not run.`);
    }
    else if(statement.kind === "DoStmt" || statement.kind === "CallStmt") {
        // Outside a transaction block a DO body or a procedure may COMMIT part of its work before failing
        lines.push(`Statement ${index} failed, but a DO block or procedure can COMMIT inside itself — what it committed before the error stays. Check before running it again. The statements after it did not run.`);
    }
    else if(buildsConcurrently == true) {
        lines.push(`Statement ${index} failed; a failed CONCURRENTLY build leaves an INVALID index behind — db_describe shows it; drop it before retrying. The statements after it did not run.`);
    }
    else {
        lines.push(`Statement ${index} did not take effect, and the statements after it did not run.`);
    }
    if(error.completed.length === 0) {
        lines.push(...formatFailedStatementNotices(error, maxCharacters - lines.join("\n").length));
        return lines.join("\n");
    }

    // Autocommit: what came before is committed, and the agent needs those results to avoid running it twice.
    // Their headings come first. The notices get everything the committed part leaves when it fits whole;
    // otherwise half of what is left after its headings — folded ones, when even unfolded headings do not fit.
    // The committed rows get the rest.
    let committedHeading = `Autocommit: statements 1–${error.statementIndex - 1} were committed before it failed. Their results:`;
    if(error.statementIndex === 2) {
        committedHeading = "Autocommit: statement 1 was committed before it failed. Its result:";
    }
    const committedWhole = committedHeading.length + 1 + formatStatementLines(error.completed).join("\n").length + 1;
    const left = maxCharacters - lines.join("\n").length;
    let noticeBudget = left - committedWhole;
    if(left < committedWhole) {
        let committedMinimum = committedHeading.length + 1 + minimumStatementLinesLength(error.completed);
        if(left < committedMinimum) {
            committedMinimum = committedHeading.length + 1 + formatStatementLines(error.completed, 0).join("\n").length;
        }
        noticeBudget = Math.floor((left - committedMinimum) / 2);
    }
    for(const line of formatFailedStatementNotices(error, noticeBudget)) {
        lines.push(line);
    }
    const rowBudget = maxCharacters - lines.join("\n").length - committedHeading.length - 2;
    lines.push(committedHeading);
    for(const line of formatStatementLines(error.completed, rowBudget)) {
        lines.push(line);
    }
    return lines.join("\n");
}

/**
 * The NOTICE / WARNING lines the failed statement sent before its error, within `maxCharacters` — a procedure
 * that commits in batches reports there what it committed, and RAISE NOTICE debugging is read on failures.
 */
function formatFailedStatementNotices(error: StatementError, maxCharacters: number): string[] {
    const notices = error.notices ?? [];
    const dropped = error.droppedNotices ?? 0;
    if(notices.length === 0) {
        return [];
    }
    const lines = [`Statement ${error.statementIndex} sent before it failed:`];
    const noticeLines = notices.map((notice) => `  ${capText(notice, MAX_NOTICE_CHARACTERS)}`);
    let droppedLine: string | null = null;
    if(dropped > 0) {
        droppedLine = `  … ${dropped} more notices not shown — a statement keeps its first ${notices.length}`;
    }
    // Whole when it fits whole
    let wholeLength = [...lines, ...noticeLines].reduce((total, line) => total + line.length + 1, 0);
    if(droppedLine != null) {
        wholeLength += droppedLine.length + 1;
    }
    if(wholeLength <= maxCharacters + 1) {
        lines.push(...noticeLines);
        if(droppedLine != null) {
            lines.push(droppedLine);
        }
        return lines;
    }
    // Kept for the closing "… not shown" line; with less room than that, one short line says what is missing —
    // always: these notices are the one record of what the failed statement did, so their count is never dropped
    let remaining = maxCharacters - lines[0].length - 1 - 100;
    if(remaining <= 0) {
        return [`(${notices.length + dropped} notices from statement ${error.statementIndex} not shown — the output limit is reached)`];
    }
    for(const [position, notice] of noticeLines.entries()) {
        if(notice.length + 1 > remaining) {
            lines.push(`  … ${notices.length - position + dropped} more notices not shown — the output limit (DB_MAX_OUTPUT) is reached`);
            return lines;
        }
        lines.push(notice);
        remaining -= notice.length + 1;
    }
    if(dropped > 0) {
        lines.push(`  … ${dropped} more notices not shown — a statement keeps its first ${notices.length}`);
    }
    return lines;
}

function formatCommitError(error: CommitError): string {
    const lines = [`COMMIT failed: ${capText(error.message, MAX_SERVER_TEXT_CHARACTERS)}`];
    lines.push(...describeServerError(error, "COMMIT failed").slice(1));
    if(error.connectionLost == true) {
        lines.push("The connection was lost during COMMIT: whether the transaction committed is unknown — check before running it again.");
        return lines.join("\n");
    }
    lines.push(`The server rolled the transaction back — none of the ${error.statementCount} statements of this call took effect.`);
    // Class 23 = integrity constraint violation; at COMMIT that means a deferred constraint
    const code = (error.cause as { code?: string }).code ?? "";
    if(code.startsWith("23") == true) {
        lines.push("A DEFERRABLE INITIALLY DEFERRED constraint is checked only at COMMIT — put SET CONSTRAINTS ALL IMMEDIATE first to see which statement breaks it.");
    }
    return lines.join("\n");
}

function toToolError(context: ToolContext, error: unknown, toolName: string): ToolResult {
    const _logger = $logger.child({ context: toolName });
    if(error instanceof GuardRejectionError) {
        _logger.warn("rejected by the guard", { kind: error.verdict.kind, reason: error.verdict.reason, statement_index: error.verdict.statementIndex });
        return errorResult(context, formatGuardRejection(error.verdict));
    }
    if(error instanceof StatementError) {
        return errorResult(context, formatStatementError(error, outputLimit(context)));
    }
    if(error instanceof CommitError) {
        return errorResult(context, formatCommitError(error));
    }
    if(error instanceof CallCancelledError) {
        _logger.info("call cancelled by the client", { reason: error.message });
        return errorResult(context, `Cancelled: ${error.message}.`);
    }
    _logger.error(error, `${toolName} failed`);
    return errorResult(context, `${toolName} failed: ${describeError(error)}`);
}

interface IdentifierPart {
    value: string;
    quoted: boolean;
}

/**
 * `app.users` / `"Sales"."Order.Line"` → its dot-separated parts, read as SQL reads them: a dot
 * inside double quotes is part of the name, and `""` inside quotes is one `"`.
 *
 * @throws {Error} On an unclosed quote or something other than a dot between parts.
 */
function splitIdentifierParts(text: string): IdentifierPart[] {
    const source = text.trim();
    const parts: IdentifierPart[] = [];
    let position = 0;
    while(position <= source.length) {
        if(source[position] === "\"") {
            let value = "";
            position += 1;
            while(true) {
                if(position >= source.length) {
                    throw new Error(`the name ${text} has an unclosed double quote`);
                }
                if(source[position] === "\"" && source[position + 1] === "\"") {
                    value += "\"";
                    position += 2;
                    continue;
                }
                if(source[position] === "\"") {
                    position += 1;
                    break;
                }
                value += source[position];
                position += 1;
            }
            parts.push({ value: value, quoted: true });
        }
        else {
            let end = source.indexOf(".", position);
            if(end === -1) {
                end = source.length;
            }
            parts.push({ value: source.slice(position, end).trim(), quoted: false });
            position = end;
        }

        while(source[position] === " ") {
            position += 1;
        }
        if(position >= source.length) {
            break;
        }
        if(source[position] !== ".") {
            throw new Error(`the name ${text} has something other than a dot after a quoted part`);
        }
        position += 1;
        while(source[position] === " ") {
            position += 1;
        }
    }
    return parts;
}

/** PostgreSQL folds only A–Z in an unquoted identifier; JS toLowerCase would also fold Ä or İ, which the server keeps. */
function foldIdentifier(value: string): string {
    return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * Spellings to try, in order. A quoted part: exactly that. An unquoted part: as SQL reads it (A–Z
 * folded) first, then as typed — unless the argument used double quotes anywhere, which says it is
 * written by SQL's rules, and then only the SQL reading.
 */
function spellingsOf(part: IdentifierPart, sqlOnly: boolean): string[] {
    if(part.quoted == true) {
        return [part.value];
    }
    const folded = foldIdentifier(part.value);
    if(sqlOnly == true || folded === part.value) {
        return [folded];
    }
    return [folded, part.value];
}

/**
 * The separate `schema` argument — always one name. Quoted, it is read as SQL reads it; unquoted,
 * the whole text is the name, dots included (db_schemas can list a schema called `a.b`).
 *
 * @throws {Error} For a quoted argument with more than one dotted part.
 */
function parseSchemaArgument(text: string): IdentifierPart {
    const trimmed = text.trim();
    if(trimmed.includes("\"") == false) {
        return { value: trimmed, quoted: false };
    }
    const parts = splitIdentifierParts(trimmed);
    if(parts.length !== 1) {
        throw new Error(`schema takes one name; ${text} has ${parts.length} dotted parts — a schema name that contains a dot goes in double quotes as a whole ("a.b")`);
    }
    return parts[0];
}

/** A part as it was written: quoted parts keep their quotes, so "Sales" and Sales read as the different names they are. */
function writtenPart(part: IdentifierPart): string {
    if(part.quoted == true) {
        return `"${part.value.replaceAll("\"", "\"\"")}"`;
    }
    return part.value;
}

/**
 * The relation db_describe should look up. `table` may carry its schema (`app.users`); a separate
 * `schema` then has to agree. With `schema` given and an unquoted dotted `table` that does not start
 * with it, the whole `table` is one name — a table really named `a.b`. Each argument's quotes decide
 * only how that argument is read: `"Orders"` with schema `Sales` still tries sales, then Sales. When
 * both name the schema, only spellings both allow are tried. No schema at all: null — the session's
 * search_path, as SQL resolves an unqualified name.
 */
function resolveRelationName(table: string, schema: string | undefined): {
    schemaCandidates: string[] | null;
    nameCandidates: string[];
    /** An unquoted `table` whose dot was read as schema.name — quoting it whole would read it as one name. */
    splitAtDot: boolean;
    /** The name part was unquoted and all lower case: only that spelling was tried, so its quoted mixed case was not. */
    lowerCaseOnly: boolean;
} {
    const tableSqlOnly = table.includes("\"") == true;
    const parts = splitIdentifierParts(table);
    let schemaCandidates: string[] | null = null;
    let namePart: IdentifierPart;

    const givenSchema = schema?.trim() ?? "";
    if(givenSchema !== "") {
        const schemaPart = parseSchemaArgument(givenSchema);
        schemaCandidates = spellingsOf(schemaPart, givenSchema.includes("\"") == true);
        let tableSchemaSpellings: string[] = [];
        if(parts.length === 2) {
            tableSchemaSpellings = spellingsOf(parts[0], tableSqlOnly);
        }
        // "R4K".t with schema R4K: the quoted part allows only R4K, so r4k is not tried first
        const sharedSpellings = schemaCandidates.filter((spelling) => tableSchemaSpellings.includes(spelling));
        if(sharedSpellings.length > 0) {
            schemaCandidates = sharedSpellings;
            namePart = parts[1];
        }
        else if(parts.length === 1) {
            namePart = parts[0];
        }
        else if(tableSqlOnly == false) {
            namePart = { value: table.trim(), quoted: false };
        }
        else {
            throw new Error(`table ${table} names schema ${writtenPart(parts[0])}, but schema is ${writtenPart(schemaPart)} — give one or the other`);
        }
    }
    else if(parts.length === 1) {
        namePart = parts[0];
    }
    else if(parts.length === 2) {
        schemaCandidates = spellingsOf(parts[0], tableSqlOnly);
        namePart = parts[1];
    }
    else {
        throw new Error(`"${table}" has ${parts.length} dotted parts — give schema.name, or quote a name that contains a dot`);
    }

    const nameCandidates = spellingsOf(namePart, tableSqlOnly);
    return {
        schemaCandidates: schemaCandidates,
        nameCandidates: nameCandidates,
        splitAtDot: tableSqlOnly == false && parts.length === 2 && namePart === parts[1],
        lowerCaseOnly: namePart.quoted == false && nameCandidates.length === 1,
    };
}

/** A stored name as SQL would have to write it — quoted unless it is plain lower case (keywords aside). */
function sqlSpelling(name: string): string {
    if(/^[a-z_][a-z0-9_$]*$/.test(name) == true) {
        return name;
    }
    return `"${name.replaceAll("\"", "\"\"")}"`;
}

export function registerAllTools(server: McpServer, context: ToolContext): void {
    const readonlyProfile = context.profile?.policy.readonly == true;

    server.registerTool(
        "db_list_hosts",
        {
            title: "Show the registered database",
            description: "Show the database this server fronts — driver, host, database, user, whether it goes through an SSH tunnel — and its guard policy. Credentials are never shown. Call it first: it is the only reachable database, and its policy decides what db_query accepts.",
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => {
            let summary: DbSummary | null = null;
            if(context.profile != null) {
                summary = toDbSummary(context.profile);
            }
            return textResult(context, formatDbSummary(summary));
        }
    );

    server.registerTool(
        "db_query",
        {
            title: "Run SQL",
            description: [
                "Run one or more SQL statements and return each one's rows (one JSON object per line) or affected-row count.",
                "By default all statements of the call run in one transaction: committed together, or rolled back together when any fails — the error says which one.",
                "Pass transaction: false for autocommit (each statement commits on its own) — needed for CREATE INDEX CONCURRENTLY, VACUUM and anything else that refuses to run inside a transaction. Don't send BEGIN / COMMIT yourself.",
                "Each statement returns at most the profile's row limit; when more exist the output says so — narrow with WHERE / LIMIT rather than paging through a table. A SELECT stops reading one row past the limit (read to tell there are more), but a function in its select list may have run for more rows than are shown — up to every row read, when its value feeds a sort, DISTINCT, GROUP BY, an aggregate or a set operation, or comes from a WITH or subquery that is sorted, grouped or joined. Put side effects in a write with RETURNING, not in a SELECT. A write with RETURNING, a SELECT whose WITH writes, EXECUTE and SHOW run in full; only their listing is cut. A long EXPLAIN plan is cut the same way — without ANALYZE the explained statement does not run.",
                "Refused on every database: TRUNCATE, UPDATE / DELETE without WHERE (inside WITH too), DROP DATABASE / SCHEMA / TABLESPACE, DROP OWNED, ALTER SYSTEM, COPY … PROGRAM. COPY … FROM STDIN / TO STDOUT is not supported. A read-only database also refuses any write, functions whose effect outlives a rollback (pg_terminate_backend, replication slots, …), and set_config of statement_timeout.",
            ].join(" "),
            inputSchema: {
                sql: z.string().min(1).describe("PostgreSQL. Several statements may be separated by ';'."),
                params: z.array(PARAM_VALUE_SCHEMA).optional().describe("Values for $1, $2, … placeholders. Only with a single statement. Pass bigint ids and exact decimals as strings."),
                transaction: z.boolean().optional().describe("Default true — one transaction for the whole call. false — autocommit, statement by statement."),
            },
            annotations: { readOnlyHint: readonlyProfile, destructiveHint: readonlyProfile == false, openWorldHint: false },
        },
        async (args, extra) => {
            try {
                const driver = requireDriver(context);
                let transaction: "commit" | "autocommit" = "commit";
                if(args.transaction == false) {
                    transaction = "autocommit";
                }
                const result = await driver.execute(args.sql, { params: args.params, transaction: transaction, signal: extra.signal });
                return textResult(context, formatExecuteResult(result, outputLimit(context)));
            }
            catch(ex) {
                return toToolError(context, ex, "db_query");
            }
        }
    );

    server.registerTool(
        "db_schemas",
        {
            title: "List schemas",
            description: "List the database's own schemas (system schemas left out) with owner and how many tables, views and sequences each holds.",
            inputSchema: {},
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (_args, extra) => {
            try {
                const driver = requireDriver(context);
                const rows = await listSchemas(driver, extra.signal);
                return textResult(context, formatSchemas(rows));
            }
            catch(ex) {
                return toToolError(context, ex, "db_schemas");
            }
        }
    );

    server.registerTool(
        "db_tables",
        {
            title: "List tables in a schema",
            description: "List the tables, views, materialized views, foreign tables and sequences of one schema — kind, approximate row count, size, comment — plus its enum, domain and composite types with their values.",
            inputSchema: {
                schema: z.string().optional().describe("Schema name. Default 'public'."),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, extra) => {
            try {
                const driver = requireDriver(context);
                let spellings = ["public"];
                if(args.schema != null && args.schema.trim() !== "") {
                    const schemaPart = parseSchemaArgument(args.schema);
                    spellings = spellingsOf(schemaPart, args.schema.includes("\"") == true);
                }
                // As SQL reads it first, then as typed — the first that exists is listed, the other named
                const schemas = await findSchemas(driver, spellings, extra.signal);
                if(schemas.length === 0) {
                    // Both spellings of an unquoted mixed-case name were tried — quoting it would try one of them again
                    let advice = " db_schemas lists them; a mixed-case name goes in double quotes, as in SQL: \"Sales\".";
                    if(spellings.length > 1) {
                        advice = " db_schemas lists them.";
                    }
                    return textResult(context, `No schema named ${spellings.map(sqlSpelling).join(" or ")}.${advice}`);
                }
                const listing = await listRelations(driver, schemas[0].name, extra.signal);
                return textResult(context, formatRelations(schemas[0].shown, listing.relations, listing.types, schemas.slice(1).map((schema) => schema.shown)));
            }
            catch(ex) {
                return toToolError(context, ex, "db_tables");
            }
        }
    );

    server.registerTool(
        "db_describe",
        {
            title: "Describe a table",
            description: "Describe one table, view or sequence: columns (type, not null, default, identity, enum values, comment), constraints, foreign keys pointing at it from other tables, indexes with sizes, triggers, and a view's definition.",
            inputSchema: {
                table: z.string().min(1).describe("Name of the table, view or sequence. 'schema.name' also works."),
                schema: z.string().optional().describe("Schema, when not given in 'table'. Without one the name is looked up on the search_path, as SQL does."),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, extra) => {
            try {
                const driver = requireDriver(context);
                const target = resolveRelationName(args.table, args.schema);
                const description = await describeRelation(driver, target.schemaCandidates, target.nameCandidates, extra.signal);
                if(description == null) {
                    // Every spelling that was tried, and where — so the agent neither repeats one nor wonders which schemas were looked at
                    const names = target.nameCandidates.map(sqlSpelling).join(" or ");
                    let message: string;
                    if(target.schemaCandidates == null) {
                        const searchPath = await readSearchPath(driver, extra.signal);
                        message = `No table, view or sequence named ${names} on the search_path (${searchPath || "empty"}). For one in another schema, give the schema: schema.name — db_tables lists a schema's tables.`;
                    }
                    else {
                        message = `No table, view or sequence named ${names} in schema ${target.schemaCandidates.map(sqlSpelling).join(" or ")}. db_tables lists what the schema has.`;
                    }
                    // Quoting advice only where it could change the reading — a split at the dot, an unquoted lower-case name
                    if(target.splitAtDot == true) {
                        message += ` A name that contains a dot goes in double quotes as a whole, as in SQL: "${args.table.trim()}".`;
                    }
                    else if(target.lowerCaseOnly == true) {
                        message += " A mixed-case name goes in double quotes, as in SQL: \"Orders\".";
                    }
                    return textResult(context, message);
                }
                return textResult(context, formatRelationDescription(description));
            }
            catch(ex) {
                return toToolError(context, ex, "db_describe");
            }
        }
    );

    server.registerTool(
        "db_explain",
        {
            title: "Show a query plan",
            description: [
                "Show PostgreSQL's plan for one statement — send the statement itself, without EXPLAIN.",
                "analyze: true actually runs it to report real row counts and timings — inside a transaction that is always rolled back, so a write's rows are undone; what acts outside the transaction is not (sequence values, setval, pg_terminate_backend), and the locks it takes are held while it runs.",
                "The same guard as db_query applies to the statement.",
            ].join(" "),
            inputSchema: {
                sql: z.string().min(1).describe("A single statement: SELECT, INSERT, UPDATE, DELETE, MERGE, VALUES, DECLARE … CURSOR or CREATE TABLE … AS."),
                params: z.array(PARAM_VALUE_SCHEMA).optional().describe("Values for $1, $2, …"),
                analyze: z.boolean().optional().describe("Run it and report actual rows, time and buffers. Default false."),
            },
            // analyze: true executes the statement — on a read-write profile that includes writes
            annotations: { readOnlyHint: readonlyProfile, openWorldHint: false },
        },
        async (args, extra) => {
            try {
                const driver = requireDriver(context);
                const statements = await parseStatements(args.sql);
                if(statements.length > 1) {
                    return errorResult(context, `db_explain takes a single statement; this has ${statements.length}.`);
                }
                const statement = statements[0];
                if(statement.kind === "ExplainStmt") {
                    return errorResult(context, "Not supported by this tool: db_explain adds EXPLAIN itself — send the statement without it, and pass analyze: true for EXPLAIN ANALYZE.");
                }
                // EXPLAIN EXECUTE works, but not across calls: the closing DISCARD ALL drops every prepared statement.
                // The advice works on a read-only database too, which refuses PREPARE.
                if(statement.kind === "ExecuteStmt") {
                    return errorResult(context, "Not supported by this tool: a prepared statement does not outlive the db_query call that PREPAREd it — send the prepared statement's own SQL to db_explain instead, with its $1, $2, … values in params and the types PREPARE declared written as casts ($1::numeric) — they decide the plan.");
                }
                if(EXPLAINABLE_KINDS.has(statement.kind) == false) {
                    return errorResult(context, `Not supported by this tool: ${statement.kind.replace(/Stmt$/, "")} cannot be EXPLAINed — db_explain takes SELECT, INSERT, UPDATE, DELETE, MERGE, VALUES, DECLARE … CURSOR or CREATE TABLE … AS.`);
                }

                const analyze = args.analyze == true;
                // Screened as the agent wrote it, so deny patterns and refusal messages see that text, not the EXPLAIN wrapper
                // (the driver is told so through internalSql). Read-only rules and the DDL switch apply only when it will run:
                // a plan alone writes and creates nothing.
                const policy = driver.profile.policy;
                const statementPolicy = { ...policy, allowDdl: policy.allowDdl == true || analyze == false };
                const verdict = checkStatements(statements, statementPolicy, analyze == true && policy.readonly == true);
                if(verdict.allowed == false) {
                    throw new GuardRejectionError(verdict);
                }

                const explainPrefix = `EXPLAIN (ANALYZE ${analyze}, BUFFERS ${analyze}, FORMAT TEXT) `;
                let result: ExecuteResult;
                try {
                    result = await driver.execute(`${explainPrefix}${statement.text}`, {
                        params: args.params,
                        transaction: "rollback",
                        readOnly: analyze == false,
                        maxRows: CATALOG_MAX_ROWS,
                        signal: extra.signal,
                        internalSql: true,
                    });
                }
                catch(ex) {
                    // The server points into the SQL it received; make the position count from the agent's statement
                    if(ex instanceof StatementError) {
                        const cause = ex.cause as { position?: string };
                        if(cause.position != null) {
                            const position = Number(cause.position) - explainPrefix.length;
                            cause.position = undefined;
                            if(position >= 1) {
                                cause.position = String(position);
                            }
                        }
                    }
                    throw ex;
                }

                const plan = result.statements[0];
                const planLines = plan.rows.map((row) => String(Object.values(row)[0]));
                let heading = "plan (not executed)";
                if(analyze == true) {
                    heading = "plan (executed, then rolled back)";
                }
                if(plan.truncated == true) {
                    planLines.push(`… plan cut at ${CATALOG_MAX_ROWS} lines`);
                }
                return textResult(context, [heading, ...planLines].join("\n"));
            }
            catch(ex) {
                return toToolError(context, ex, "db_explain");
            }
        }
    );
}
