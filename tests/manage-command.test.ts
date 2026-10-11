import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import ssh2 from "ssh2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConfigTarget, McpServerEntry } from "@/_types";
import { runConfigCommand } from "@/modules/manage";
import { createJsonFileTarget } from "@/modules/manage/targets/json-file";
import { toHostKeyFingerprint } from "@/modules/tunnel/ssh-tunnel";
import { startPgliteServer, type PgliteServer } from "./support/pglite-server";

// The whole `config` command driven over scripted stdin, against a real PostgreSQL backend
// (PGlite) — directly, and through a fake SSH server that forwards TCP to it.

const { Server, utils } = ssh2;

/** An unrelated server and setting the manager must never disturb. */
const SEED_DOCUMENT = {
    theme: "dark",
    mcpServers: {
        ssh: { command: "npx", args: ["-y", "@akms/mcp-ssh"], env: { SSH_HOST: "10.0.0.5", SSH_USER: "deploy" } },
    },
};

let database: PgliteServer;
let sshServer: ssh2.Server;
let sshPort = 0;
let sshFingerprint = "";
/** A port nothing listens on — a database that refuses the connection. */
let closedPort = 0;

let workDirectory = "";
let configPath = "";
let target: ConfigTarget;

beforeAll(async () => {
    database = await startPgliteServer();

    const hostKey = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "pkcs1", format: "pem" },
    }).privateKey;
    const parsedKey = utils.parseKey(hostKey);
    if(parsedKey instanceof Error) {
        throw parsedKey;
    }
    sshFingerprint = toHostKeyFingerprint(parsedKey.getPublicSSH());

    // Accepts any credentials and forwards every direct-tcpip channel to the local PGlite —
    // the shape of a bastion in front of a database.
    sshServer = new Server({ hostKeys: [hostKey] }, (client) => {
        client.on("authentication", (context) => {
            context.accept();
        });
        client.on("tcpip", (accept, _reject, info) => {
            const channel = accept();
            const socket = net.connect(info.destPort, "127.0.0.1");
            channel.pipe(socket).pipe(channel);
            socket.on("error", () => {
                channel.end();
            });
        });
        client.on("error", () => {
            // A client closing right after the handshake must not crash the server.
        });
    });
    sshPort = await new Promise<number>((resolve) => {
        sshServer.listen(0, "127.0.0.1", () => {
            resolve((sshServer.address() as AddressInfo).port);
        });
    });

    const probe = net.createServer();
    closedPort = await new Promise<number>((resolve) => {
        probe.listen(0, "127.0.0.1", () => {
            resolve((probe.address() as AddressInfo).port);
        });
    });
    await new Promise<void>((resolve) => {
        probe.close(() => {
            resolve();
        });
    });
}, 30000);

afterAll(async () => {
    await new Promise<void>((resolve) => {
        sshServer.close(() => {
            resolve();
        });
    });
    await database?.stop();
});

beforeEach(() => {
    workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-db-config-"));
    configPath = path.join(workDirectory, "mcp.json");
    fs.writeFileSync(configPath, `${JSON.stringify(SEED_DOCUMENT, null, 2)}\n`);
    target = createJsonFileTarget({ id: "cursor", label: "Test client", filePath: configPath });
});

afterEach(() => {
    fs.rmSync(workDirectory, { recursive: true, force: true });
});

/** Drives the manager with the given keystrokes, one answer per line, and returns its screen. */
async function runScript(lines: string[]): Promise<{ exitCode: number; screen: string }> {
    const input = new PassThrough();
    const output = new PassThrough();

    let screen = "";
    output.on("data", (chunk: Buffer) => {
        screen += chunk.toString();
    });

    input.end(lines.map((line) => `${line}\n`).join(""));

    const exitCode = await runConfigCommand({ input: input, output: output, targets: [target] });
    return { exitCode: exitCode, screen: screen };
}

