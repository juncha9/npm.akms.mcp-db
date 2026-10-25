import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DB_ENV, LOG_LEVEL_ENV, SERVER_NAME, SERVER_VERSION, SHUTDOWN_DEADLINE_MS } from "@/_defs";
import type { DbProfile } from "@/_types";
import { $logger } from "@/_libs/logger";
import { describeError } from "@/_libs/text";
import { runConfigCommand, runConnectionCheck } from "@/modules/manage";
import { loadDbProfile } from "@/modules/profile";
import { createDbCatalogServer, createDbMcpServer } from "./server";

const HELP_TEXT = [
    `${SERVER_NAME} ${SERVER_VERSION} — MCP server for one database, directly or through an SSH tunnel`,
    "",
    "Usage:",
    "  akms-mcp-db [--check]",
    "  akms-mcp-db --catalog            Load database connections from the shared registry",
    "  akms-mcp-db config [--target <client>]",
    "  akms-mcp-db register          Register AI services for all AKMS connections",
    "  akms-mcp-db sync              Review differences and retry pending changes",
    "",
    "Commands:",
    "  config               Manage the databases in the shared AKMS catalog —",
    "                       list, add, edit, remove, check, print. Asks plain questions,",
    "                       so the DB_* names below never have to be typed.",
    "",
    "Options:",
    "      --check          Connect (SSH first, then the database), report each step, and exit.",
    "                       Prints the SSH host key fingerprint so it can be pinned.",
    "      --target <id>    config: claude-code | codex | claude-desktop | cursor",
    "                       (preselects a service in Register; saves apply to all registered services)",
    "  -v, --version        Print the version and exit",
    "  -h, --help           Print this help and exit",
    "",
    "Environment — one server entry per database, set in the MCP client's env block:",
    `  ${DB_ENV.DRIVER}             postgres  (required)`,
    `  ${DB_ENV.URL}                postgres://user:password@host:port/database  — or the next five`,
    `  ${DB_ENV.HOST} / ${DB_ENV.PORT} / ${DB_ENV.NAME} / ${DB_ENV.USER} / ${DB_ENV.PASSWORD}`,
    `  ${DB_ENV.SSL}                require | verify | off  (default require — through a tunnel too)`,
    `  ${DB_ENV.SSL_CA}             CA bundle path for ssl=verify`,
    `  ${DB_ENV.ALIAS}              Name shown to the model; default <database>@<host>`,
    `  ${DB_ENV.DESCRIPTION}        Shown to the model — say what the database is for`,
    `  ${DB_ENV.SSH_HOST} / ${DB_ENV.SSH_PORT} / ${DB_ENV.SSH_USER}   SSH hop; the database host is resolved on it`,
    `  ${DB_ENV.SSH_KEY}            Private key path, '~' expanded  (or ${DB_ENV.SSH_PASSWORD}, or the SSH agent)`,
    `  ${DB_ENV.SSH_PASSPHRASE}     Key passphrase`,
    `  ${DB_ENV.SSH_HOST_KEY}       Pinned host key, 'SHA256:…'; a mismatch aborts the connection`,
    `  ${DB_ENV.READONLY}           Only reads, in BEGIN READ ONLY … ROLLBACK  (default false)`,
    `  ${DB_ENV.ALLOW_DDL}          Allow CREATE / ALTER / DROP …  (default true)`,
    `  ${DB_ENV.DENY_PATTERNS}      Comma-separated extra deny regexes, tested per statement`,
    `  ${DB_ENV.STATEMENT_TIMEOUT_MS} / ${DB_ENV.CONNECT_TIMEOUT_MS} / ${DB_ENV.MAX_ROWS} / ${DB_ENV.MAX_OUTPUT_CHARACTERS}`,
    `  ${LOG_LEVEL_ENV}     silent | debug | info | warn | error  (default info, written to stderr)`,
    "",
    "The server speaks MCP over stdio; run it from an MCP client, not interactively.",
    "Catalog: ~/.akms/mcp/registry.json (or $AKMS_MCP_HOME/registry.json) stores settings and passwords in plaintext.",
].join("\n");

interface CliArguments {
    showHelp: boolean;
    showVersion: boolean;
    checkOnly: boolean;
    catalogMode: boolean;
    /** `config` as the first argument opens the database manager instead of the server. */
    configMode: boolean;
    managementMode?: "config" | "register" | "sync";
    /** `--target <id>` — the client `config` opens on. */
    targetId?: string;
}

