import type { DbSummary, ExecuteResult, StatementResult } from "@/_types";
import type { CatalogRows, RelationDescription } from "@/modules/postgres/catalog";

// Text for the model. Rows are one JSON object per line: compact, unambiguous about types
// (strings quoted, null as null), and easy to read back without a table renderer.

export const ALWAYS_REFUSED_SUMMARY =
    "TRUNCATE, UPDATE / DELETE without WHERE (inside WITH too), DROP DATABASE / SCHEMA / TABLESPACE, DROP OWNED, ALTER SYSTEM, COPY … PROGRAM";

/** Pads every column but the last to a common width. */
function alignColumns(rows: string[][]): string[] {
    const widths: number[] = [];
    for(const row of rows) {
        for(const [position, cell] of row.entries()) {
            if(position === row.length - 1) {
                continue;
            }
            widths[position] = Math.max(widths[position] ?? 0, cell.length);
        }
    }
    return rows.map((row) => row.map((cell, position) => {
        if(position === row.length - 1) {
            return cell;
        }
        return cell.padEnd(widths[position]);
    }).join("  ").trimEnd());
}

function textOf(value: unknown): string {
    if(value == null) {
        return "";
    }
    return String(value);
}

/** Statement kinds whose name is not the SQL keyword once `Stmt` is cut off — used when the server sent no command tag. */
const KIND_LABELS: Record<string, string> = {
    VariableShowStmt: "SHOW",
    ExplainStmt: "EXPLAIN",
    FetchStmt: "FETCH",
    CallStmt: "CALL",
};

/** "1 row" / "3 rows" */
function countRows(count: number): string {
    if(count === 1) {
        return "1 row";
    }
    return `${count} rows`;
}

/**
 * Statements PostgreSQL runs in full on the first fetch (a "utility" portal stores the whole result):
 * a row limit cuts only what is shown, never what ran. EXPLAIN is one too, worded on its own.
 */
const RUN_IN_FULL_KINDS = new Set(["ExecuteStmt", "VariableShowStmt", "CallStmt"]);

function describeStatementCount(statement: StatementResult): string {
    const command = statement.command ?? "";
    const writes = /^(INSERT|UPDATE|DELETE|MERGE|COPY)/.test(command);
    const shown = statement.rows.length;
    if(statement.fields.length > 0) {
        if(statement.truncated == false) {
            return countRows(shown);
        }
        // Drained: a write's RETURNING output — every row was written, only the listing is cut
        if(statement.rowCount != null && writes == true) {
            return `${countRows(statement.rowCount)} affected · first ${shown} of the RETURNING rows read`;
        }
        if(statement.kind === "FetchStmt") {
            return `first ${countRows(shown)} — the cursor has already moved past the rest`;
        }
        // Says nothing about running: without ANALYZE the explained statement did not run
        if(statement.kind === "ExplainStmt") {
            return `first ${countRows(shown)} of the plan — the row limit cut the rest`;
        }
        if(RUN_IN_FULL_KINDS.has(statement.kind) == true) {
            return `first ${countRows(shown)} — the statement ran in full; only these were read`;
        }
        // PostgreSQL computes a SELECT with writes in its WITH to the end on the first fetch, outer rows included
        if(statement.writes == true) {
            return `first ${countRows(shown)} — the statement ran in full (a WITH that writes computes every row); only these were read`;
        }
        // The cursor reads one row past the limit to learn that there are more. Says nothing about what was not computed:
        // a select-list function whose value feeds a sort, an aggregate or a sorted WITH may have run for every row read.
        return `first ${countRows(shown)} — reading stopped one row past these (to tell there are more); narrow it with WHERE / LIMIT`;
    }
    if(statement.truncated == true) {
        if(statement.writes == true) {
            return `more than ${countRows(shown)} (no columns) — the statement ran in full; counting stopped at the row limit`;
        }
        return `more than ${countRows(shown)} (no columns) — stopped at the row limit`;
    }
    if(statement.rowCount == null) {
        return "";
    }
    if(writes == true) {
        return `${countRows(statement.rowCount)} affected`;
    }
    // CREATE TABLE … AS / SELECT … INTO tag their row count as SELECT n; a zero-column SELECT does too
    if(command === "SELECT") {
        if(statement.ddl == true) {
            return `${countRows(statement.rowCount)} written`;
        }
        return `${countRows(statement.rowCount)} (no columns)`;
    }
    if(command === "MOVE") {
        return `cursor moved ${countRows(statement.rowCount)}`;
    }
    return "";
}

