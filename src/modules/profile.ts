import fs from "node:fs";
import {
    DB_ENV,
    DEFAULT_CONNECT_TIMEOUT_MS,
    DEFAULT_MAX_OUTPUT_CHARACTERS,
    DEFAULT_MAX_ROWS,
    DEFAULT_POSTGRES_PORT,
    DEFAULT_SSH_PORT,
    DEFAULT_STATEMENT_TIMEOUT_MS,
    LOG_LEVEL_ENV,
    MAX_PORT,
    MAX_ROWS_LIMIT,
    MAX_TIMER_MS,
    MIN_OUTPUT_CHARACTERS,
} from "@/_defs";
import type { DbDriverName, DbPolicy, DbProfile, DbSummary, SshTunnelProfile, SslMode } from "@/_types";
import { $logger } from "@/_libs/logger";
import { type EnvSource, expandHomePath, readBooleanEnv, readEnv, readIntegerEnv, readSecretEnv } from "@/_libs/env";
import { describeError } from "@/_libs/text";

const SSL_MODES: SslMode[] = ["require", "verify", "off"];

/** libpq `sslmode` → ours, so a `postgres://…?sslmode=…` URL carried over from another tool keeps its meaning. */
const URL_SSLMODE_MAP: Record<string, SslMode> = {
    "disable": "off",
    "allow": "require",
    "prefer": "require",
    "require": "require",
    "verify-ca": "verify",
    "verify-full": "verify",
};

/** Connection fields that `DB_URL` already carries — setting both is ambiguous, so startup fails. */
const URL_EXCLUSIVE_ENVS = [DB_ENV.HOST, DB_ENV.PORT, DB_ENV.NAME, DB_ENV.USER, DB_ENV.PASSWORD];

/** Every variable this server reads. */
const KNOWN_ENV_NAMES: string[] = [...Object.values(DB_ENV), LOG_LEVEL_ENV];

/**
 * Variables whose silent absence is dangerous: a misspelling leaves the most permissive default
 * (writable, DDL on, no deny list, no pin) and nothing else fails to show it. A name close to one of
 * these fails startup; one close to a connection variable only logs — a wrong connection shows itself.
 */
const POLICY_ENV_NAMES: string[] = [
    DB_ENV.READONLY,
    DB_ENV.ALLOW_DDL,
    DB_ENV.DENY_PATTERNS,
    DB_ENV.STATEMENT_TIMEOUT_MS,
    DB_ENV.MAX_ROWS,
    DB_ENV.MAX_OUTPUT_CHARACTERS,
    DB_ENV.SSL,
    DB_ENV.SSL_CA,
    DB_ENV.SSH_HOST_KEY,
];

/** The only libpq URL parameter with a meaning here; any other would be dropped, so it fails startup instead. */
const SUPPORTED_URL_PARAMETERS = ["sslmode"];

const TUNNEL_DETAIL_ENVS = [
    DB_ENV.SSH_PORT,
    DB_ENV.SSH_USER,
    DB_ENV.SSH_KEY,
    DB_ENV.SSH_PASSPHRASE,
    DB_ENV.SSH_PASSWORD,
    DB_ENV.SSH_HOST_KEY,
];

export interface ConnectionFields {
    host: string;
    port: number;
    database: string;
    user: string;
    password?: string;
    urlSslMode?: SslMode;
}

/**
 * Reads the database this server fronts from `DB_*` variables.
 *
 * Returns null when nothing is configured — the server still starts and its tools say so.
 * Throws on any malformed or contradictory value, naming the variable but never echoing a secret.
 */
