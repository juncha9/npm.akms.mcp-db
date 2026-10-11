import { DB_ENV, DEFAULT_POSTGRES_PORT, DEFAULT_SSH_PORT, FALSY_ENV_VALUES, PACKAGE_NAME, SERVER_NAME, TRUTHY_ENV_VALUES } from "@/_defs";
import type { DbSetupAnswers, McpServerEntry, SslMode } from "@/_types";
import { parseDatabaseUrl } from "@/modules/profile";

/**
 * The variables the form owns. Anything else under `DB_*` (`DB_ALIAS`, deny patterns,
 * timeouts, row limits, …) is hand-edited and survives an edit untouched — see `extraEnv`.
 */
const MANAGED_ENV_NAMES: string[] = [
    DB_ENV.DRIVER,
    DB_ENV.URL,
    DB_ENV.HOST,
    DB_ENV.PORT,
    DB_ENV.NAME,
    DB_ENV.USER,
    DB_ENV.PASSWORD,
    DB_ENV.SSL,
    DB_ENV.SSL_CA,
    DB_ENV.DESCRIPTION,
    DB_ENV.SSH_HOST,
    DB_ENV.SSH_PORT,
    DB_ENV.SSH_USER,
    DB_ENV.SSH_KEY,
    DB_ENV.SSH_PASSPHRASE,
    DB_ENV.SSH_PASSWORD,
    DB_ENV.SSH_HOST_KEY,
    DB_ENV.READONLY,
    DB_ENV.ALLOW_DDL,
];

const SSL_MODES: SslMode[] = ["require", "verify", "off"];

/**
 * Valid MCP server names. The name becomes part of every tool name the agent sees
 * (`mcp__<name>__db_query`), and tool names allow only these characters.
 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;

/** True for entries that launch this package — the only ones the `config` command manages. */
export function isOurEntry(entry: McpServerEntry): boolean {
    if(entry.args.includes(PACKAGE_NAME) == true) {
        return true;
    }

    const commandBase = entry.command.replace(/\\/g, "/").split("/").pop() ?? "";
    return commandBase === SERVER_NAME || commandBase.startsWith(`${SERVER_NAME}.`) == true;
}

/**
 * How the client launches the server. On native Windows `npx` is a `.cmd` shim that a
 * client spawning without a shell cannot start, so it goes behind `cmd /c` — the wrapper
 * Claude Code's own docs prescribe for npx servers on Windows.
 */
function launchCommand(): { command: string; args: string[] } {
    if(process.platform === "win32") {
        return { command: "cmd", args: ["/c", "npx", "-y", PACKAGE_NAME] };
    }

    return { command: "npx", args: ["-y", PACKAGE_NAME] };
}

/**
 * Renders the answers as an entry. A value equal to the server's default is left out, so
 * the result reads like the README's examples rather than a dump of every variable. The
 * connection is always written split — an edit of a `DB_URL` entry rewrites it that way.
 */
export function answersToEntry(answers: DbSetupAnswers): McpServerEntry {
    const env: Record<string, string> = {};

    env[DB_ENV.DRIVER] = answers.driver;
    env[DB_ENV.HOST] = answers.host;
    if(answers.port !== DEFAULT_POSTGRES_PORT) {
        env[DB_ENV.PORT] = String(answers.port);
    }
    env[DB_ENV.NAME] = answers.database;
    env[DB_ENV.USER] = answers.user;
    if(answers.password != null && answers.password !== "") {
        env[DB_ENV.PASSWORD] = answers.password;
    }

    if(answers.ssl !== "require") {
        env[DB_ENV.SSL] = answers.ssl;
    }
    if(answers.ssl === "verify" && answers.sslCaPath != null && answers.sslCaPath !== "") {
        env[DB_ENV.SSL_CA] = answers.sslCaPath;
    }

    if(answers.description != null && answers.description !== "") {
        env[DB_ENV.DESCRIPTION] = answers.description;
    }

    if(answers.sshHost != null) {
        env[DB_ENV.SSH_HOST] = answers.sshHost;
        if(answers.sshPort != null && answers.sshPort !== DEFAULT_SSH_PORT) {
            env[DB_ENV.SSH_PORT] = String(answers.sshPort);
        }
        if(answers.sshUser != null) {
            env[DB_ENV.SSH_USER] = answers.sshUser;
        }

        if(answers.sshAuth === "key" && answers.sshKeyPath != null) {
            env[DB_ENV.SSH_KEY] = answers.sshKeyPath;
            if(answers.sshPassphrase != null && answers.sshPassphrase !== "") {
                env[DB_ENV.SSH_PASSPHRASE] = answers.sshPassphrase;
            }
        }
        if(answers.sshAuth === "password" && answers.sshPassword != null) {
            env[DB_ENV.SSH_PASSWORD] = answers.sshPassword;
        }

        if(answers.sshHostKeyFingerprint != null) {
            env[DB_ENV.SSH_HOST_KEY] = answers.sshHostKeyFingerprint;
        }
    }

    if(answers.readonly == true) {
        env[DB_ENV.READONLY] = "true";
    }
    if(answers.allowDdl == false) {
        env[DB_ENV.ALLOW_DDL] = "false";
    }

    for(const [name, value] of Object.entries(answers.extraEnv)) {
        if(MANAGED_ENV_NAMES.includes(name) == true) {
            continue;
        }
        env[name] = value;
    }

    const launch = launchCommand();
    return {
        command: launch.command,
        args: launch.args,
        env: env,
    };
}