function parseArguments(argv: string[]): CliArguments {
    const parsed: CliArguments = { showHelp: false, showVersion: false, checkOnly: false, configMode: false, catalogMode: false };

    let rest = argv;
    if(["config", "register", "sync"].includes(argv[0])) {
        parsed.configMode = true;
        parsed.managementMode = argv[0] as "config" | "register" | "sync";
        rest = argv.slice(1);
    }

    for(let index = 0; index < rest.length; index += 1) {
        const argument = rest[index];
        if(argument === "--catalog") { parsed.catalogMode = true; continue; }
        if(argument === "--target") {
            parsed.targetId = rest[index + 1];
            index += 1;
            continue;
        }
        if(argument.startsWith("--target=") == true) {
            parsed.targetId = argument.slice("--target=".length);
            continue;
        }
        if(argument === "--help" || argument === "-h") {
            parsed.showHelp = true;
            continue;
        }
        if(argument === "--version" || argument === "-v") {
            parsed.showVersion = true;
            continue;
        }
        if(argument === "--check") {
            parsed.checkOnly = true;
            continue;
        }
    }
    if(parsed.catalogMode && (parsed.checkOnly || parsed.configMode || parsed.targetId !== undefined)) throw new Error("--catalog cannot be combined with --check, management commands or --target.");
    return parsed;
}

/**
 * `--check`: connects the way the server will and reports each hop. The report itself is
 * shared with `config`, so a database that passes setup passes `--check`.
 *
 * @returns Process exit code: 0 when every hop answered.
 */
async function runCheckCommand(profile: DbProfile | null): Promise<number> {
    if(profile == null) {
        process.stdout.write(`No database is registered — set ${DB_ENV.DRIVER} and ${DB_ENV.URL} (or ${DB_ENV.HOST} / ${DB_ENV.NAME} / ${DB_ENV.USER}), or run: akms-mcp-db config\n`);
        return 1;
    }

    const result = await runConnectionCheck(profile, process.stdout);
    if(result.connected == true) {
        return 0;
    }
    return 1;
}

async function main(): Promise<void> {
    const _logger = $logger.child({ context: "cli" });
    const cliArguments = parseArguments(process.argv.slice(2));
    if(cliArguments.showHelp == true) {
        process.stderr.write(`${HELP_TEXT}\n`);
        return;
    }
    if(cliArguments.showVersion == true) {
        process.stderr.write(`${SERVER_VERSION}\n`);
        return;
    }
    if(cliArguments.configMode == true) {
        // The manager is a terminal UI: log lines on stderr would land in the middle of a
        // prompt. Warnings stay — a missing key file is worth seeing during setup.
        if(process.env[LOG_LEVEL_ENV] == null) {
            process.env[LOG_LEVEL_ENV] = "warn";
        }
        const exitCode = await runConfigCommand({
            input: process.stdin,
            output: process.stdout,
            targetId: cliArguments.targetId,
            mode: cliArguments.managementMode,
        });
        process.exit(exitCode);
    }

    if(cliArguments.checkOnly == true) {
        if(process.env[LOG_LEVEL_ENV] == null) {
            process.env[LOG_LEVEL_ENV] = "silent";
        }
        const exitCode = await runCheckCommand(loadDbProfile());
        process.exit(exitCode);
    }

    const instance = cliArguments.catalogMode ? createDbCatalogServer() : createDbMcpServer();

    // Last line of defense for a failure no handler owns: an MCP client does not restart a dead
    // server, and pg-pool already discards a connection that errored, so staying up is the safer state
    process.on("uncaughtException", (error) => {
        // Thrown inside pg's message parser, it leaves a connection stopped mid-protocol — its call would never answer
        const cutConnections = instance.abortActiveConnections?.(error) ?? instance.driver?.abortActiveConnections(error) ?? 0;
        _logger.error(error, "uncaught exception; the server keeps running", { cut_connections: cutConnections });
    });
    process.on("unhandledRejection", (reason) => {
        _logger.error(reason, "unhandled rejection; the server keeps running");
    });

    let shuttingDown = false;
    const shutdown = (signal: string) => {
        if(shuttingDown == true) {
            return;
        }
        shuttingDown = true;
        _logger.info("shutting down", { signal: signal });
        // pool.end() waits for sockets to close; through a tunnel that is already gone they may never. unref: a
        // shutdown that finishes earlier exits through its own process.exit, not through this timer
        setTimeout(() => {
            _logger.warn("shutdown did not finish in time; exiting anyway", { deadline_ms: SHUTDOWN_DEADLINE_MS });
            process.exit(0);
        }, SHUTDOWN_DEADLINE_MS).unref();
        void instance.shutdown()
            .catch((error) => {
                _logger.error(error, "shutdown failed");
            })
            .finally(() => {
                void instance.server.close().finally(() => {
                    process.exit(0);
                });
            });
    };
    process.on("SIGINT", () => {
        shutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
        shutdown("SIGTERM");
    });
    process.stdin.on("close", () => {
        shutdown("stdin-close");
    });

    const transport = new StdioServerTransport();
    await instance.server.connect(transport);
    // The pid is what an operator needs to find this server among a client's processes
    _logger.info("mcp server ready on stdio", {
        server: SERVER_NAME,
        version: SERVER_VERSION,
        profile: instance.profile?.name ?? null,
        pid: process.pid,
        ...("connectionCount" in instance ? { connections: instance.connectionCount } : {}),
    });
}

main().catch((error) => {
    const _logger = $logger.child({ context: "cli" });
    _logger.error(error, "mcp server failed to start");
    process.stderr.write(`akms-mcp-db: ${describeError(error)}\n`);
    process.exit(1);
});