export function loadDbProfile(env: EnvSource = process.env): DbProfile | null {
    const rawUrl = readEnv(env, DB_ENV.URL);
    const host = readEnv(env, DB_ENV.HOST);
    if(rawUrl == null && host == null) {
        const _startupLogger = $logger.child({ context: "loadDbProfile" });
        _startupLogger.warn("no database is registered; set the connection variables and restart", {
            env_vars: [DB_ENV.URL, DB_ENV.HOST],
        });
        return null;
    }

    // A misspelled policy variable would otherwise fall back to its most permissive default without a word.
    // Only once a database is configured: other programs' DB_* variables can share an inherited environment.
    for(const envName of Object.keys(env)) {
        // db_readonly / DB_ReadOnly count too: POSIX environments are case-sensitive, so neither is DB_READONLY there
        const upperName = envName.toUpperCase();
        if(upperName.startsWith("DB_") == false || KNOWN_ENV_NAMES.includes(envName) == true || readEnv(env, envName) == null) {
            continue;
        }
        // Windows reads names case-insensitively — there db_readonly is DB_READONLY, and is read
        if(KNOWN_ENV_NAMES.includes(upperName) == true && readEnv(env, upperName) === readEnv(env, envName)) {
            continue;
        }
        const intended = findIntendedEnvName(upperName);
        if(intended == null) {
            continue;
        }
        if(POLICY_ENV_NAMES.includes(intended) == true) {
            throw new Error(`${envName} is not a variable this server reads — did you mean ${intended}? A misspelled setting would silently keep its default`);
        }
        const _envLogger = $logger.child({ context: "loadDbProfile" });
        _envLogger.warn("environment variable is not one this server reads; ignored", { env_var: envName, did_you_mean: intended });
    }

    // (1) Driver — the only one so far, but named explicitly so a second one can't be confused with it.
    const driverValue = readEnv(env, DB_ENV.DRIVER);
    if(driverValue == null) {
        throw new Error(`${DB_ENV.DRIVER} is required (supported: postgres)`);
    }
    if(driverValue.toLowerCase() !== "postgres") {
        throw new Error(`${DB_ENV.DRIVER} "${driverValue}" is not supported (supported: postgres)`);
    }
    const driver: DbDriverName = "postgres";

    // (2) Where the database is — one URL, or the split variables, never both
    let connection: ConnectionFields;
    if(rawUrl != null) {
        const conflicting = URL_EXCLUSIVE_ENVS.filter((name) => readEnv(env, name) != null);
        if(conflicting.length > 0) {
            throw new Error(`${DB_ENV.URL} is set, so ${conflicting.join(", ")} must not be — use one or the other`);
        }
        connection = parseDatabaseUrl(rawUrl);
    }
    else {
        const database = readEnv(env, DB_ENV.NAME);
        const user = readEnv(env, DB_ENV.USER);
        if(database == null || user == null) {
            throw new Error(`${DB_ENV.HOST} is set, so ${DB_ENV.NAME} and ${DB_ENV.USER} are required`);
        }
        connection = {
            host: host as string,
            port: readIntegerEnv(env, DB_ENV.PORT, MAX_PORT) ?? DEFAULT_POSTGRES_PORT,
            database: database,
            user: user,
            password: readSecretEnv(env, DB_ENV.PASSWORD),
        };
    }

    const name = readEnv(env, DB_ENV.ALIAS) ?? `${connection.database}@${connection.host}`;
    const _logger = $logger.child({ context: "loadDbProfile", profile: name });

    // (3) TLS — on by default, through a tunnel too (RDS rejects an unencrypted session even from inside the VPC)
    let ssl: SslMode = connection.urlSslMode ?? "require";
    // Named in errors, so a message points at the setting that actually produced the mode
    let sslSource = "the default";
    if(connection.urlSslMode != null) {
        sslSource = `${DB_ENV.URL}'s sslmode`;
    }
    const sslValue = readEnv(env, DB_ENV.SSL);
    if(sslValue != null) {
        const normalized = sslValue.toLowerCase() as SslMode;
        if(SSL_MODES.includes(normalized) == false) {
            throw new Error(`${DB_ENV.SSL} must be one of ${SSL_MODES.join(", ")} (got "${sslValue}")`);
        }
        ssl = normalized;
        sslSource = DB_ENV.SSL;
    }
    let sslCaPath: string | undefined;
    const sslCaValue = readEnv(env, DB_ENV.SSL_CA);
    if(sslCaValue != null) {
        // libpq would verify against a root certificate it was given; here the bundle is used only by verify
        if(ssl !== "verify") {
            throw new Error(`${DB_ENV.SSL_CA} is set but the TLS mode is "${ssl}" (from ${sslSource}), which does not check the certificate — set ${DB_ENV.SSL}=verify, or remove ${DB_ENV.SSL_CA}`);
        }
        sslCaPath = expandHomePath(sslCaValue);
        // The driver reads the bundle while it is built, so a missing one stops startup either way — this says why
        if(fs.existsSync(sslCaPath) == false) {
            throw new Error(`${DB_ENV.SSL_CA} names ${sslCaPath}, which does not exist`);
        }
    }

    // (4) The SSH hop — a detail without its host is a mistake, not a direct connection
    let tunnel: SshTunnelProfile | null = null;
    const sshHost = readEnv(env, DB_ENV.SSH_HOST);
    if(sshHost == null) {
        const orphaned = TUNNEL_DETAIL_ENVS.filter((envName) => readEnv(env, envName) != null);
        if(orphaned.length > 0) {
            throw new Error(`${orphaned.join(", ")} set without ${DB_ENV.SSH_HOST} — set the host or remove them`);
        }
    }
    else {
        const sshUser = readEnv(env, DB_ENV.SSH_USER);
        if(sshUser == null) {
            throw new Error(`${DB_ENV.SSH_HOST} is set, so ${DB_ENV.SSH_USER} is required`);
        }
        tunnel = {
            host: sshHost,
            port: readIntegerEnv(env, DB_ENV.SSH_PORT, MAX_PORT) ?? DEFAULT_SSH_PORT,
            username: sshUser,
            passphrase: readSecretEnv(env, DB_ENV.SSH_PASSPHRASE),
            password: readSecretEnv(env, DB_ENV.SSH_PASSWORD),
            hostKeyFingerprint: readEnv(env, DB_ENV.SSH_HOST_KEY),
        };
        const keyValue = readEnv(env, DB_ENV.SSH_KEY);
        if(keyValue != null) {
            tunnel.privateKeyPath = expandHomePath(keyValue);
            if(fs.existsSync(tunnel.privateKeyPath) == false) {
                _logger.warn(`${DB_ENV.SSH_KEY} does not exist; connections will fail`, {
                    private_key_path: tunnel.privateKeyPath,
                });
            }
        }
    }

    // (5) Policy
    const policy: DbPolicy = {
        readonly: readBooleanEnv(env, DB_ENV.READONLY) ?? false,
        allowDdl: readBooleanEnv(env, DB_ENV.ALLOW_DDL) ?? true,
        denyPatterns: compileDenyPatterns(readDenyPatternSources(env)),
        statementTimeoutMs: readIntegerEnv(env, DB_ENV.STATEMENT_TIMEOUT_MS, MAX_TIMER_MS) ?? DEFAULT_STATEMENT_TIMEOUT_MS,
        connectTimeoutMs: readIntegerEnv(env, DB_ENV.CONNECT_TIMEOUT_MS, MAX_TIMER_MS) ?? DEFAULT_CONNECT_TIMEOUT_MS,
        maxRows: readIntegerEnv(env, DB_ENV.MAX_ROWS, MAX_ROWS_LIMIT) ?? DEFAULT_MAX_ROWS,
        maxOutputCharacters: readIntegerEnv(env, DB_ENV.MAX_OUTPUT_CHARACTERS) ?? DEFAULT_MAX_OUTPUT_CHARACTERS,
    };
    // An error's own message can be 1000 characters; a smaller limit would cut the lines that say what was committed
    if(policy.maxOutputCharacters < MIN_OUTPUT_CHARACTERS) {
        throw new Error(`${DB_ENV.MAX_OUTPUT_CHARACTERS} must be at least ${MIN_OUTPUT_CHARACTERS} (got ${policy.maxOutputCharacters}) — below that an error's own message could not fit`);
    }

    const profile: DbProfile = {
        name: name,
        driver: driver,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        user: connection.user,
        password: connection.password,
        ssl: ssl,
        sslCaPath: sslCaPath,
        description: readEnv(env, DB_ENV.DESCRIPTION),
        tunnel: tunnel,
        policy: policy,
    };
    _logger.info("database profile loaded", {
        host: profile.host,
        port: profile.port,
        database: profile.database,
        tunnel: tunnel?.host ?? null,
        readonly: policy.readonly,
        allow_ddl: policy.allowDdl,
        deny_patterns: policy.denyPatterns.map((pattern) => pattern.source),
    });
    return profile;
}

