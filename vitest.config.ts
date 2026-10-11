import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
    resolve: {
        alias: {
            "@": path.resolve(import.meta.dirname, "src"),
        },
    },
    test: {
        include: ["tests/**/*.test.ts"],
        environment: "node",
        // the server logs to stderr; tests read results, not log lines
        env: { DB_MCP_LOG_LEVEL: "silent" },
    },
});