/** `maxCharacters` bounds the whole text — formatStatementLines decides what gives way first. */
export function formatExecuteResult(result: ExecuteResult, maxCharacters: number = Number.POSITIVE_INFINITY): string {
    let ending = "committed";
    if(result.transaction === "autocommit") {
        ending = "autocommit — each statement committed on its own";
    }
    else if(result.transaction === "rollback") {
        ending = "rolled back — nothing persisted";
        if(result.readOnly == true) {
            ending = "read-only, rolled back";
        }
    }

    let statementWord = "statements";
    if(result.statements.length === 1) {
        statementWord = "statement";
    }
    const topLine = `${result.statements.length} ${statementWord} · ${result.durationMs} ms · ${ending}`;
    // No spread: a result of a hundred thousand rows would overflow the call stack
    const lines = [topLine].concat(formatStatementLines(result.statements, maxCharacters - topLine.length - 1));
    return lines.join("\n");
}

/** One notice line at most this long — a RAISE NOTICE of a whole table must not crowd out the headings. */
export const MAX_NOTICE_CHARACTERS = 500;

/** `text` cut to `maxCharacters` with a note of how much was dropped — unless the note would be longer than what it drops. */
export function capText(text: string, maxCharacters: number): string {
    if(text.length <= maxCharacters) {
        return text;
    }
    const note = `… (${text.length - maxCharacters} more characters)`;
    if(text.length <= maxCharacters + note.length) {
        return text;
    }
    return `${text.slice(0, maxCharacters)}${note}`;
}

/** What a folded heading says about each statement in it. */
interface StatementSketch {
    label: string;
    /** What the heading says about rows ("3 rows affected", "first 500 rows — …"), or "". */
    count: string;
    ddl: boolean;
    /** "(no rows) columns: …" under the heading of a result with columns and no rows. */
    noRowsLine: string | null;
    durationMs: number;
    /** It had notices or rows to show. */
    hasContent: boolean;
}

/**
 * One statement's lines — or, once statements are folded together, a run of them. `fixedLines` are
 * always shown; the notices (with `droppedLine`) and rows are shown whole or cut.
 */
interface StatementBlock {
    firstIndex: number;
    lastIndex: number;
    members: StatementSketch[];
    fixedLines: string[];
    noticeLines: string[];
    droppedNotices: number;
    droppedLine: string | null;
    rowLines: string[];
    /** A write whose RETURNING rows these are — cutting the listing changes nothing about the write. */
    isWrite: boolean;
    /** Characters of the notices, the dropped-notices line and the rows, a newline each. */
    contentLength: number;
}

/** How many of a cut block's notice lines and rows are shown. */
interface ShownCounts {
    notices: number;
    rows: number;
}

/** Characters `lines` take in the output, counting a newline after each. */
function linesLength(lines: string[]): number {
    let total = 0;
    for(const line of lines) {
        total += line.length + 1;
    }
    return total;
}

/** Appends without spreading — a spread of a hundred thousand rows overflows the call stack. */
function appendAll<T>(target: T[], source: T[]): void {
    for(const item of source) {
        target.push(item);
    }
}

/** "notice" / "notices" */
function noticeWord(count: number): string {
    if(count === 1) {
        return "notice";
    }
    return "notices";
}

function toStatementBlock(statement: StatementResult): StatementBlock {
    const label = statement.command ?? KIND_LABELS[statement.kind] ?? statement.kind.replace(/Stmt$/, "").toUpperCase();
    const count = describeStatementCount(statement);
    const parts = [`[${statement.index}] ${label}`];
    if(count !== "") {
        parts.push(count);
    }
    if(statement.ddl == true) {
        parts.push("DDL");
    }
    parts.push(`${statement.durationMs} ms`);
    const fixedLines = [parts.join(" · ")];

    const noticeLines = (statement.notices ?? []).map((notice) => `  ${capText(notice, MAX_NOTICE_CHARACTERS)}`);
    const droppedNotices = statement.droppedNotices ?? 0;
    // The driver keeps a statement's first notices only; this line says so whatever the output limit
    let droppedLine: string | null = null;
    if(droppedNotices > 0) {
        droppedLine = `  … ${droppedNotices} more notices not shown — a statement keeps its first ${noticeLines.length}`;
    }

    let noRowsLine: string | null = null;
    let rowLines: string[] = [];
    if(statement.fields.length > 0 && statement.rows.length === 0) {
        noRowsLine = `(no rows) columns: ${statement.fields.map((field) => field.name).join(", ")}`;
        fixedLines.push(noRowsLine);
    }
    // A zero-column SELECT would print one "{}" per row; the heading's count already says it
    else if(statement.fields.length > 0) {
        rowLines = statement.rows.map((row) => JSON.stringify(row));
    }
    let contentLength = linesLength(noticeLines) + linesLength(rowLines);
    if(droppedLine != null) {
        contentLength += droppedLine.length + 1;
    }
    const sketch: StatementSketch = {
        label: label,
        count: count,
        ddl: statement.ddl == true,
        noRowsLine: noRowsLine,
        durationMs: statement.durationMs,
        hasContent: contentLength > 0,
    };
    return {
        firstIndex: statement.index,
        lastIndex: statement.index,
        members: [sketch],
        fixedLines: fixedLines,
        noticeLines: noticeLines,
        droppedNotices: droppedNotices,
        droppedLine: droppedLine,
        rowLines: rowLines,
        isWrite: /^(INSERT|UPDATE|DELETE|MERGE)/.test(statement.command ?? ""),
        contentLength: contentLength,
    };
}

