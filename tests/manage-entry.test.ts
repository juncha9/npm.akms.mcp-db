import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DbSetupAnswers } from "@/_types";
import { answersToEntry, entryToAnswers, isOurEntry, summarizeEntry } from "@/modules/manage/entry";
import { loadDbProfile } from "@/modules/profile";

function createAnswers(overrides?: Partial<DbSetupAnswers>): DbSetupAnswers {
    return {
        name: "pg_akms",
        driver: "postgres",
        host: "10.0.0.5",
        port: 5432,
        database: "akms",
        user: "app_user",
        ssl: "require",
        sshAuth: "agent",
        readonly: false,
        allowDdl: true,
        extraEnv: {},
        ...overrides,
    };
}

describe("answersToEntry — what gets written", () => {
    it("writes the driver and the split connection, nothing equal to a default", () => {
        const entry = answersToEntry(createAnswers());

        expect(entry.env).toEqual({ DB_DRIVER: "postgres", DB_HOST: "10.0.0.5", DB_NAME: "akms", DB_USER: "app_user" });
    });

    it("launches the package through npx, behind cmd /c on Windows", () => {
        const entry = answersToEntry(createAnswers());

        if(process.platform === "win32") {
            expect(entry.command).toBe("cmd");
            expect(entry.args).toEqual(["/c", "npx", "-y", "@akms/mcp-db"]);
        }
        else {
            expect(entry.command).toBe("npx");
            expect(entry.args).toEqual(["-y", "@akms/mcp-db"]);
        }
    });

    it("writes every answered setting under its variable", () => {
        const entry = answersToEntry(createAnswers({
            port: 15432,
            password: "db-secret",
            ssl: "verify",
            sslCaPath: "~/certs/rds.pem",
            description: "production",
            sshHost: "203.0.113.5",
            sshPort: 20022,
            sshUser: "ubuntu",
            sshAuth: "key",
            sshKeyPath: "~/.ssh/bastion.pem",
            sshPassphrase: "phrase",
            sshHostKeyFingerprint: "SHA256:bastion",
            readonly: true,
            allowDdl: false,
        }));

        expect(entry.env).toEqual({
            DB_DRIVER: "postgres",
            DB_HOST: "10.0.0.5",
            DB_PORT: "15432",
            DB_NAME: "akms",
            DB_USER: "app_user",
            DB_PASSWORD: "db-secret",
            DB_SSL: "verify",
            DB_SSL_CA: "~/certs/rds.pem",
            DB_DESCRIPTION: "production",
            DB_SSH_HOST: "203.0.113.5",
            DB_SSH_PORT: "20022",
            DB_SSH_USER: "ubuntu",
            DB_SSH_KEY: "~/.ssh/bastion.pem",
            DB_SSH_PASSPHRASE: "phrase",
            DB_SSH_HOST_KEY: "SHA256:bastion",
            DB_READONLY: "true",
            DB_ALLOW_DDL: "false",
        });
    });

    it("writes the CA bundle only with ssl=verify — the server refuses it otherwise", () => {
        const entry = answersToEntry(createAnswers({ ssl: "require", sslCaPath: "~/certs/rds.pem" }));

        expect(entry.env.DB_SSL_CA).toBeUndefined();
        expect(() => loadDbProfile(entry.env)).not.toThrow();
    });

    it("drops the credentials of an SSH auth method no longer chosen", () => {
        const entry = answersToEntry(createAnswers({
            sshHost: "bastion", sshUser: "ubuntu",
            sshAuth: "password", sshPassword: "pw", sshKeyPath: "~/.ssh/id_rsa", sshPassphrase: "old",
        }));

        expect(entry.env.DB_SSH_PASSWORD).toBe("pw");
        expect(entry.env.DB_SSH_KEY).toBeUndefined();
        expect(entry.env.DB_SSH_PASSPHRASE).toBeUndefined();
    });

    it("carries hand-set variables through, but never lets them override an answer or revive DB_URL", () => {
        const entry = answersToEntry(createAnswers({
            extraEnv: { DB_MAX_ROWS: "50", DB_ALIAS: "prod", DB_HOST: "stale", DB_URL: "postgres://u@h/d" },
        }));

        expect(entry.env.DB_MAX_ROWS).toBe("50");
        expect(entry.env.DB_ALIAS).toBe("prod");
        expect(entry.env.DB_HOST).toBe("10.0.0.5");
        expect(entry.env.DB_URL).toBeUndefined();
    });
});

describe("answersToEntry ↔ loadDbProfile — the contract with the server", () => {
    it("produces an env block the server reads back as the same database", () => {
        const keyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-db-entry-"));
        const keyPath = path.join(keyDirectory, "id_test");
        fs.writeFileSync(keyPath, "not a real key");

        const entry = answersToEntry(createAnswers({
            port: 15432,
            password: " spaced ",
            ssl: "off",
            sshHost: "bastion",
            sshPort: 2222,
            sshUser: "ubuntu",
            sshAuth: "key",
            sshKeyPath: keyPath,
            sshHostKeyFingerprint: "SHA256:bastion",
            readonly: true,
            allowDdl: false,
        }));

        const profile = loadDbProfile(entry.env);

        expect(profile?.host).toBe("10.0.0.5");
        expect(profile?.port).toBe(15432);
        expect(profile?.database).toBe("akms");
        expect(profile?.user).toBe("app_user");
        expect(profile?.password).toBe(" spaced ");
        expect(profile?.ssl).toBe("off");
        expect(profile?.tunnel).toMatchObject({ host: "bastion", port: 2222, username: "ubuntu", hostKeyFingerprint: "SHA256:bastion" });
        expect(profile?.tunnel?.privateKeyPath).toBe(path.resolve(keyPath));
        expect(profile?.policy.readonly).toBe(true);
        expect(profile?.policy.allowDdl).toBe(false);

        fs.rmSync(keyDirectory, { recursive: true, force: true });
    });
});