/**
 * The known name `name` was probably meant to be, scored lower = likelier:
 * 0.5 — `name` is a cut-short known name (DB_STATEMENT_TIMEOUT, DB_SSH for DB_SSH_HOST);
 * 1 / 2 — that many edits away, two allowed only past seven characters, where two edits reach
 *         unrelated words (DB_POOL is not DB_PORT);
 * 1.5 — a known name with something added (DB_MAX_OUTPUT_CHARS, DB_SSLMODE) — weaker than one edit,
 *       so DB_SSH_HOSTKEY means DB_SSH_HOST_KEY rather than DB_SSH_HOST.
 * A 1.5 tie goes to the longer known name: DB_SSH_HOST_KEY_SHA256 extends DB_SSH_HOST_KEY, not just DB_SSH_HOST.
 * Any other tie keeps the first in KNOWN_ENV_NAMES order.
 */
function findIntendedEnvName(name: string): string | null {
    let closest: string | null = null;
    let closestScore = Number.POSITIVE_INFINITY;
    for(const known of KNOWN_ENV_NAMES) {
        let score = Number.POSITIVE_INFINITY;
        let allowedEdits = 2;
        if(known.length <= 7) {
            allowedEdits = 1;
        }
        const distance = editDistance(name, known);
        if(distance <= allowedEdits) {
            score = distance;
        }
        if(known.startsWith(name) == true) {
            score = Math.min(score, 0.5);
        }
        else if(name.startsWith(known) == true) {
            score = Math.min(score, 1.5);
        }
        // Only for something added: a cut-short name (DB_SS) still means the first, shortest completion (DB_SSL)
        const longerTie = score === 1.5 && closestScore === 1.5 && closest != null && known.length > closest.length;
        if(score < closestScore || longerTie == true) {
            closest = known;
            closestScore = score;
        }
    }
    return closest;
}