/** The notices, the dropped-notices line and the rows — what a block shows when nothing of it is cut. */
function appendWholeContent(target: string[], block: StatementBlock): void {
    appendAll(target, block.noticeLines);
    if(block.droppedLine != null) {
        target.push(block.droppedLine);
    }
    appendAll(target, block.rowLines);
}

/**
 * The lines saying what a cut block leaves out: one under its notices, one under its rows. They count what
 * is missing, so they only shorten as more is shown — their length with nothing shown bounds them, and what
 * they free as lines are added can be spent on more lines.
 */
function cutLines(block: StatementBlock, shown: ShownCounts): { notices: string[]; rows: string[] } {
    const noticeLines: string[] = [];
    const noticesMissing = block.noticeLines.length - shown.notices;
    if(noticesMissing > 0) {
        let line = `  … ${noticesMissing} more ${noticeWord(noticesMissing)} not shown — the output limit (DB_MAX_OUTPUT) is reached`;
        // Those the driver did not keep are missing for another reason
        if(block.droppedNotices > 0) {
            line = `${line}; the statement sent ${block.droppedNotices} more than were kept`;
        }
        noticeLines.push(line);
    }
    // Shorter than the line above, which it replaces once every kept notice is shown
    else if(block.droppedLine != null) {
        noticeLines.push(block.droppedLine);
    }
    const rowLines: string[] = [];
    const rowsMissing = block.rowLines.length - shown.rows;
    if(rowsMissing > 0) {
        let advice = "select fewer columns or rows";
        if(block.isWrite == true) {
            advice = "the write itself is complete";
        }
        rowLines.push(`… ${rowsMissing} of ${countRows(block.rowLines.length)} not shown — the output limit (DB_MAX_OUTPUT) is reached; ${advice}`);
    }
    return { notices: noticeLines, rows: rowLines };
}

function cutLinesLength(block: StatementBlock, shown: ShownCounts): number {
    const lines = cutLines(block, shown);
    return linesLength(lines.notices) + linesLength(lines.rows);
}

function summaryLine(hiddenStatements: number): string {
    return `… the notices and rows of ${hiddenStatements} of these statements are not shown — the output limit (DB_MAX_OUTPUT) is reached`;
}

const NOTHING_SHOWN: ShownCounts = { notices: 0, rows: 0 };

/** What the summarized layout needs at the very least: every fixed line, plus the summary line when anything has content. */
function fixedAndSummaryLength(blocks: StatementBlock[]): number {
    let withContent = 0;
    let length = 0;
    for(const block of blocks) {
        length += linesLength(block.fixedLines);
        if(block.contentLength > 0) {
            withContent += 1;
        }
    }
    if(withContent > 0) {
        length += summaryLine(withContent).length + 1;
    }
    return length;
}

/**
 * `blocks` as lines within `maxCharacters`, or null when their fixed lines do not fit beside one summary line.
 * Lengths count a newline per line, so a layout fits when it is at most `maxCharacters + 1` long.
 *
 * Flow:
 *  1) Itemized: in size order, keep results whole until the next one would leave too little room for every
 *     other to be shown at its cheapest (whole, or its cut lines alone); the cut ones then share what is left,
 *     smallest first, notices before rows
 *  2) Summarized, when those cut lines alone would not fit: in size order, results whole while they fit; the
 *     rest left out and counted in one line
 * Either way the output keeps statement order; only the choice of what is shown goes by size, so a small
 * result is never cut for a larger one.
 */
