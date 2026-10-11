export type DbDriverName = "postgres";

/**
 * `require` encrypts without checking the certificate, `verify` also checks it (against
 * `DB_SSL_CA` when given, the system store otherwise), `off` sends plain text.
 */
export type SslMode = "require" | "verify" | "off";

/** Guard rules applied to every statement. Resolved once at startup from the `DB_*` variables. */
export interface DbPolicy {
    /** Only reads, inside `BEGIN READ ONLY … ROLLBACK`. */
    readonly: boolean;
    /** When false, CREATE / ALTER / DROP / GRANT and the like are rejected. */
    allowDdl: boolean;
    /** Extra deny rules, compiled at startup and tested against each statement's text. */
    denyPatterns: RegExp[];
    /** Sent as the session's `statement_timeout`, so the server stops the query. */
    statementTimeoutMs: number;
    /** TCP + handshake limit for the SSH hop and for the database connection. */
    connectTimeoutMs: number;
    /** Rows read per statement. */
    maxRows: number;
    /** Rendered tool output is cut past this many characters. */
    maxOutputCharacters: number;
}

/** The SSH hop in front of the database. The database host is resolved by the SSH server. */
export interface SshTunnelProfile {
    host: string;
    port: number;
    username: string;
    /** Expanded absolute path to a private key file. */
    privateKeyPath?: string;
    passphrase?: string;
    password?: string;
    /** Expected host key, `SHA256:…`; a mismatch aborts the connection. */
    hostKeyFingerprint?: string;
}

/** The registered database: where it is, how to reach it, what is permitted. */
export interface DbProfile {
    /** Alias shown to the model, from `DB_ALIAS`; defaults to `<database>@<host>`. */
    name: string;
    driver: DbDriverName;
    host: string;
    port: number;
    database: string;
    user: string;
    password?: string;
    ssl: SslMode;
    /** Expanded path to a CA bundle for `ssl: verify`. */
    sslCaPath?: string;
    description?: string;
    /** Null for a direct connection. */
    tunnel: SshTunnelProfile | null;
    policy: DbPolicy;
}

/** Credential-free view of the profile, safe to hand back to the model. */
export interface DbSummary {
    name: string;
    driver: DbDriverName;
    host: string;
    port: number;
    database: string;
    user: string;
    ssl: SslMode;
    description?: string;
    tunnel: { host: string; port: number; username: string; authMethod: "privateKey" | "password" | "agent" } | null;
    readonly: boolean;
    allowDdl: boolean;
    denyPatternCount: number;
    statementTimeoutMs: number;
    maxRows: number;
}