/** Levenshtein distance. */
function editDistance(left: string, right: string): number {
    let previous = Array.from({ length: right.length + 1 }, (_value, position) => position);
    for(let leftPosition = 1; leftPosition <= left.length; leftPosition++) {
        const current = [leftPosition];
        for(let rightPosition = 1; rightPosition <= right.length; rightPosition++) {
            let substitution = previous[rightPosition - 1];
            if(left[leftPosition - 1] !== right[rightPosition - 1]) {
                substitution += 1;
            }
            current.push(Math.min(previous[rightPosition] + 1, current[rightPosition - 1] + 1, substitution));
        }
        previous = current;
    }
    return previous[right.length];
}

/** `postgres://user:password@host:port/database?sslmode=…`. Errors never repeat the URL — it holds the password. */
export function parseDatabaseUrl(rawUrl: string): ConnectionFields {
    let url: URL;
    try {
        url = new URL(rawUrl);
    }
    catch {
        throw new Error(`${DB_ENV.URL} is not a valid URL`);
    }
    if(url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
        throw new Error(`${DB_ENV.URL} must start with postgres:// or postgresql:// (got "${url.protocol}//")`);
    }

    const unsupported = [...url.searchParams.keys()].filter((key) => SUPPORTED_URL_PARAMETERS.includes(key) == false);
    if(unsupported.length > 0) {
        throw new Error(`${DB_ENV.URL} has parameters this server does not apply: ${unsupported.join(", ")} — only sslmode is read; use ${DB_ENV.SSL} / ${DB_ENV.SSL_CA} for TLS, and set anything else on the database role (ALTER ROLE … SET)`);
    }

    // decodeURIComponent throws a bare "URI malformed" that would not say which variable
    const decode = (part: string, label: string): string => {
        try {
            return decodeURIComponent(part);
        }
        catch {
            throw new Error(`${DB_ENV.URL} has a malformed %-escape in its ${label} — percent-encode a literal % as %25`);
        }
    };

    const host = url.hostname.replace(/^\[|\]$/g, "");
    const user = decode(url.username, "user");
    if(host === "" || user === "") {
        throw new Error(`${DB_ENV.URL} must include a user and a host`);
    }

    let port = DEFAULT_POSTGRES_PORT;
    if(url.port !== "") {
        port = Number(url.port);
        if(port < 1 || port > MAX_PORT) {
            throw new Error(`${DB_ENV.URL} has port ${url.port}, outside 1–${MAX_PORT}`);
        }
    }

    // libpq's own default: no database in the URL means the database named after the user
    let database = decode(url.pathname.replace(/^\//, ""), "database name");
    if(database === "") {
        database = user;
    }

    let password: string | undefined;
    if(url.password !== "") {
        password = decode(url.password, "password");
    }

    let urlSslMode: SslMode | undefined;
    const sslmode = url.searchParams.get("sslmode");
    if(sslmode != null) {
        urlSslMode = URL_SSLMODE_MAP[sslmode.toLowerCase()];
        if(urlSslMode == null) {
            throw new Error(`${DB_ENV.URL} has an unknown sslmode "${sslmode}"`);
        }
    }

    return { host: host, port: port, database: database, user: user, password: password, urlSslMode: urlSslMode };
}

/**
 * `["…",` / `["…"]` / `["…" "` — a first item that is a whole double-quoted string, then what can only follow
 * one in JSON (or a missing comma). A typo after it (trailing text, a lost or extra comma) is a JSON mistake
 * to report; `["']\s*or` never closes its first quote, so it stays a regex.
 */
const JSON_ARRAY_START = /^\[\s*"(?:[^"\\]|\\.)*"\s*[,\]"]/;

