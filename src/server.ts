import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "@/_defs";
import type { DbProfile } from "@/_types";
import type { EnvSource } from "@/_libs/env";
import { $logger } from "@/_libs/logger";
import { PostgresDriver } from "@/modules/postgres/postgres-driver";
import { loadDbProfile } from "@/modules/profile";
import { registerAllTools } from "@/modules/tools/register-tools";

export const SERVER_INSTRUCTIONS = [
    "This server runs SQL against one PostgreSQL database — directly or through an SSH tunnel, as configured in this server's own environment.",
    "There is no database or host argument; db_list_hosts shows which database this is and what its policy permits. Call it before assuming anything about access.",
    "",
    "Tools: db_query (run SQL), db_schemas, db_tables, db_describe (structure), db_explain (plans).",
    "Look before you write: db_describe a table before changing its rows or its shape.",
    "",
    "Transactions: the statements of one db_query call run in one transaction — committed together, or all rolled back when one fails. Don't send BEGIN or COMMIT; pass transaction: false when a statement must run outside a transaction (CREATE INDEX CONCURRENTLY, VACUUM).",
    "Rows: each statement returns up to the profile's row limit; when there are more, say what you are looking for with WHERE / LIMIT instead of paging. A SELECT stops reading one row past the limit; a write with RETURNING runs in full and reports its count.",
    "",
    "Refused on every database: TRUNCATE, UPDATE or DELETE without WHERE (inside WITH too), DROP DATABASE / SCHEMA / TABLESPACE, DROP OWNED, ALTER SYSTEM, COPY … PROGRAM. A read-only database refuses every write and every function whose effect outlives a rollback (pg_terminate_backend, replication slots, …) or lifts its time limit (set_config of statement_timeout), and runs reads inside BEGIN READ ONLY … ROLLBACK.",
    "'Refused by the guard' is a policy decision, not a transient failure — do not rephrase the statement to slip past it; report it and ask. 'SQL syntax error' and 'Not supported by this tool' are not policy: fix or rewrite the statement and send it again.",
    "COPY … FROM STDIN / TO STDOUT is not supported — read with SELECT and write with INSERT.",
    "",
    "You still carry the judgement the guard does not: dropping or renaming tables and columns, changing a column's type, adding NOT NULL, and bulk updates are allowed by the tool but deserve the operator's confirmation first.",
].join("\n");

export interface DbMcpServerInstance {
    server: McpServer;
    profile: DbProfile | null;
    driver: PostgresDriver | null;
    shutdown(): Promise<void>;
}

/** Builds the MCP server for the database configured in `env`. Throws on a malformed configuration. */
export function createDbMcpServer(env: EnvSource = process.env): DbMcpServerInstance {
    const _logger = $logger.child({ context: "createDbMcpServer" });
    const profile = loadDbProfile(env);

    let driver: PostgresDriver | null = null;
    if(profile != null) {
        driver = new PostgresDriver(profile);
    }

    const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { instructions: SERVER_INSTRUCTIONS }
    );
    registerAllTools(server, { profile: profile, driver: driver });
    _logger.info("mcp server built", { profile: profile?.name ?? null });

    return {
        server: server,
        profile: profile,
        driver: driver,
        async shutdown() {
            await driver?.close();
        },
    };
}
