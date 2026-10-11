import type { GuardVerdict } from "@/_types";

/** A statement the guard refused. Nothing was sent to the database. */
export class GuardRejectionError extends Error {
    readonly verdict: GuardVerdict;

    constructor(verdict: GuardVerdict) {
        super(verdict.reason ?? "rejected by the database profile's guard policy");
        this.verdict = verdict;
        this.name = "GuardRejectionError";
    }
}

/**
 * Rendered for the model: what fired, on which statement, and that nothing ran. The heading
 * tells a policy refusal (report it) apart from a statement the agent should fix or rewrite.
 */
export function formatGuardRejection(verdict: GuardVerdict): string {
    const reason = verdict.reason ?? "rejected by policy";
    let heading = `Refused by the guard: ${reason}`;
    let ending = "Nothing was sent to the database.";
    if(verdict.kind === "unsupported") {
        heading = `Not supported by this tool: ${reason}`;
        ending = "Nothing was sent to the database — rewrite the statement and send it again.";
    }
    else if(verdict.kind === "syntax") {
        heading = `SQL syntax error: ${reason}`;
        ending = "Nothing was sent to the database — fix the statement and send it again.";
    }

    const lines = [heading];
    if(verdict.statementIndex != null && verdict.offendingText != null) {
        let shown = verdict.offendingText.replace(/\s+/g, " ");
        if(shown.length > 200) {
            shown = `${shown.slice(0, 200)}…`;
        }
        lines.push(`statement ${verdict.statementIndex}: ${shown}`);
    }
    lines.push(ending);
    return lines.join("\n");
}