function layOutBlocks(blocks: StatementBlock[], maxCharacters: number): string[] | null {
    const room = maxCharacters + 1;
    if(fixedAndSummaryLength(blocks) > room) {
        return null;
    }
    let budget = room;
    for(const block of blocks) {
        budget -= linesLength(block.fixedLines);
    }
    const withContent = blocks.filter((block) => block.contentLength > 0);
    if(withContent.length === 0) {
        const lines: string[] = [];
        for(const block of blocks) {
            appendAll(lines, block.fixedLines);
        }
        return lines;
    }
    // Smallest first: a count after a wide listing stays whole, and the largest results are the ones cut
    const bySize = [...withContent].sort((left, right) => left.contentLength - right.contentLength || left.firstIndex - right.firstIndex);
    // What a result costs at the least: whole when that is shorter than its cut lines, else its cut lines
    const leastCost = new Map<StatementBlock, number>();
    for(const block of withContent) {
        leastCost.set(block, Math.min(block.contentLength, cutLinesLength(block, NOTHING_SHOWN)));
    }

    // (1) Itemized
    const whole = new Set<StatementBlock>();
    let used = 0;
    let othersCost = 0;
    for(const block of withContent) {
        othersCost += leastCost.get(block) ?? 0;
    }
    for(const block of bySize) {
        const otherCuts = othersCost - (leastCost.get(block) ?? 0);
        if(used + block.contentLength + otherCuts > budget) {
            break;
        }
        whole.add(block);
        used += block.contentLength;
        othersCost = otherCuts;
    }
    let cutCost = 0;
    for(const block of bySize) {
        if(whole.has(block) == false) {
            cutCost += cutLinesLength(block, NOTHING_SHOWN);
        }
    }
    if(used + cutCost <= budget) {
        // Map order is size order: the smaller cut results fill first
        const shown = new Map<StatementBlock, ShownCounts>();
        for(const block of bySize) {
            if(whole.has(block) == false) {
                shown.set(block, { notices: 0, rows: 0 });
            }
        }
        let spare = budget - used - cutCost;
        let added = true;
        while(added == true) {
            added = false;
            for(const [block, counts] of shown) {
                while(counts.notices < block.noticeLines.length && block.noticeLines[counts.notices].length + 1 <= spare) {
                    spare -= block.noticeLines[counts.notices].length + 1;
                    counts.notices += 1;
                    added = true;
                }
                while(counts.rows < block.rowLines.length && block.rowLines[counts.rows].length + 1 <= spare) {
                    spare -= block.rowLines[counts.rows].length + 1;
                    counts.rows += 1;
                    added = true;
                }
            }
            // Fewer missing, shorter cut lines: what they no longer need goes to the next pass
            let nowCutCost = 0;
            for(const [block, counts] of shown) {
                nowCutCost += cutLinesLength(block, counts);
            }
            spare += cutCost - nowCutCost;
            cutCost = nowCutCost;
        }

        const lines: string[] = [];
        for(const block of blocks) {
            appendAll(lines, block.fixedLines);
            const counts = shown.get(block);
            if(counts == null) {
                appendWholeContent(lines, block);
                continue;
            }
            const cut = cutLines(block, counts);
            for(let position = 0; position < counts.notices; position++) {
                lines.push(block.noticeLines[position]);
            }
            appendAll(lines, cut.notices);
            for(let position = 0; position < counts.rows; position++) {
                lines.push(block.rowLines[position]);
            }
            appendAll(lines, cut.rows);
        }
        return lines;
    }

    // (2) Summarized
    let left = budget - (summaryLine(withContent.length).length + 1);
    const kept = new Set<StatementBlock>();
    for(const block of bySize) {
        if(block.contentLength > left) {
            break;
        }
        kept.add(block);
        left -= block.contentLength;
    }
    const lines: string[] = [];
    for(const block of blocks) {
        appendAll(lines, block.fixedLines);
        if(kept.has(block) == true) {
            appendWholeContent(lines, block);
        }
    }
    if(kept.size < withContent.length) {
        lines.push(summaryLine(withContent.length - kept.size));
    }
    return lines;
}

/** Statements that one line can describe together: same kind, same count, same DDL flag, same columns. */
function sketchKey(sketch: StatementSketch): string {
    return [sketch.label, sketch.count, String(sketch.ddl), sketch.noRowsLine ?? ""].join("\u0000");
}

/**
 * One block for a run of statements, their notices and rows no longer shown:
 * `[3–200] CREATE · 198 statements · DDL · 1–3 ms each` when they are alike,
 * `[3–40] 38 statements: 30 SELECT, 8 CREATE · 8 DDL · 1–9 ms each` when they are not.
 */