/**
 * `DB_DENY_PATTERNS`: JSON when it parses as JSON or opens like a JSON array of strings — `["…",` (then it
 * must parse), otherwise comma-separated — so a list whose first regex starts with a character class
 * (`[^a-z]pg_sleep`, `["']\s*or`) still reads as a list. A comma inside `\s{1,3}` or `[,;]` would split
 * one regex into pieces that still compile and match nothing intended, so a piece with an unbalanced
 * bracket fails startup.
 */
function readDenyPatternSources(env: EnvSource): string[] {
    const value = readEnv(env, DB_ENV.DENY_PATTERNS);
    if(value == null) {
        return [];
    }

    if(value.startsWith("[") == true) {
        // ["\bdrop\s+table"] fails JSON.parse (\s is no JSON escape) yet is plainly a JSON array; ["']\s*or is a regex,
        // and so is ["]?secrets["]? — JSON_ARRAY_START reads `]?secrets[` as a closed first string, but no regex a
        // JSON list was meant to hold starts with `]`
        const firstString = /^\[\s*"((?:[^"\\]|\\.)*)"/.exec(value)?.[1] ?? "";
        const meantAsJson = JSON_ARRAY_START.test(value) == true && /^\s*\]/.test(firstString) == false;
        let parsed: unknown = undefined;
        try {
            parsed = JSON.parse(value);
        }
        catch(ex) {
            if(meantAsJson == true) {
                throw new Error(`${DB_ENV.DENY_PATTERNS} is written as a JSON array but is not valid JSON (${describeError(ex)}) — inside JSON a regex backslash is written twice: ["\\\\bdrop\\\\b"]. A comma list whose first regex starts with a class of quotes reads like JSON too: write that list as JSON`);
            }
            // Not JSON — a comma-separated list after all, checked below
        }
        if(parsed !== undefined) {
            if(Array.isArray(parsed) == false || (parsed as unknown[]).every((item) => typeof item === "string") == false) {
                throw new Error(`${DB_ENV.DENY_PATTERNS} as JSON must be an array of strings`);
            }
            const sources = (parsed as string[]).filter((item) => item.trim() !== "");
            // JSON reads "\b" as a backspace (U+0008): the pattern parses, compiles and never matches
            const withBackspace = sources.find((source) => source.includes("\u0008") == true);
            if(withBackspace != null) {
                throw new Error(`${DB_ENV.DENY_PATTERNS} entry ${JSON.stringify(withBackspace)} holds a backspace — in JSON \\b is a backspace; write \\\\b for a word boundary`);
            }
            return sources;
        }
    }

    const pieces = value.split(",").map((item) => item.trim()).filter((item) => item !== "");
    for(const piece of pieces) {
        if(hasBalancedBrackets(piece) == false) {
            throw new Error(`${DB_ENV.DENY_PATTERNS} entry /${piece}/ has an unbalanced bracket — a comma inside {m,n} or [...] splits one regex in two; write the list as a JSON array instead: ["…", "…"]`);
        }
    }
    return pieces;
}

