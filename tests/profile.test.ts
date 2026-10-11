import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadDbProfile, toDbSummary } from "@/modules/profile";

describe("loadDbProfile", () => {
    it("returns null when nothing is configured", () => {
        expect(loadDbProfile({})).toBeNull();
    });

    it("reads the split variables with defaults", () => {
        const profile = loadDbProfile({ DB_DRIVER: "postgres", DB_HOST: "db.local", DB_NAME: "akms", DB_USER: "app_user" });
        expect(profile).toMatchObject({
            name: "akms@db.local",
            host: "db.local",
            port: 5432,
            database: "akms",
            user: "app_user",
            ssl: "require",
            tunnel: null,
            policy: { readonly: false, allowDdl: true, maxRows: 500, statementTimeoutMs: 60000 },
        });
    });

    it("reads a URL — percent-encoded password, libpq's database default, sslmode", () => {
        const profile = loadDbProfile({ DB_DRIVER: "postgres", DB_URL: "postgresql://app_user:p%40ss%3Aword@10.0.0.5:15432?sslmode=disable" });
        expect(profile).toMatchObject({ host: "10.0.0.5", port: 15432, user: "app_user", password: "p@ss:word", database: "app_user", ssl: "off" });
    });

    it("DB_SSL overrides the URL's sslmode", () => {
        const profile = loadDbProfile({ DB_DRIVER: "postgres", DB_URL: "postgres://u@h/d?sslmode=disable", DB_SSL: "verify" });
        expect(profile?.ssl).toBe("verify");
    });

    it("refuses a URL together with split variables", () => {
        expect(() => loadDbProfile({ DB_DRIVER: "postgres", DB_URL: "postgres://u@h/d", DB_PORT: "5433" })).toThrow(/DB_URL is set, so DB_PORT must not be/);
    });

    it("never echoes the URL in an error — it holds the password", () => {
        let message = "";
        try {
            loadDbProfile({ DB_DRIVER: "postgres", DB_URL: "mysql://u:hunter2@h/d" });
        }
        catch(ex) {
            message = (ex as Error).message;
        }
        expect(message).toMatch(/must start with postgres/);
        expect(message).not.toContain("hunter2");
    });

    it("requires a supported driver", () => {
        expect(() => loadDbProfile({ DB_HOST: "h", DB_NAME: "d", DB_USER: "u" })).toThrow(/DB_DRIVER is required/);
        expect(() => loadDbProfile({ DB_DRIVER: "mysql", DB_HOST: "h", DB_NAME: "d", DB_USER: "u" })).toThrow(/not supported/);
    });

    it("fails on malformed values instead of ignoring them", () => {
        const base = { DB_DRIVER: "postgres", DB_HOST: "h", DB_NAME: "d", DB_USER: "u" };
        expect(() => loadDbProfile({ ...base, DB_READONLY: "ture" })).toThrow(/DB_READONLY must be one of/);
        expect(() => loadDbProfile({ ...base, DB_MAX_ROWS: "0" })).toThrow(/positive integer/);
        expect(() => loadDbProfile({ ...base, DB_SSL: "maybe" })).toThrow(/DB_SSL must be one of/);
        expect(() => loadDbProfile({ ...base, DB_DENY_PATTERNS: "(unclosed" })).toThrow(/unbalanced bracket/);
        expect(() => loadDbProfile({ ...base, DB_DENY_PATTERNS: "*nothing-to-repeat" })).toThrow(/invalid entry/);
    });

    it("fails on values that would only break later — out-of-range ports and timers, bad %-escapes, URL parameters it would drop", () => {
        const base = { DB_DRIVER: "postgres", DB_HOST: "h", DB_NAME: "d", DB_USER: "u" };
        expect(() => loadDbProfile({ ...base, DB_PORT: "70000" })).toThrow(/DB_PORT must be a positive integer up to 65535/);
        expect(() => loadDbProfile({ ...base, DB_CONNECT_TIMEOUT_MS: "3000000000" })).toThrow(/DB_CONNECT_TIMEOUT_MS .* up to 2147483647/);
        expect(() => loadDbProfile({ DB_DRIVER: "postgres", DB_URL: "postgres://u@h:0/d" })).toThrow(/port 0, outside 1–65535/);

        let message = "";
        try {
            loadDbProfile({ DB_DRIVER: "postgres", DB_URL: "postgres://u:pa%zzss@h/d" });
        }
        catch(ex) {
            message = (ex as Error).message;
        }
        expect(message).toMatch(/malformed %-escape in its password/);
        expect(message).not.toContain("pa%zzss");

        expect(() => loadDbProfile({ DB_DRIVER: "postgres", DB_URL: "postgres://u@h/d?options=-c%20search_path%3Dapp" }))
            .toThrow(/parameters this server does not apply: options/);
    });

    it("refuses a CA bundle that would be ignored because DB_SSL does not verify", () => {
        const base = { DB_DRIVER: "postgres", DB_HOST: "h", DB_NAME: "d", DB_USER: "u", DB_SSL_CA: "~/rds-ca.pem" };
        expect(() => loadDbProfile(base)).toThrow(/DB_SSL_CA is set but the TLS mode is "require" \(from the default\)/);
        expect(() => loadDbProfile({ DB_DRIVER: "postgres", DB_URL: "postgres://u@h/d?sslmode=prefer", DB_SSL_CA: "~/ca.pem" }))
            .toThrow(/\(from DB_URL's sslmode\)/);
        // Any readable file stands in for the bundle here
        expect(loadDbProfile({ ...base, DB_SSL: "verify", DB_SSL_CA: path.resolve("package.json") })?.ssl).toBe("verify");
    });

    it("refuses an output limit too small for an error's own message", () => {
        const base = { DB_DRIVER: "postgres", DB_HOST: "h", DB_NAME: "d", DB_USER: "u" };
        expect(() => loadDbProfile({ ...base, DB_MAX_OUTPUT: "1999" })).toThrow(/DB_MAX_OUTPUT must be at least 2000 \(got 1999\)/);
        expect(loadDbProfile({ ...base, DB_MAX_OUTPUT: "2000" })?.policy.maxOutputCharacters).toBe(2000);
    });

    it("refuses a CA bundle that does not exist — the driver would fail on it while starting, with a bare ENOENT", () => {
        const base = { DB_DRIVER: "postgres", DB_HOST: "h", DB_NAME: "d", DB_USER: "u", DB_SSL: "verify" };
        expect(() => loadDbProfile({ ...base, DB_SSL_CA: "~/no-such-rds-ca.pem" })).toThrow(/DB_SSL_CA names .*no-such-rds-ca\.pem, which does not exist/);
    });

    it("names a misspelled variable instead of silently keeping the permissive default", () => {
        const base = { DB_DRIVER: "postgres", DB_HOST: "h", DB_NAME: "d", DB_USER: "u" };
        expect(() => loadDbProfile({ ...base, DB_READ_ONLY: "true" })).toThrow(/DB_READ_ONLY .* did you mean DB_READONLY\?/);
        expect(() => loadDbProfile({ ...base, DB_ALLOWDDL: "false" })).toThrow(/did you mean DB_ALLOW_DDL\?/);
        expect(() => loadDbProfile({ ...base, DB_STATEMENT_TIMEOUT: "5000" })).toThrow(/did you mean DB_STATEMENT_TIMEOUT_MS\?/);
        expect(() => loadDbProfile({ ...base, DB_MAX_OUTPUT_CHARS: "5000" })).toThrow(/did you mean DB_MAX_OUTPUT\?/);
        expect(() => loadDbProfile({ ...base, DB_SSLMODE: "verify-full" })).toThrow(/did you mean DB_SSL\?/);
        expect(() => loadDbProfile({ ...base, DB_SSH_HOSTKEY: "SHA256:x" })).toThrow(/did you mean DB_SSH_HOST_KEY\?/);
        // Unrelated DB_* names from other programs are left alone
        expect(loadDbProfile({ ...base, DB_MIGRATIONS_TABLE: "schema_migrations" })?.host).toBe("h");
    });

    it("takes the longest known name a variable extends — a host key pin must not pass for DB_SSH_HOST", () => {
        const base = { DB_DRIVER: "postgres", DB_HOST: "h", DB_NAME: "d", DB_USER: "u", DB_SSH_HOST: "s", DB_SSH_USER: "ubuntu" };
        expect(() => loadDbProfile({ ...base, DB_SSH_HOST_KEY_SHA256: "SHA256:x" })).toThrow(/did you mean DB_SSH_HOST_KEY\?/);
        expect(() => loadDbProfile({ ...base, DB_SSL_CA_FILE: "/ca.pem" })).toThrow(/did you mean DB_SSL_CA\?/);
        // A cut-short name still means its first, shortest completion — not the longest name it begins
        expect(() => loadDbProfile({ ...base, DB_SS: "verify" })).toThrow(/did you mean DB_SSL\?/);
        expect(() => loadDbProfile({ ...base, DB_M: "100" })).toThrow(/did you mean DB_MAX_ROWS\?/);
    });

    it("catches a policy variable written in another case — POSIX environments are case-sensitive", () => {
        const base = { DB_DRIVER: "postgres", DB_HOST: "h", DB_NAME: "d", DB_USER: "u" };
        expect(() => loadDbProfile({ ...base, DB_ReadOnly: "true" })).toThrow(/DB_ReadOnly .* did you mean DB_READONLY\?/);
        expect(() => loadDbProfile({ ...base, db_readonly: "true" })).toThrow(/db_readonly .* did you mean DB_READONLY\?/);
        // The same value under both spellings is what a case-insensitive (Windows) environment shows: it is read
        expect(loadDbProfile({ ...base, DB_READONLY: "true", db_readonly: "true" })?.policy.readonly).toBe(true);
    });

    it("does not block startup over another program's DB_* variable, or one close only to a connection variable", () => {
        const base = { DB_DRIVER: "postgres", DB_HOST: "h", DB_NAME: "d", DB_USER: "u" };
        for(const name of ["DB_POOL", "DB_ORM", "DB_SALT", "DB_CERT", "DB_TIME", "DB_NAMESPACE", "DB_HOST_REPLICA", "DB_PORT_5432_TCP", "DB_SSH", "DB_USERNAME", "DB_PASS"]) {
            expect(loadDbProfile({ ...base, [name]: "x" })?.host, name).toBe("h");
        }
        // Nothing configured: the server starts with "no database registered", whatever else is in the environment
        expect(loadDbProfile({ DB_READ_ONLY: "true" })).toBeNull();
    });

    it("keeps a password's surrounding spaces", () => {
        const profile = loadDbProfile({ DB_DRIVER: "postgres", DB_HOST: "h", DB_NAME: "d", DB_USER: "u", DB_PASSWORD: " p w " });
        expect(profile?.password).toBe(" p w ");
    });

    it("reads DB_DENY_PATTERNS as a JSON array, and refuses a comma that split a regex", () => {
        const base = { DB_DRIVER: "postgres", DB_HOST: "h", DB_NAME: "d", DB_USER: "u" };
        const profile = loadDbProfile({ ...base, DB_DENY_PATTERNS: "[\"\\\\bdrop\\\\s{1,3}table\", \"secrets\"]" });
        expect(profile?.policy.denyPatterns.map((pattern) => pattern.source)).toEqual(["\\bdrop\\s{1,3}table", "secrets"]);
        expect(profile?.policy.denyPatterns[0].test("DROP  TABLE users")).toBe(true);

        expect(() => loadDbProfile({ ...base, DB_DENY_PATTERNS: "\\bdrop\\s{1,3}table" })).toThrow(/unbalanced bracket .* JSON array/);
        // Not JSON, so a comma list — whose "[" piece is a regex split at its comma
        expect(() => loadDbProfile({ ...base, DB_DENY_PATTERNS: "[,;]drop" })).toThrow(/unbalanced bracket/);
        // A first regex that starts with a character class stays a comma list
        expect(loadDbProfile({ ...base, DB_DENY_PATTERNS: "[^a-z]pg_sleep, secrets" })?.policy.denyPatterns.map((pattern) => pattern.source))
            .toEqual(["[^a-z]pg_sleep", "secrets"]);
        expect(loadDbProfile({ ...base, DB_DENY_PATTERNS: "secrets, \\bpg_shadow\\b" })?.policy.denyPatterns.length).toBe(2);
    });

    it("refuses a JSON deny list whose escapes went wrong instead of letting it match nothing — or everything", () => {
        const base = { DB_DRIVER: "postgres", DB_HOST: "h", DB_NAME: "d", DB_USER: "u" };
        // One backslash: JSON reads \b as a backspace, so the pattern would compile and never match
        expect(() => loadDbProfile({ ...base, DB_DENY_PATTERNS: "[\"\\bdrop\\b\"]" })).toThrow(/holds a backspace — in JSON \\b is a backspace; write \\\\b/);
        // \s is no JSON escape: this used to fall back to a comma list — one character class refusing almost every statement
        expect(() => loadDbProfile({ ...base, DB_DENY_PATTERNS: "[\"\\bdrop\\s+table\"]" })).toThrow(/is written as a JSON array but is not valid JSON/);
        expect(() => loadDbProfile({ ...base, DB_DENY_PATTERNS: "[\"a\", 1]" })).toThrow(/as JSON must be an array of strings/);
        expect(loadDbProfile({ ...base, DB_DENY_PATTERNS: "[]" })?.policy.denyPatterns).toEqual([]);
        // Not shaped like a JSON array — a regex that starts with a class of quote characters
        expect(loadDbProfile({ ...base, DB_DENY_PATTERNS: "[\"']\\s*or\\s+1=1" })?.policy.denyPatterns.map((pattern) => pattern.source))
            .toEqual(["[\"']\\s*or\\s+1=1"]);
        // A class of one double quote, used twice — its first item would otherwise look like a closed JSON string
        expect(loadDbProfile({ ...base, DB_DENY_PATTERNS: "[\"]?secrets[\"]?, \\bdrop\\b" })?.policy.denyPatterns.map((pattern) => pattern.source))
            .toEqual(["[\"]?secrets[\"]?", "\\bdrop\\b"]);
        expect(loadDbProfile({ ...base, DB_DENY_PATTERNS: "[ \"]?secrets[ \"]?" })?.policy.denyPatterns.map((pattern) => pattern.source))
            .toEqual(["[ \"]?secrets[ \"]?"]);
        // A JSON array with a typo after its first item is a JSON mistake — read as a regex it would match nothing, or everything
        for(const value of ["[\"\\\\bdrop\\\\b\"] # no drops", "[\"\\\\bdrop\\\\b\"];", "[\"\\\\bdrop\\\\b\" \"secrets\"]", "[\"\\\\bdrop\\\\b\", \"secrets\",]"]) {
            expect(() => loadDbProfile({ ...base, DB_DENY_PATTERNS: value }), value).toThrow(/is written as a JSON array but is not valid JSON/);
        }
    });

    it("builds the tunnel, and refuses tunnel details without its host", () => {
        const base = { DB_DRIVER: "postgres", DB_HOST: "ak-pg.rds.amazonaws.com", DB_PORT: "15432", DB_NAME: "akms", DB_USER: "app_user" };
        const profile = loadDbProfile({ ...base, DB_SSH_HOST: "203.0.113.5", DB_SSH_PORT: "20022", DB_SSH_USER: "ubuntu", DB_SSH_PASSWORD: "x" });
        expect(profile?.tunnel).toMatchObject({ host: "203.0.113.5", port: 20022, username: "ubuntu", password: "x" });
        expect(profile?.ssl).toBe("require");

        expect(() => loadDbProfile({ ...base, DB_SSH_USER: "ubuntu" })).toThrow(/DB_SSH_USER set without DB_SSH_HOST/);
        expect(() => loadDbProfile({ ...base, DB_SSH_HOST: "h" })).toThrow(/DB_SSH_USER is required/);
    });

    it("expands ~ in the key path", () => {
        const profile = loadDbProfile({
            DB_DRIVER: "postgres", DB_HOST: "h", DB_NAME: "d", DB_USER: "u",
            DB_SSH_HOST: "s", DB_SSH_USER: "ubuntu", DB_SSH_KEY: "~/keys/aws.pem",
        });
        expect(path.isAbsolute(profile?.tunnel?.privateKeyPath ?? "")).toBe(true);
        expect(profile?.tunnel?.privateKeyPath).toMatch(/keys[\\/]aws\.pem$/);
    });
});

describe("toDbSummary", () => {
    it("carries no secret", () => {
        const profile = loadDbProfile({
            DB_DRIVER: "postgres", DB_URL: "postgres://u:dbsecret@h:1/d",
            DB_SSH_HOST: "s", DB_SSH_USER: "ubuntu", DB_SSH_PASSWORD: "sshsecret", DB_SSH_PASSPHRASE: "phrase",
        });
        const text = JSON.stringify(toDbSummary(profile!));
        expect(text).not.toMatch(/dbsecret|sshsecret|phrase/);
        expect(toDbSummary(profile!).tunnel?.authMethod).toBe("password");
    });
});