function foldRun(run: StatementBlock[]): StatementBlock {
    const first = run[0];
    const last = run[run.length - 1];
    const members: StatementSketch[] = [];
    for(const block of run) {
        appendAll(members, block.members);
    }
    let minMs = members[0].durationMs;
    let maxMs = members[0].durationMs;
    let hidden = 0;
    let ddlCount = 0;
    const kinds = new Map<string, number>();
    const firstKey = sketchKey(members[0]);
    let alike = true;
    for(const member of members) {
        minMs = Math.min(minMs, member.durationMs);
        maxMs = Math.max(maxMs, member.durationMs);
        if(member.hasContent == true) {
            hidden += 1;
        }
        if(member.ddl == true) {
            ddlCount += 1;
        }
        kinds.set(member.label, (kinds.get(member.label) ?? 0) + 1);
        if(sketchKey(member) !== firstKey) {
            alike = false;
        }
    }
    let duration = `${minMs}–${maxMs} ms each`;
    if(minMs === maxMs) {
        duration = `${minMs} ms each`;
    }
    const range = `[${first.firstIndex}–${last.lastIndex}]`;

    const parts: string[] = [];
    if(alike == true) {
        parts.push(`${range} ${members[0].label}`);
        let countPart = `${members.length} statements`;
        if(members[0].count !== "") {
            countPart = `${countPart}, each ${members[0].count}`;
        }
        parts.push(countPart);
        if(members[0].ddl == true) {
            parts.push("DDL");
        }
    }
    else {
        // How many of each kind, in the order they first ran
        parts.push(`${range} ${members.length} statements: ${[...kinds].map(([label, count]) => `${count} ${label}`).join(", ")}`);
        if(ddlCount > 0) {
            parts.push(`${ddlCount} DDL`);
        }
    }
    parts.push(duration);
    let heading = parts.join(" · ");
    if(hidden > 0) {
        heading = `${heading} — the notices and rows of ${hidden} of them are not shown (output limit)`;
    }
    const fixedLines = [heading];
    if(alike == true && members[0].noRowsLine != null) {
        fixedLines.push(members[0].noRowsLine);
    }
    return {
        firstIndex: first.firstIndex,
        lastIndex: last.lastIndex,
        members: members,
        fixedLines: fixedLines,
        noticeLines: [],
        droppedNotices: 0,
        droppedLine: null,
        rowLines: [],
        isWrite: false,
        contentLength: 0,
    };
}

/** A run of two or more neighbouring single statements that one line can describe, and what folding it saves. */
interface FoldableRun {
    start: number;
    end: number;
    saving: number;
    hidesContent: boolean;
}

function foldableRuns(blocks: StatementBlock[]): FoldableRun[] {
    // A folded block never folds again here; null keys never match
    const keyOf = (block: StatementBlock) => {
        if(block.members.length !== 1) {
            return null;
        }
        return sketchKey(block.members[0]);
    };
    const runs: FoldableRun[] = [];
    let start = 0;
    for(let position = 1; position <= blocks.length; position++) {
        const key = keyOf(blocks[start]);
        if(position < blocks.length && key != null && keyOf(blocks[position]) === key) {
            continue;
        }
        if(position - start >= 2) {
            const run = blocks.slice(start, position);
            const saving = linesLength(run.flatMap((block) => block.fixedLines)) - linesLength(foldRun(run).fixedLines);
            if(saving > 0) {
                runs.push({ start: start, end: position, saving: saving, hidesContent: run.some((block) => block.contentLength > 0) });
            }
        }
        start = position;
    }
    return runs;
}

/** `blocks` with each chosen run folded; `foldedLength` folds only the first that many of the last run. */
function withRunsFolded(blocks: StatementBlock[], runs: FoldableRun[], foldedLength: number): StatementBlock[] {
    const byStart = [...runs].sort((left, right) => left.start - right.start);
    const result: StatementBlock[] = [];
    let position = 0;
    for(const run of byStart) {
        appendAll(result, blocks.slice(position, run.start));
        let end = run.end;
        if(run === runs[runs.length - 1]) {
            end = run.start + foldedLength;
        }
        result.push(foldRun(blocks.slice(run.start, end)));
        appendAll(result, blocks.slice(end, run.end));
        position = run.end;
    }
    appendAll(result, blocks.slice(position));
    return result;
}

/** `blocks` in `groups` runs of neighbours as even in size as possible, each run of two or more folded into one block. */
function groupNeighbours(blocks: StatementBlock[], groups: number): StatementBlock[] {
    const grouped: StatementBlock[] = [];
    let start = 0;
    for(let group = 0; group < groups; group++) {
        const end = Math.round(((group + 1) * blocks.length) / groups);
        const run = blocks.slice(start, end);
        if(run.length === 1) {
            grouped.push(run[0]);
        }
        else if(run.length > 1) {
            grouped.push(foldRun(run));
        }
        start = end;
    }
    return grouped;
}

/**
 * The least room `statements` need without folding any heading: every heading line, plus the one line
 * that counts what is left out. Below this, formatStatementLines starts folding headings together.
 */
