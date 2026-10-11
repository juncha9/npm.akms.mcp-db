import type { DbDriverName, SslMode } from "./profile";

/** One `mcpServers` entry as every MCP client spells it: a stdio command plus its env block. */
export interface McpServerEntry {
    command: string;
    args: string[];
    env: Record<string, string>;
}

export type SshAuthMethod = "key" | "password" | "agent";

/**
 * What the `config` form collects for one database. `answersToEntry` turns it into `DB_*`
 * variables and `entryToAnswers` reads an existing entry back, so an edit pre-fills.
 */
export interface DbSetupAnswers {
    /** The entry key — the name the agent sees in its tool list. */
    name: string;
    /** Written as `DB_DRIVER`; the form's first row, so a second driver slots in there. */
    driver: DbDriverName;
    host: string;
    port: number;
    database: string;
    user: string;
    password?: string;
    ssl: SslMode;
    /** As typed, `~` kept — the entry stays portable across machines. */
    sslCaPath?: string;
    description?: string;
    /** Set when the database is reached through an SSH tunnel. */
    sshHost?: string;
    sshPort?: number;
    sshUser?: string;
    sshAuth: SshAuthMethod;
    /** As typed, `~` kept. */
    sshKeyPath?: string;
    sshPassphrase?: string;
    sshPassword?: string;
    sshHostKeyFingerprint?: string;
    readonly: boolean;
    allowDdl: boolean;
    /** `DB_*` variables the form does not ask about, carried through an edit untouched. */
    extraEnv: Record<string, string>;
}

export type ConfigTargetId = "claude-code" | "claude-desktop" | "codex" | "cursor";

export interface ConfigWriteResult {
    status: "written" | "unavailable";
    /** Where it went, or why it could not and what to do instead. */
    detail: string;
}

/** One MCP client's config: where its entries live and how to change them. */
export interface ConfigTarget {
    id: ConfigTargetId;
    label: string;
    /** The config file, as shown to the user. */
    location: string;
    /** True when the client's CLI is on PATH or its config file exists. */
    detected: boolean;
    /**
     * Every `mcpServers` entry in the file, ours or not; entries this package cannot parse
     * are skipped.
     *
     * @throws {Error} If the file exists but cannot be parsed.
     */
    readEntries(): Record<string, McpServerEntry>;
    writeEntry(name: string, entry: McpServerEntry): ConfigWriteResult;
    removeEntry(name: string): ConfigWriteResult;
}