function readDocument(): { theme: string; mcpServers: Record<string, McpServerEntry> } {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function seedDatabase(name: string, env: Record<string, string>): void {
    const document = readDocument();
    document.mcpServers[name] = { command: "npx", args: ["-y", "@akms/mcp-db"], env: env };
    fs.writeFileSync(configPath, JSON.stringify(document, null, 2));
}

/** The split variables that reach PGlite directly. */
const DIRECT_ENV = {
    DB_DRIVER: "postgres",
    DB_HOST: "127.0.0.1",
    DB_NAME: "postgres",
    DB_USER: "postgres",
    DB_SSL: "off",
};

describe("config — adding a database", () => {
    it("fills the settings form, checks the connection and writes the entry", async () => {
        const { exitCode, screen } = await runScript([
            "a",                                // main menu → add
            "host", "127.0.0.1",                // pick a setting, then its value
            "port", String(database.port),
            "database", "postgres",
            "user", "postgres",
            "ssl", "off",                       // PGlite speaks plain text
            "description", "Test box",
            "readonly",                         // a toggle — no value to type
            "ddl",
            "save",
            "",                                 // test before saving? yes
            "",                                 // write it? yes
            "q",
        ]);

        expect(exitCode).toBe(0);
        expect(screen).toContain("OK      db   PostgreSQL");

        const document = readDocument();
        expect(document.mcpServers.pg_postgres.env).toEqual({
            ...DIRECT_ENV,
            DB_PORT: String(database.port),
            DB_DESCRIPTION: "Test box",
            DB_READONLY: "true",
            DB_ALLOW_DDL: "false",
        });
        expect(document.theme).toBe("dark");
        expect(document.mcpServers.ssh).toEqual(SEED_DOCUMENT.mcpServers.ssh);
    }, 30000);

    it("lists every setting with its value, required ones marked", async () => {
        // The driver row opens a select with the one driver there is, and comes back unchanged
        const { screen } = await runScript(["a", "driver", "postgres", "database", "shop", "cancel", "y", "q"]);

        expect(screen).toMatch(/Driver {12}PostgreSQL/);
        expect(screen).toMatch(/Host {14}\(required\)/);
        expect(screen).toMatch(/Database {10}\(required\)/);
        expect(screen).toMatch(/Database {10}shop/);
        expect(screen).toMatch(/Server name {7}pg_shop/);
        expect(screen).toMatch(/Port {14}5432/);
        expect(screen).toMatch(/SSL {15}require/);
        expect(screen).toMatch(/Route {13}Directly/);
        expect(screen).toMatch(/Read-only {9}no/);
        expect(screen).toMatch(/DDL {15}allowed/);
    });

    it("refuses to save while a required setting is empty, and moves to it", async () => {
        const { screen } = await runScript(["a", "save", "cancel", "q"]);

        expect(screen).toContain("Fill in Host, Database, User");
        expect(readDocument().mcpServers).toEqual(SEED_DOCUMENT.mcpServers);
    });

    it("tunnels through the SSH host, pins its key and writes the tunnel variables", async () => {
        const { screen } = await runScript([
            "a",
            "host", "127.0.0.1",
            "port", String(database.port),
            "database", "postgres",
            "user", "postgres",
            "ssl", "off",
            "route", "ssh", "127.0.0.1", "tester",   // choosing the route asks for the SSH host and user
            "ssh-port", String(sshPort),
            "ssh-auth", "password", "secret-pw",     // a switch to password asks for it right away
            "save",
            "",                                      // test before saving? yes
            "",                                      // pin this SSH host key? yes
            "",                                      // write it? yes
            "q",
        ]);

        expect(screen).toContain("OK      ssh  tester@127.0.0.1");
        expect(screen).toContain("OK      db   PostgreSQL");

        expect(readDocument().mcpServers.pg_postgres.env).toEqual({
            ...DIRECT_ENV,
            DB_PORT: String(database.port),
            DB_SSH_HOST: "127.0.0.1",
            DB_SSH_PORT: String(sshPort),
            DB_SSH_USER: "tester",
            DB_SSH_PASSWORD: "secret-pw",
            DB_SSH_HOST_KEY: sshFingerprint,
        });
    }, 30000);

    it("asks before discarding changes, and leaves an untouched form at once", async () => {
        const { screen } = await runScript([
            "a", "host", "10.0.0.9",
            "cancel", "n",                            // discard? no → back in the form
            "cancel", "y",                            // discard? yes
            "q",
        ]);

        expect(screen.match(/Discard the changes\?/g)?.length).toBe(2);
        expect(screen).toContain("nothing was written");
        expect(readDocument().mcpServers).toEqual(SEED_DOCUMENT.mcpServers);
    });

    it("never shows the password in the preview", async () => {
        const { screen } = await runScript([
            "a",
            "host", "127.0.0.1", "database", "postgres", "user", "postgres", "password", "db-secret",
            "save",
            "n",   // test before saving? no
            "n",   // write it? no
        ]);

        expect(screen).toContain("\"DB_PASSWORD\": \"********\"");
        expect(screen).not.toContain("db-secret");
        expect(readDocument().mcpServers.pg_postgres).toBeUndefined();
    });

    it("writes nothing when the check fails and the operator discards", async () => {
        const { screen } = await runScript([
            "a",
            "host", "127.0.0.1", "port", String(closedPort), "database", "postgres", "user", "postgres", "name", "dead",
            "save",
            "",          // test before saving? yes
            "discard",   // the check failed, what now? → discard
            "q",
        ]);

        expect(screen).toContain("FAILED  db   127.0.0.1");
        expect(screen).toContain("nothing was written");
        expect(readDocument().mcpServers.dead).toBeUndefined();
    }, 30000);

    it("Esc in a text field leaves the setting as it was", async () => {
        const { screen } = await runScript([
            "a",
            "host", "\u001b",          // open Host, then Esc
            "host", "10.0.0.9",
            "cancel", "y",
            "q",
        ]);

        expect(screen).toMatch(/Host {14}\(required\)/);
        expect(screen).toMatch(/Host {14}10\.0\.0\.9/);
        expect(screen).not.toContain("\u001b");
        expect(readDocument().mcpServers).toEqual(SEED_DOCUMENT.mcpServers);
    });

    it("Esc at a follow-up question undoes the choice that asked it", async () => {
        const { screen } = await runScript([
            "a",
            "route", "ssh", "\u001b",  // the route asks for the SSH host; Esc there
            "cancel",                  // an untouched form leaves without asking
            "q",
        ]);

        expect(screen).not.toMatch(/SSH host {8}\(required\)/);
        expect(screen).not.toContain("Discard the changes?");
        expect(screen).toContain("nothing was written");
    });

    it("Esc at the save preview reopens the form on the same values", async () => {
        await runScript([
            "a",
            "host", "127.0.0.1", "database", "postgres", "user", "postgres",
            "save", "n",               // test before saving? no → preview
            "\u001b",                  // write it? Esc → back in the form
            "name", "renamed",
            "save", "n", "",           // write it? yes
            "q",
        ]);

        const servers = readDocument().mcpServers;
        expect(servers.pg_postgres).toBeUndefined();
        expect(servers.renamed.env).toMatchObject({ DB_HOST: "127.0.0.1", DB_NAME: "postgres", DB_USER: "postgres" });
    });

    it("re-asks a server name that could not be part of a tool name", async () => {
        const { screen } = await runScript([
            "a",
            "host", "127.0.0.1", "database", "postgres", "user", "postgres", "name", "my.db", "ok_name",
            "save", "n", "",
            "q",
        ]);

        expect(screen).toContain("Use letters, digits");
        expect(readDocument().mcpServers.ok_name).toBeDefined();
    });
});

describe("config — managing existing databases", () => {
    it("lists only this package's servers and counts the rest", async () => {
        seedDatabase("pg_prod", { DB_DRIVER: "postgres", DB_HOST: "10.0.0.5", DB_NAME: "akms", DB_USER: "app_user", DB_READONLY: "true" });

        const { screen } = await runScript(["q"]);

        expect(screen).toMatch(/1\) pg_prod {2}app_user@10\.0\.0\.5:5432\/akms +direct · readonly/);
        expect(screen).toContain("1 other MCP server(s)");
        expect(screen).not.toMatch(/\d\) ssh/);
    });

    it("renames on edit: the new name is written and the old one removed, hand-set variables kept", async () => {
        seedDatabase("pg_old", { DB_DRIVER: "postgres", DB_HOST: "10.0.0.5", DB_NAME: "akms", DB_USER: "app_user", DB_ALIAS: "prod", DB_MAX_ROWS: "50" });

        await runScript([
            "pg_old",                  // pick the database by name
            "e",                       // → edit: its settings open
            "name", "pg_new",          // change just the name
            "save",
            "n",                       // test before saving? no
            "",                        // write it? yes
            "q",
        ]);

        const servers = readDocument().mcpServers;
        expect(servers.pg_old).toBeUndefined();
        expect(servers.pg_new.env).toEqual({
            DB_DRIVER: "postgres",
            DB_HOST: "10.0.0.5",
            DB_NAME: "akms",
            DB_USER: "app_user",
            DB_ALIAS: "prod",
            DB_MAX_ROWS: "50",
        });
    });

    it("rewrites a DB_URL entry split on edit", async () => {
        seedDatabase("pg_shop", { DB_DRIVER: "postgres", DB_URL: "postgres://alice:pw@10.0.0.9:5433/shop?sslmode=disable" });

        await runScript(["1", "e", "description", "the shop", "save", "n", "", "q"]);

        expect(readDocument().mcpServers.pg_shop.env).toEqual({
            DB_DRIVER: "postgres",
            DB_HOST: "10.0.0.9",
            DB_PORT: "5433",
            DB_NAME: "shop",
            DB_USER: "alice",
            DB_PASSWORD: "pw",
            DB_SSL: "off",
            DB_DESCRIPTION: "the shop",
        });
    });

    it("pins an unpinned SSH host from the check, adding just that one variable", async () => {
        seedDatabase("pg_test", {
            ...DIRECT_ENV,
            DB_PORT: String(database.port),
            DB_SSH_HOST: "127.0.0.1", DB_SSH_PORT: String(sshPort), DB_SSH_USER: "tester", DB_SSH_PASSWORD: "pw",
        });

        await runScript(["1", "c", "", "q"]);   // database 1 → check → pin? yes

        const entry = readDocument().mcpServers.pg_test;
        expect(entry.command).toBe("npx");
        expect(entry.env).toEqual({
            ...DIRECT_ENV,
            DB_PORT: String(database.port),
            DB_SSH_HOST: "127.0.0.1", DB_SSH_PORT: String(sshPort), DB_SSH_USER: "tester", DB_SSH_PASSWORD: "pw",
            DB_SSH_HOST_KEY: sshFingerprint,
        });
    }, 30000);

    it("reports an entry the server would refuse instead of connecting with it", async () => {
        seedDatabase("pg_bad", { DB_DRIVER: "postgres", DB_HOST: "h", DB_NAME: "d", DB_USER: "u", DB_READONLY: "ture" });

        const { screen } = await runScript(["1", "c", "q"]);

        expect(screen).toContain("The server would refuse to start with this entry: DB_READONLY must be one of");
    });

    it("prints the entry in every form, ready to paste", async () => {
        seedDatabase("pg_prod", { DB_DRIVER: "postgres", DB_HOST: "10.0.0.5", DB_NAME: "akms", DB_USER: "app_user", DB_PASSWORD: "pw" });

        const { screen } = await runScript(["1", "p", "q"]);   // database 1 → print

        expect(screen).toContain("\"pg_prod\": {");
        expect(screen).toContain("[mcp_servers.pg_prod.env]");
        expect(screen).toContain("claude mcp add-json pg_prod '{\"type\":\"stdio\"");
        expect(screen).toContain("\"DB_PASSWORD\":\"pw\"");
    });

    it("removes a database only after confirmation", async () => {
        seedDatabase("pg_a", { DB_DRIVER: "postgres", DB_HOST: "10.0.0.5", DB_NAME: "a", DB_USER: "u" });
        seedDatabase("pg_b", { DB_DRIVER: "postgres", DB_HOST: "10.0.0.6", DB_NAME: "b", DB_USER: "u" });

        await runScript([
            "2", "r", "n",             // pg_b → remove → no
            "pg_a", "r", "y",          // pg_a → remove → yes
            "q",
        ]);

        const servers = readDocument().mcpServers;
        expect(servers.pg_a).toBeUndefined();
        expect(servers.pg_b).toBeDefined();
        expect(servers.ssh).toBeDefined();
    });

    it("Esc at the remove confirmation returns to the database's menu", async () => {
        seedDatabase("pg_a", { DB_DRIVER: "postgres", DB_HOST: "10.0.0.5", DB_NAME: "a", DB_USER: "u" });

        const { screen } = await runScript(["1", "r", "\u001b", "b", "q"]);   // remove? Esc → menu again → back

        expect(screen.match(/Check the connection/g)?.length).toBe(2);
        expect(readDocument().mcpServers.pg_a).toBeDefined();
    });

    it("refuses to touch a file it cannot parse", async () => {
        fs.writeFileSync(configPath, "{ \"mcpServers\": ");

        const { exitCode, screen } = await runScript(["a", "q"]);

        expect(exitCode).toBe(0);
        expect(screen).toContain("Cannot read it");
        expect(fs.readFileSync(configPath, "utf8")).toBe("{ \"mcpServers\": ");
    });

    it("treats input running out as leaving", async () => {
        const { exitCode } = await runScript([]);

        expect(exitCode).toBe(0);
    });
});