export function minimumStatementLinesLength(statements: StatementResult[]): number {
    return fixedAndSummaryLength(statements.map(toStatementBlock)) - 1;
}

/**
 * Each statement's heading line, its notices and its rows within `maxCharacters` — shared by a result
 * and by an autocommit failure's committed part. Every heading is kept, so a cut never hides that a
 * write ran; the smallest results stay whole, the largest are cut, and a cut statement says what it
 * leaves out. When even the headings do not fit, runs of statements fold into one line each — alike
 * ones without notices or rows first, then alike ones, then any neighbours — so every statement stays
 * accounted for.
 */
export function formatStatementLines(statements: StatementResult[], maxCharacters: number = Number.POSITIVE_INFINITY): string[] {
    const blocks = statements.map(toStatementBlock);
    let wholeLength = 0;
    for(const block of blocks) {
        wholeLength += linesLength(block.fixedLines) + block.contentLength;
    }
    if(wholeLength - 1 <= maxCharacters) {
        const lines: string[] = [];
        for(const block of blocks) {
            appendAll(lines, block.fixedLines);
            appendWholeContent(lines, block);
        }
        return lines;
    }
    const laidOut = layOutBlocks(blocks, maxCharacters);
    if(laidOut != null) {
        return laidOut;
    }

    // Hundreds of statements under a small limit: fold runs of alike statements until the rest fits — the runs
    // that hide nothing first, then by what they save — and fold only as much of the last run as it takes
    const runs = foldableRuns(blocks).sort((left, right) => {
        return Number(left.hidesContent) - Number(right.hidesContent) || right.saving - left.saving;
    });
    const chosen: FoldableRun[] = [];
    let needed = fixedAndSummaryLength(blocks) - (maxCharacters + 1);
    for(const run of runs) {
        if(needed <= 0) {
            break;
        }
        chosen.push(run);
        needed -= run.saving;
    }
    if(needed <= 0 && chosen.length > 0) {
        const last = chosen[chosen.length - 1];
        // The shortest fold of the last run that still fits: longer folds fit, shorter ones may not
        let low = 2;
        let high = last.end - last.start;
        let fitting = layOutBlocks(withRunsFolded(blocks, chosen, high), maxCharacters);
        while(low < high) {
            const middle = Math.floor((low + high) / 2);
            const lines = layOutBlocks(withRunsFolded(blocks, chosen, middle), maxCharacters);
            if(lines == null) {
                low = middle + 1;
            }
            else {
                fitting = lines;
                high = middle;
            }
        }
        if(fitting != null) {
            return fitting;
        }
    }

    // Still too many lines: group neighbours into ranges — as many ranges as fit, so each says as much as it can
    let groups = blocks.length - 1;
    while(groups >= 1) {
        const lines = layOutBlocks(groupNeighbours(blocks, groups), maxCharacters);
        if(lines != null) {
            return lines;
        }
        groups = Math.min(groups - 1, Math.floor(groups * 0.9));
    }
    // One line for all of them; the final output limit cuts even that if it must. A lone statement
    // keeps its own heading and says what it cannot show
    const single = groupNeighbours(blocks, 1)[0];
    const lines = [...single.fixedLines];
    const cut = cutLines(single, NOTHING_SHOWN);
    appendAll(lines, cut.notices);
    appendAll(lines, cut.rows);
    return lines;
}

export function formatDbSummary(summary: DbSummary | null): string {
    if(summary == null) {
        return [
            "No database is registered.",
            "Set DB_DRIVER and DB_URL (or DB_HOST / DB_NAME / DB_USER) in this server's env block, then restart it.",
        ].join("\n");
    }

    const lines = [`Database: ${summary.name}`];
    lines.push(`  ${summary.driver}  ${summary.user}@${summary.host}:${summary.port}/${summary.database}  · ssl ${summary.ssl}`);
    if(summary.tunnel != null) {
        lines.push(`  via ssh ${summary.tunnel.username}@${summary.tunnel.host}:${summary.tunnel.port} (${summary.tunnel.authMethod}) — the database host is resolved on the ssh server`);
    }
    else {
        lines.push("  direct connection");
    }
    if(summary.description != null) {
        lines.push(`  ${summary.description}`);
    }

    let access = "read-write";
    if(summary.readonly == true) {
        access = "read-only (every call runs in BEGIN READ ONLY … ROLLBACK)";
    }
    let ddl = "DDL allowed";
    if(summary.readonly == true) {
        ddl = "no DDL (read-only)";
    }
    else if(summary.allowDdl == false) {
        ddl = "DDL disabled";
    }
    lines.push(`Policy: ${access} · ${ddl} · deny patterns ${summary.denyPatternCount} · statement timeout ${summary.statementTimeoutMs / 1000}s (server-side) · up to ${summary.maxRows} rows per statement`);
    lines.push(`Always refused: ${ALWAYS_REFUSED_SUMMARY}.`);
    return lines.join("\n");
}

