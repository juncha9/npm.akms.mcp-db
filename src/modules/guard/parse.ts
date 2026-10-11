import { parse } from "libpg-query";
import type { ParsedStatement } from "@/_types";
import { describeError } from "@/_libs/text";
import { GuardRejectionError } from "./guard-error";

// The real PostgreSQL grammar (libpg_query, compiled to WASM) — the same parser postgres-mcp
// uses through pglast. A statement it cannot parse is refused: an unknown shape can't be screened.

interface RawStatement {
    stmt: Record<string, Record<string, unknown>>;
    stmt_location?: number;
    stmt_len?: number;
}

/**
 * Splits `sql` into statements with their own source text.
 *
 * @throws {GuardRejectionError} When the text is empty, only comments, or does not parse.
 */
export async function parseStatements(sql: string): Promise<ParsedStatement[]> {
    if(sql.trim() === "") {
        throw new GuardRejectionError({ allowed: false, kind: "syntax", reason: "no SQL statement was given" });
    }

    let rawStatements: RawStatement[];
    try {
        const parsed = await parse(sql);
        rawStatements = (parsed.stmts ?? []) as unknown as RawStatement[];
    }
    catch(ex) {
        let position = "";
        const details = (ex as { sqlDetails?: { cursorPosition?: number } }).sqlDetails;
        if(details?.cursorPosition != null) {
            position = ` (near character ${details.cursorPosition + 1})`;
        }
        throw new GuardRejectionError({
            allowed: false,
            kind: "syntax",
            reason: `${describeError(ex)}${position}`,
        });
    }

    if(rawStatements.length === 0) {
        throw new GuardRejectionError({ allowed: false, kind: "syntax", reason: "no SQL statement was given (only comments or semicolons)" });
    }

    // Offsets are UTF-8 byte positions, not string indexes — a Korean comment before a
    // statement shifts them apart. The last statement carries no length: it runs to the end.
    const bytes = Buffer.from(sql, "utf8");
    const statements: ParsedStatement[] = [];
    for(const [position, raw] of rawStatements.entries()) {
        const start = raw.stmt_location ?? 0;
        let end = bytes.length;
        if(raw.stmt_len != null && raw.stmt_len > 0) {
            end = start + raw.stmt_len;
        }
        // PostgreSQL's whitespace only: JS trim() would also eat U+3000 / U+00A0 / U+FEFF, which the server reads as identifier characters
        const text = bytes.subarray(start, end).toString("utf8").replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
        const [kind, node] = Object.entries(raw.stmt)[0];
        statements.push({ index: position + 1, kind: kind, text: text, node: node });
    }
    return statements;
}
