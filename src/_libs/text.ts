/** Cuts `text` at `maxCharacters` without splitting a surrogate pair, and says how much was dropped. */
export function truncateOutput(text: string, maxCharacters: number): { text: string; truncated: boolean } {
    if(text.length <= maxCharacters) {
        return { text: text, truncated: false };
    }
    // The tail note counts against the limit too, so the whole result stays within it
    const tail = (droppedCharacters: number) => `\n... [truncated ${droppedCharacters} characters of ${text.length}]`;
    let cutAt = Math.max(0, maxCharacters - tail(text.length).length);
    const lastKeptCode = text.charCodeAt(cutAt - 1);
    if(lastKeptCode >= 0xd800 && lastKeptCode <= 0xdbff) {
        cutAt -= 1;
    }
    const kept = text.slice(0, cutAt);
    return {
        text: `${kept}${tail(text.length - cutAt)}`,
        truncated: true,
    };
}

export function describeError(error: unknown): string {
    // Node's connect to "localhost" tries ::1 and 127.0.0.1 and, when both are refused, throws an
    // AggregateError with an empty message — the reasons are in errors[]
    if(error instanceof AggregateError && error.message === "") {
        const reasons = error.errors.map((inner: unknown) => describeError(inner)).filter((reason: string) => reason !== "");
        if(reasons.length > 0) {
            return reasons.join("; ");
        }
    }
    if(error instanceof Error) {
        if(error.message === "" && (error as { code?: unknown }).code != null) {
            return String((error as { code?: unknown }).code);
        }
        return error.message;
    }
    return String(error);
}