describe("entryToAnswers — pre-filling an edit", () => {
    it("round-trips a full entry without losing a variable", () => {
        const original = answersToEntry(createAnswers({
            port: 15432,
            password: "pw",
            ssl: "verify",
            sslCaPath: "~/certs/rds.pem",
            sshHost: "bastion",
            sshUser: "ubuntu",
            sshAuth: "key",
            sshKeyPath: "~/.ssh/id_ed25519",
            sshHostKeyFingerprint: "SHA256:bastion",
            readonly: true,
            extraEnv: { DB_ALIAS: "prod", DB_STATEMENT_TIMEOUT_MS: "5000" },
        }));

        const answers = entryToAnswers("pg_akms", original);
        const rewritten = answersToEntry(answers);

        expect(rewritten.env).toEqual(original.env);
        expect(answers.sshAuth).toBe("key");
        expect(answers.readonly).toBe(true);
        expect(answers.allowDdl).toBe(true);
    });

    it("reads a DB_URL entry into the split fields, so the edit is rewritten without the URL", () => {
        const answers = entryToAnswers("pg_shop", {
            command: "npx",
            args: ["-y", "@akms/mcp-db"],
            env: { DB_DRIVER: "postgres", DB_URL: "postgres://alice:p%40ss@10.0.0.9:5433/shop?sslmode=disable", DB_MAX_ROWS: "50" },
        });

        expect(answers).toMatchObject({ host: "10.0.0.9", port: 5433, database: "shop", user: "alice", password: "p@ss", ssl: "off" });
        expect(answers.extraEnv).toEqual({ DB_MAX_ROWS: "50" });

        const rewritten = answersToEntry(answers);
        expect(rewritten.env.DB_URL).toBeUndefined();
        expect(rewritten.env).toMatchObject({ DB_HOST: "10.0.0.9", DB_PORT: "5433", DB_NAME: "shop", DB_USER: "alice", DB_PASSWORD: "p@ss", DB_SSL: "off", DB_MAX_ROWS: "50" });
    });

    it("reads a hand-written boolean spelling", () => {
        const answers = entryToAnswers("pg_akms", {
            command: "npx",
            args: ["-y", "@akms/mcp-db"],
            env: { DB_DRIVER: "postgres", DB_HOST: "h", DB_NAME: "d", DB_USER: "u", DB_READONLY: "yes", DB_ALLOW_DDL: "0" },
        });

        expect(answers.readonly).toBe(true);
        expect(answers.allowDdl).toBe(false);
        expect(answers.sshAuth).toBe("agent");
        expect(answers.sshHost).toBeUndefined();
    });
});

describe("summarizeEntry", () => {
    it("describes the endpoint, the route and the settings in force", () => {
        const summary = summarizeEntry({
            command: "npx",
            args: ["-y", "@akms/mcp-db"],
            env: {
                DB_DRIVER: "postgres", DB_HOST: "rds.internal", DB_PORT: "15432", DB_NAME: "akms", DB_USER: "app_user",
                DB_SSH_HOST: "203.0.113.5", DB_SSH_USER: "ubuntu", DB_SSH_HOST_KEY: "SHA256:x",
                DB_READONLY: "true", DB_ALLOW_DDL: "false", DB_SSL: "off",
            },
        });

        expect(summary).toEqual({
            endpoint: "app_user@rds.internal:15432/akms",
            route: "ssh ubuntu@203.0.113.5:22",
            notes: "readonly, no ddl, ssl off, pinned",
        });
    });

    it("reads the endpoint out of a DB_URL entry too", () => {
        const summary = summarizeEntry({ command: "npx", args: ["-y", "@akms/mcp-db"], env: { DB_DRIVER: "postgres", DB_URL: "postgres://u:pw@h/d" } });

        expect(summary.endpoint).toBe("u@h:5432/d");
        expect(summary.route).toBe("direct");
    });
});

describe("isOurEntry", () => {
    it("recognizes every way the package is launched", () => {
        expect(isOurEntry({ command: "npx", args: ["-y", "@akms/mcp-db"], env: {} })).toBe(true);
        expect(isOurEntry({ command: "cmd", args: ["/c", "npx", "-y", "@akms/mcp-db"], env: {} })).toBe(true);
        expect(isOurEntry({ command: "akms-mcp-db", args: [], env: {} })).toBe(true);
        expect(isOurEntry({ command: "C:\\nodejs\\akms-mcp-db.cmd", args: [], env: {} })).toBe(true);
    });

    it("leaves other servers alone", () => {
        expect(isOurEntry({ command: "postgres-mcp", args: ["--access-mode=unrestricted"], env: {} })).toBe(false);
        expect(isOurEntry({ command: "npx", args: ["-y", "@akms/mcp-ssh"], env: {} })).toBe(false);
    });
});
