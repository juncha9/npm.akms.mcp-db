import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("cold process memory", () => {
    it("keeps configured startup light, then initializes the real parser and tunnel safely", () => {
        const entry = new URL("../src/index.ts", import.meta.url).href;
        const script = `
            import assert from "node:assert/strict";
            import { createRequire } from "node:module";
            import { sep } from "node:path";
            const require = createRequire(process.cwd() + "/package.json");
            const loaded = name => Object.keys(require.cache).some(file => file.includes(sep + name + sep));
            const api = await import(${JSON.stringify(entry)});
            const instance = api.createDbMcpServer({ DB_DRIVER: "postgres", DB_URL: "postgres://memory:memory@127.0.0.1:1/memory", DB_SSL: "off" });
            try {
                assert.equal(loaded("libpg-query"), false);
                assert.equal(loaded("ssh2"), false);
                assert(process.memoryUsage().external < 64 * 1024 * 1024, "idle startup allocated WASM memory");
                await assert.rejects(api.parseStatements("   "), /no SQL/);
                assert.equal(loaded("libpg-query"), false);
                const results = await Promise.all(Array.from({ length: 8 }, (_, i) => api.parseStatements("SELECT " + i)));
                assert(results.every(statements => statements[0].kind === "SelectStmt"));
                // Even after use, WASM belongs to a retireable worker, not this isolate.
                assert.equal(loaded("libpg-query"), false);
                assert.equal(loaded("ssh2"), false);
                await assert.rejects(api.parseStatements("SELEC 1"), /syntax error/);
                const dangerous = await api.parseStatements("DELETE FROM example");
                assert.equal(api.checkStatements(dangerous, instance.profile.policy, false).allowed, false);

                const tunnel = new api.SshTunnel({ host: "127.0.0.1", port: 1, username: "memory", password: "memory" }, 1000);
                const first = tunnel.connect();
                const second = tunnel.connect();
                tunnel.close();
                const attempts = await Promise.allSettled([first, second]);
                assert(attempts.every(result => result.status === "rejected" && /closed/.test(result.reason.message)));
                assert.equal(loaded("ssh2"), true);
                console.log("passed");
            } finally {
                await instance.shutdown();
                await instance.server.close();
            }
        `;
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DB_|SSH_|NODE_OPTIONS$)/i.test(key)));
        const result = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            env: { ...env, DB_MCP_LOG_LEVEL: "silent" },
            encoding: "utf8", timeout: 20000, windowsHide: true,
        });
        expect(result.trim()).toBe("passed");
    }, 25000);
});