/** `{}` and `()` balanced outside a character class, and every `[` class closed. Escaped characters don't count. */
function hasBalancedBrackets(source: string): boolean {
    let inClass = false;
    let parenDepth = 0;
    let braceDepth = 0;
    for(let position = 0; position < source.length; position++) {
        const character = source[position];
        if(character === "\\") {
            position += 1;
            continue;
        }
        if(inClass == true) {
            if(character === "]") {
                inClass = false;
            }
            continue;
        }
        if(character === "[") {
            inClass = true;
        }
        else if(character === "]") {
            return false;
        }
        else if(character === "(") {
            parenDepth += 1;
        }
        else if(character === ")") {
            parenDepth -= 1;
        }
        else if(character === "{") {
            braceDepth += 1;
        }
        else if(character === "}") {
            braceDepth -= 1;
        }
        if(parenDepth < 0 || braceDepth < 0) {
            return false;
        }
    }
    return inClass == false && parenDepth === 0 && braceDepth === 0;
}

function compileDenyPatterns(sources: string[]): RegExp[] {
    return sources.map((source) => {
        try {
            return new RegExp(source, "i");
        }
        catch(ex) {
            const _logger = $logger.child({ context: "compileDenyPatterns" });
            _logger.error(ex, "deny pattern is not a valid regular expression");
            throw new Error(`${DB_ENV.DENY_PATTERNS} has an invalid entry /${source}/: ${describeError(ex)}`);
        }
    });
}

/** What the model may see about the profile — no password, no key path. */
export function toDbSummary(profile: DbProfile): DbSummary {
    let tunnel: DbSummary["tunnel"] = null;
    if(profile.tunnel != null) {
        let authMethod: "privateKey" | "password" | "agent" = "agent";
        if(profile.tunnel.privateKeyPath != null) {
            authMethod = "privateKey";
        }
        else if(profile.tunnel.password != null) {
            authMethod = "password";
        }
        tunnel = {
            host: profile.tunnel.host,
            port: profile.tunnel.port,
            username: profile.tunnel.username,
            authMethod: authMethod,
        };
    }
    return {
        name: profile.name,
        driver: profile.driver,
        host: profile.host,
        port: profile.port,
        database: profile.database,
        user: profile.user,
        ssl: profile.ssl,
        description: profile.description,
        tunnel: tunnel,
        readonly: profile.policy.readonly,
        allowDdl: profile.policy.allowDdl,
        denyPatternCount: profile.policy.denyPatterns.length,
        statementTimeoutMs: profile.policy.statementTimeoutMs,
        maxRows: profile.policy.maxRows,
    };
}