/** The line under a catalog listing that stopped at CATALOG_MAX_ROWS. */
function catalogCutNote(listing: CatalogRows, what: string): string[] {
    if(listing.truncated == false) {
        return [];
    }
    return [`… only the first ${listing.rows.length} ${what} are listed — more exist`];
}

export function formatSchemas(schemas: CatalogRows): string {
    if(schemas.rows.length === 0) {
        return "No user schemas.";
    }
    const table = [["schema", "owner", "tables", "views", "sequences", "comment"]];
    for(const row of schemas.rows) {
        table.push([
            textOf(row.schema),
            textOf(row.owner),
            textOf(row.tables),
            textOf(row.views),
            textOf(row.sequences),
            textOf(row.comment),
        ]);
    }
    return [...alignColumns(table), ...catalogCutNote(schemas, "schemas")].join("\n");
}

/** `schema` and `alsoMatches` as SQL writes them; `alsoMatches` are other schemas the same spelling could mean (`"K2"` beside `k2`). */
export function formatRelations(
    schema: string,
    relations: CatalogRows,
    types: CatalogRows,
    alsoMatches: string[] = []
): string {
    const notes = alsoMatches.map((other) => `note: schema ${other} matches this spelling too — write it exactly that way (quotes included) to list it`);
    if(relations.rows.length === 0 && types.rows.length === 0) {
        return [`Schema ${schema} has no tables, views, sequences or types.`, ...notes].join("\n");
    }
    const lines: string[] = [...notes];
    if(relations.rows.length > 0) {
        const table = [["name", "kind", "approx rows", "size", "comment"]];
        for(const relation of relations.rows) {
            table.push([
                textOf(relation.name),
                textOf(relation.kind),
                textOf(relation.approx_rows),
                textOf(relation.size),
                textOf(relation.comment),
            ]);
        }
        lines.push(`Relations in ${schema}: ${relations.rows.length}`);
        lines.push(...alignColumns(table), ...catalogCutNote(relations, "relations"));
    }
    if(types.rows.length > 0) {
        if(lines.length > 0) {
            lines.push("");
        }
        lines.push(`Types in ${schema}: ${types.rows.length}`);
        const table = [["name", "kind", "values / base type / fields"]];
        for(const type of types.rows) {
            table.push([textOf(type.name), textOf(type.kind), textOf(type.detail)]);
        }
        lines.push(...alignColumns(table), ...catalogCutNote(types, "types"));
    }
    lines.push("");
    lines.push("approx rows comes from the planner's statistics (pg_class.reltuples; a partitioned table sums its partitions); blank means never analyzed.");
    lines.push("A partition is listed under its partitioned table — db_describe on the table lists them.");
    return lines.join("\n");
}

/** Trigger firing states other than the ordinary one: tgenabled D / R / A. */
const TRIGGER_STATE_LABELS: Record<string, string> = {
    D: "(disabled)",
    R: "(replica only — does not fire in ordinary sessions)",
    A: "(always)",
};