function readPort(value: string | undefined, fallback: number): number {
    if(value == null) {
        return fallback;
    }

    const parsed = Number(value);
    if(Number.isInteger(parsed) == false || parsed <= 0) {
        return fallback;
    }

    return parsed;
}

function isTruthy(value: string | undefined): boolean {
    if(value == null) {
        return false;
    }

    return TRUTHY_ENV_VALUES.includes(value.trim().toLowerCase());
}

function isFalsy(value: string | undefined): boolean {
    if(value == null) {
        return false;
    }

    return FALSY_ENV_VALUES.includes(value.trim().toLowerCase());
}

/** The five connection fields, from the split variables or from `DB_URL`; an unreadable URL leaves them empty. */
function readConnection(env: Record<string, string>): {
    host: string;
    port: number;
    database: string;
    user: string;
    password?: string;
    ssl: SslMode;
} {
    let host = env[DB_ENV.HOST] ?? "";
    let port = readPort(env[DB_ENV.PORT], DEFAULT_POSTGRES_PORT);
    let database = env[DB_ENV.NAME] ?? "";
    let user = env[DB_ENV.USER] ?? "";
    let password: string | undefined = env[DB_ENV.PASSWORD];
    let urlSslMode: SslMode | undefined;

    const url = env[DB_ENV.URL];
    if(url != null) {
        try {
            const parsed = parseDatabaseUrl(url);
            host = parsed.host;
            port = parsed.port;
            database = parsed.database;
            user = parsed.user;
            password = parsed.password;
            urlSslMode = parsed.urlSslMode;
        }
        catch {
            // The form shows the fields empty and asks for them; the server would refuse this URL anyway.
        }
    }

    let ssl: SslMode = urlSslMode ?? "require";
    const sslValue = env[DB_ENV.SSL]?.trim().toLowerCase() as SslMode | undefined;
    if(sslValue != null && SSL_MODES.includes(sslValue) == true) {
        ssl = sslValue;
    }

    return { host: host, port: port, database: database, user: user, password: password, ssl: ssl };
}

/** Reads an existing entry back into answers so the form can pre-fill an edit. */
export function entryToAnswers(name: string, entry: McpServerEntry): DbSetupAnswers {
    const env = entry.env;
    const connection = readConnection(env);

    let sshAuth: DbSetupAnswers["sshAuth"] = "agent";
    if(env[DB_ENV.SSH_KEY] != null) {
        sshAuth = "key";
    }
    else if(env[DB_ENV.SSH_PASSWORD] != null) {
        sshAuth = "password";
    }

    const extraEnv: Record<string, string> = {};
    for(const [variable, value] of Object.entries(env)) {
        if(MANAGED_ENV_NAMES.includes(variable) == false) {
            extraEnv[variable] = value;
        }
    }

    const answers: DbSetupAnswers = {
        name: name,
        // The one driver the server accepts; reading DB_DRIVER back comes with the second one
        driver: "postgres",
        host: connection.host,
        port: connection.port,
        database: connection.database,
        user: connection.user,
        password: connection.password,
        ssl: connection.ssl,
        sslCaPath: env[DB_ENV.SSL_CA],
        description: env[DB_ENV.DESCRIPTION],
        sshAuth: sshAuth,
        sshKeyPath: env[DB_ENV.SSH_KEY],
        sshPassphrase: env[DB_ENV.SSH_PASSPHRASE],
        sshPassword: env[DB_ENV.SSH_PASSWORD],
        readonly: isTruthy(env[DB_ENV.READONLY]),
        allowDdl: isFalsy(env[DB_ENV.ALLOW_DDL]) == false,
        extraEnv: extraEnv,
    };

    const sshHost = env[DB_ENV.SSH_HOST];
    if(sshHost != null) {
        answers.sshHost = sshHost;
        answers.sshPort = readPort(env[DB_ENV.SSH_PORT], DEFAULT_SSH_PORT);
        answers.sshUser = env[DB_ENV.SSH_USER];
        answers.sshHostKeyFingerprint = env[DB_ENV.SSH_HOST_KEY];
    }

    return answers;
}

/** One row of the database list: endpoint, route, and the policy settings in force. */
export function summarizeEntry(entry: McpServerEntry): { endpoint: string; route: string; notes: string } {
    const env = entry.env;
    const connection = readConnection(env);

    let route = "direct";
    const sshHost = env[DB_ENV.SSH_HOST];
    if(sshHost != null) {
        const sshUser = env[DB_ENV.SSH_USER] ?? "?";
        const sshPort = env[DB_ENV.SSH_PORT] ?? String(DEFAULT_SSH_PORT);
        route = `ssh ${sshUser}@${sshHost}:${sshPort}`;
    }

    const notes: string[] = [];
    if(isTruthy(env[DB_ENV.READONLY]) == true) {
        notes.push("readonly");
    }
    if(isFalsy(env[DB_ENV.ALLOW_DDL]) == true) {
        notes.push("no ddl");
    }
    if(connection.ssl !== "require") {
        notes.push(`ssl ${connection.ssl}`);
    }
    if(env[DB_ENV.SSH_HOST_KEY] != null) {
        notes.push("pinned");
    }

    let endpoint = `${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
    if(connection.host === "") {
        endpoint = "?";
    }

    return {
        endpoint: endpoint,
        route: route,
        notes: notes.join(", "),
    };
}
