import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

// PGlite is a real PostgreSQL backend compiled to WASM, served here over the wire protocol.
// Every client connection is multiplexed onto ONE backend session, so tests that depend on
// per-connection session isolation belong in the MCP_DB_TEST_URL integration file instead.

export interface PgliteServer {
    port: number;
    /** `postgres://postgres@127.0.0.1:<port>/postgres` — no password, no TLS. */
    url: string;
    stop(): Promise<void>;
}

/** One server per test file: vitest runs files in parallel, and they would share the one session. */
export async function startPgliteServer(): Promise<PgliteServer> {
    const database = await PGlite.create();
    const server = new PGLiteSocketServer({ db: database, port: 0, host: "127.0.0.1", maxConnections: 8 });
    await server.start();
    // "127.0.0.1:54321" once listening on the OS-assigned port
    const port = Number(server.getServerConn().split(":")[1]);
    return {
        port: port,
        url: `postgres://postgres@127.0.0.1:${port}/postgres`,
        async stop() {
            await server.stop();
            await database.close();
        },
    };
}