export function formatRelationDescription(description: RelationDescription): string {
    const heading = [`${description.schema}.${description.name}  (${description.kind})`];
    // "≥1000 (1 of 3 leaf partitions never analyzed)" is already a bound, not an estimate to mark with ~
    const partialRows = /^(≥\d+) (\(.*\))$/.exec(description.approxRows ?? "");
    if(partialRows != null) {
        heading.push(`${partialRows[1]} rows ${partialRows[2]}`);
    }
    else if(description.approxRows != null) {
        heading.push(`~${description.approxRows} rows`);
    }
    if(description.size != null) {
        heading.push(description.size);
    }
    const lines = [heading.join(" · ")];
    // The same spelling names another object too (SQL folds an unquoted name; "Users" and users can both exist)
    for(const other of description.alsoMatches) {
        lines.push(`note: ${other} matches this spelling too — write the name exactly that way (quotes included) to describe it`);
    }
    if(description.comment != null) {
        lines.push(`comment: ${description.comment}`);
    }
    if(description.inheritsFrom != null) {
        lines.push(`inherits from: ${description.inheritsFrom}`);
    }
    if(description.partitionKey != null) {
        lines.push(`partitioned by: ${description.partitionKey}`);
    }
    if(description.partitionBound != null) {
        lines.push(`partition bound: ${description.partitionBound}`);
    }

    // A sequence's pg_attribute rows are storage fields (last_value, log_cnt, is_called), not what anyone asks about
    if(description.sequence != null) {
        const sequence = description.sequence;
        lines.push("", "sequence:");
        const settings = [textOf(sequence.type), `start ${textOf(sequence.start)}`, `increment ${textOf(sequence.increment)}`, `min ${textOf(sequence.min)}`, `max ${textOf(sequence.max)}`, `cache ${textOf(sequence.cache)}`];
        if(sequence.cycle == true) {
            settings.push("cycles");
        }
        lines.push(`  ${settings.join(" · ")}`);
        if(sequence.owned_by != null) {
            lines.push(`  owned by ${textOf(sequence.owned_by)}`);
        }
    }
    else {
        lines.push("", "columns:");
        const columnTable: string[][] = [];
        for(const column of description.columns) {
            const traits: string[] = [];
            if(column.not_null == true) {
                traits.push("not null");
            }
            if(column.identity != null) {
                traits.push(`identity ${column.identity}`);
            }
            // A generated column's expression is not a default — a value given for it in INSERT is refused
            if(column.generated != null) {
                traits.push(`generated ${column.generated} as ${textOf(column.default_value)}`);
            }
            else if(column.default_value != null) {
                traits.push(`default ${column.default_value}`);
            }
            if(column.enum_values != null) {
                traits.push(`enum (${column.enum_values})`);
            }
            let comment = "";
            if(column.comment != null) {
                comment = `-- ${column.comment}`;
            }
            columnTable.push([`  ${textOf(column.name)}`, textOf(column.type), traits.join(", "), comment]);
        }
        lines.push(...alignColumns(columnTable));
    }

    // "0 scans" means nothing without knowing since when: a counter reset yesterday and an index unused for a year read the same
    let indexesTitle = "indexes";
    const firstIndex = description.indexes[0];
    if(firstIndex?.scans != null) {
        let since = "the server's statistics began";
        if(firstIndex.stats_reset != null) {
            since = textOf(firstIndex.stats_reset);
        }
        indexesTitle = `indexes (scans counted since ${since})`;
    }

    const sections: [string, Record<string, unknown>[], (row: Record<string, unknown>) => string[]][] = [
        ["constraints", description.constraints, (row) => [`  ${textOf(row.name)}`, textOf(row.type), textOf(row.definition)]],
        ["referenced by", description.referencedBy, (row) => [`  ${textOf(row.from_schema)}.${textOf(row.from_table)} (${textOf(row.name)})`, textOf(row.definition)]],
        [indexesTitle, description.indexes, (row) => {
            let size = textOf(row.size);
            if(row.scans != null) {
                size = `${size} · ${textOf(row.scans)} scans`;
            }
            // A partitioned index made ON ONLY the parent stays invalid until every partition's index is attached —
            // a normal step of building it without locking; dropping it would undo that work
            if(row.valid == false && row.index_kind === "I") {
                size = `${size} · INVALID until every partition has its index attached — create the missing ones and ALTER INDEX … ATTACH PARTITION`;
            }
            // A failed CREATE INDEX CONCURRENTLY leaves the index behind; the planner never uses it
            else if(row.valid == false) {
                size = `${size} · INVALID — unusable; drop and recreate`;
            }
            return [`  ${textOf(row.name)}`, size, textOf(row.definition)];
        }],
        ["triggers", description.triggers, (row) => [`  ${textOf(row.name)}`, TRIGGER_STATE_LABELS[textOf(row.enabled_state)] ?? "", textOf(row.definition)]],
        ["partitions", description.partitions, (row) => {
            let name = textOf(row.name);
            if(row.partitioned == true) {
                name = `${name} (partitioned)`;
            }
            return [`  ${name}`, textOf(row.bound)];
        }],
        ["inherited by (INHERITS — not partitions)", description.inheritedBy, (row) => [`  ${textOf(row.name)}`]],
    ];
    for(const [title, rows, toCells] of sections) {
        if(rows.length === 0) {
            continue;
        }
        lines.push("", `${title}:`);
        lines.push(...alignColumns(rows.map(toCells)));
    }
    // Partitions and INHERITS children are read together, and their sections come last — so the note follows both
    if(description.partitionsTruncated == true) {
        let children = "child tables";
        if(description.inheritedBy.length === 0) {
            children = "partitions";
        }
        else if(description.partitions.length === 0) {
            children = "INHERITS children";
        }
        lines.push(`  … only the first ${description.partitions.length + description.inheritedBy.length} ${children} are listed — more exist`);
    }

    if(description.viewDefinition != null) {
        lines.push("", "definition:", description.viewDefinition.trim());
    }
    return lines.join("\n");
}
