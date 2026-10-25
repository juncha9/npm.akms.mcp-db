import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Registry, entryHash, formatResults } from "../src/modules/registration/registry";
import { ManagedSession, registrationMenu, importMenu, syncMenu } from "../src/modules/registration/menu";
import { Prompter } from "../src/modules/manage/prompter";
import type { ConfigTarget, McpServerEntry } from "../src/modules/registration/types";
import { createJsonFileTarget } from "../src/modules/manage/targets/json-file";
import { parseMcpServersToml, writeMcpServerToml } from "../src/modules/manage/targets/toml-subset";
import { updateConfigFile } from "../src/modules/manage/targets/config-file";

let directory: string;
let registry: Registry;
let json: ConfigTarget;
let toml: ConfigTarget;
const entry = (host = "database.local"): McpServerEntry => ({ command: "npx", args: ["-y", "@akms/mcp-db"], env: { DB_HOST: host, DB_NAME: "app", DB_USER: "user", DB_DRIVER: "postgres", DB_PASSWORD: "test-secret" } });

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "akms-register-"));
    // Existing-catalog regressions intentionally exercise version 1.
    fs.writeFileSync(path.join(directory, "registry.json"), JSON.stringify({ version: 1, clients: [], connections: {} }));
    json = createJsonFileTarget({ id: "cursor", label: "Cursor", filePath: path.join(directory, "cursor.json") });
    const file = path.join(directory, "codex.toml");
    fs.writeFileSync(file, '# preserve me\nmodel = "example"\n');
    toml = {
        id: "codex", label: "Codex", location: file, detected: true,
        readEntries: () => parseMcpServersToml(fs.readFileSync(file, "utf8")),
        writeEntry: (name, value) => { updateConfigFile(file, (text) => writeMcpServerToml(text, name, value)); return { status: "written", detail: file }; },
        removeEntry: (name) => { updateConfigFile(file, (text) => writeMcpServerToml(text, name, null)); return { status: "written", detail: file }; },
    };
    registry = new Registry([json, toml], path.join(directory, "registry.json"), { find: (kind) => ({ command: process.execPath, args: [path.join(directory, "node_modules", "@akms", `mcp-${kind}`, "lib", "cli.js")], version: "1.0.0", linked: false }) });
});
afterEach(() => { if(path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("akms-register-")) throw new Error("Unexpected cleanup target"); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

async function screen(lines: string[], run: (prompter: Prompter) => Promise<unknown>): Promise<string> {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => { text += chunk; });
    const prompter = new Prompter(input, output);
    input.end(lines.join("\n") + "\n");
    try { await run(prompter); } finally { prompter.close(); }
    return text;
}

describe("independent shared registration", () => {
    it("requires registration at save time, including when services were removed during an open form", () => {
        expect(() => registry.write("db", "app-db", entry())).toThrow(/Register at least one AI service/);
        expect(fs.readFileSync(registry.file, "utf8")).toBe(JSON.stringify({ version: 1, clients: [], connections: {} }));
        registry.register(["cursor"]);
        registry.write("db", "app-db", entry());
        const form = registry.target("db");
        form.readEntries();
        registry.register([]);
        const before = fs.readFileSync(registry.file, "utf8");
        expect(() => form.writeEntry("app-db", entry("changed.local"))).toThrow(/Register at least one AI service/);
        expect(fs.readFileSync(registry.file, "utf8")).toBe(before);
        expect(json.readEntries()).toEqual({});
    });

    it("summarizes successes while keeping per-connection conflicts and failures visible", () => {
        registry.register(["cursor", "codex"]);
        registry.write("db", "complete-db", entry());
        registry.write("db", "review-db", entry());
        toml.writeEntry("review-db", { ...entry(), env: { ...entry().env, DB_DESCRIPTION: "Service description" } });
        const results = registry.sync();
        const text = formatResults(results, "Registration saved.");
        expect(text).toContain("Connections: 1 complete · 1 need attention");
        expect(text).toContain("0 updated · 3 already up to date");
        expect(text).toContain("review-db");
        expect(text).toContain("Codex: Only the description differs");
        expect(text).toContain("existing settings kept");
        expect(text).not.toContain("complete-db");
        expect(text).not.toContain("test-secret");
        const failed = formatResults([...results, { name: "failed-db", client: "cursor", status: "error", detail: "Cannot write settings." }]);
        expect(failed).toContain("Could not finish:");
        expect(failed).toContain("failed-db");
        expect(failed).toContain("Cannot write settings.");
    });

    it("routes known differences to Sync and compares only changed fields without exposing secrets", async () => {
        registry.register(["cursor", "codex"]);
        registry.write("db", "app-db", entry());
        toml.writeEntry("app-db", { ...entry(), env: { ...entry().env, DB_DESCRIPTION: "New description" } });
        const before = fs.readFileSync(toml.location, "utf8");
        const text = await screen(["a", "y", "y", "0", "b", "b"], (prompter) => registrationMenu(prompter, registry));
        expect(text).toContain("Compare settings for 1 connection(s) now?");
        expect(text).toContain("Only the description differs; connection settings match.");
        expect(text).toContain("[1] Saved in AKMS");
        expect(text).toContain("[2] Currently in Codex");
        expect(text).toContain("New description");
        expect(text).toContain("Use 2: Codex -> all 2 services");
        expect(text).toContain("Back without changes");
        expect(text).not.toContain("DB_HOST:");
        expect(text).not.toContain("DB_PASSWORD");
        expect(text).not.toContain("test-secret");
        expect(text).not.toContain("Compare existing settings and choose which to share?");
        expect(fs.readFileSync(toml.location, "utf8")).toBe(before);
        const session = new ManagedSession({ kind: "db", targets: [json, toml], registryPath: registry.file });
        const opening = await screen([], (prompter) => session.initialize(prompter));
        expect(opening).not.toContain("choose Import existing connections");
        toml.writeEntry("app-db", { ...entry(), env: { ...entry().env, DB_PASSWORD: "changed-secret" } });
        const secrets = await screen(["0", "b", "b"], (prompter) => syncMenu(prompter, registry));
        expect(secrets).toContain("DB_PASSWORD");
        expect(secrets).toContain("[2] Currently in Codex");
        expect(secrets).toContain("(hidden)");
        expect(secrets).not.toContain("changed-secret");
        expect(secrets).not.toContain("test-secret");
    });

    it("registers once, applies CRUD to JSON and TOML, and preserves unrelated settings", () => {
        registry.register(["cursor", "codex"]);
        const result = registry.write("db", "app-db", entry());
        expect(result.map((item) => item.status)).toEqual(["synced", "synced"]);
        expect(json.readEntries()["app-db"]).toEqual(toml.readEntries()["app-db"]);
        expect(fs.readFileSync(toml.location, "utf8")).toContain('# preserve me\nmodel = "example"');
        registry.write("db", "app-db", entry("changed.local"));
        expect(json.readEntries()["app-db"].env.DB_HOST).toBe("changed.local");
        registry.remove("db", "app-db");
        expect(json.readEntries()).toEqual({});
        expect(toml.readEntries()).toEqual({});
        expect(registry.read().connections).toEqual({});
    });

    it("reuses registration in another package instance and backfills a new service", () => {
        registry.register(["cursor"]);
        registry.write("db", "app-db", entry());
        const standaloneSsh = new Registry([json, toml], registry.file);
        expect(standaloneSsh.read().clients).toEqual(["cursor"]);
        standaloneSsh.write("ssh", "host", { command: "npx", args: ["-y", "@akms/mcp-ssh"], env: { SSH_HOST: "host", SSH_USER: "user" } });
        standaloneSsh.register(["cursor", "codex"]);
        expect(Object.keys(toml.readEntries())).toEqual(["app-db", "host"]);
        expect(registry.target("db").readEntries()).toHaveProperty("app-db");
        expect(registry.target("db").readEntries()).not.toHaveProperty("host");
    });

    it("keeps successful writes and retries a failed service, including deletion", () => {
        registry.register(["cursor", "codex"]);
        const write = toml.writeEntry;
        toml.writeEntry = () => { throw new Error("private credential text"); };
        const partial = registry.write("db", "app-db", entry());
        expect(partial.map((item) => item.status)).toEqual(["synced", "error"]);
        expect(JSON.stringify(partial)).not.toContain("private credential");
        expect(json.readEntries()["app-db"]).toEqual(entry());
        toml.writeEntry = write;
        expect(registry.sync().every((item) => item.status === "synced")).toBe(true);
        const remove = toml.removeEntry;
        toml.removeEntry = () => ({ status: "unavailable", detail: "locked" });
        registry.remove("db", "app-db");
        expect(registry.read().connections["app-db"].entry).toBeNull();
        expect(json.readEntries()).toEqual({});
        toml.removeEntry = remove;
        registry.sync();
        expect(registry.read().connections).toEqual({});
    });

    it("preserves external edits, and explicit resolution propagates the chosen version", () => {
        registry.register(["cursor", "codex"]);
        registry.write("db", "app-db", entry());
        const external = entry("external.local");
        json.writeEntry("app-db", external);
        const statuses = registry.write("db", "app-db", entry("new.local"));
        expect(statuses.find((item) => item.client === "cursor")?.status).toBe("conflict");
        expect(json.readEntries()["app-db"]).toEqual(external);
        registry.resolve("cursor", "app-db", external, true);
        expect(toml.readEntries()["app-db"]).toEqual(external);
        json.writeEntry("app-db", entry("newer.local"));
        expect(() => registry.resolve("cursor", "app-db", external, false)).toThrow(/changed since review/);
    });

    it("never overwrites an unmanaged conflicting name or unsupported HTTP entry", () => {
        fs.writeFileSync(json.location, JSON.stringify({ mcpServers: { "app-db": { url: "https://example.invalid/mcp" } } }));
        registry.register(["cursor"]);
        expect(registry.write("db", "app-db", entry())[0].status).toBe("conflict");
        expect(JSON.parse(fs.readFileSync(json.location, "utf8")).mcpServers["app-db"].url).toContain("example.invalid");
    });

    it("unregisters only owned entries and leaves local data available for later registration", () => {
        registry.register(["cursor", "codex"]);
        registry.write("db", "app-db", entry());
        json.writeEntry("other", { command: "other", args: [], env: {} });
        registry.register(["codex"]);
        expect(Object.keys(json.readEntries())).toEqual(["other"]);
        expect(registry.read().connections["app-db"].entry).toEqual(entry());
        registry.register(["cursor", "codex"]);
        expect(json.readEntries()["app-db"]).toEqual(entry());
    });

    it("keeps an old name on a failed service until a rename succeeds", () => {
        registry.register(["cursor", "codex"]);
        registry.write("db", "old", entry());
        const write = toml.writeEntry;
        toml.writeEntry = () => ({ status: "unavailable", detail: "busy" });
        registry.write("db", "new", entry(), "old");
        expect(Object.keys(json.readEntries())).toEqual(["new"]);
        expect(Object.keys(toml.readEntries())).toEqual(["old"]);
        registry.write("db", "newest", entry(), "new");
        expect(Object.keys(toml.readEntries())).toEqual(["old"]);
        toml.writeEntry = write;
        registry.sync();
        expect(Object.keys(toml.readEntries())).toEqual(["newest"]);
    });

    it("rejects cross-package name collisions and handles prototype-shaped names", () => {
        registry.register(["cursor"]);
        registry.write("db", "__proto__", entry());
        expect(Object.hasOwn(json.readEntries(), "__proto__")).toBe(true);
        expect(() => registry.write("ssh", "__proto__", { command: "akms-mcp-ssh", args: [], env: {} })).toThrow(/another MCP/);
        expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    });

    it("rejects an unsupported catalog version and an overlapping editor", () => {
        registry.register([]);
        fs.writeFileSync(registry.file + ".lock", String(process.pid));
        expect(() => registry.write("db", "app-db", entry())).toThrow(/Another AKMS/);
        fs.unlinkSync(registry.file + ".lock");
        fs.writeFileSync(registry.file, '{"version":99}');
        expect(() => registry.register(["cursor"])).toThrow(/Unsupported/);
        expect(fs.readFileSync(registry.file, "utf8")).toBe('{"version":99}');
    });

    it("does not lose a newer registration while a menu is open", () => {
        registry.register(["cursor"]);
        expect(() => registry.register(["codex"], [])).toThrow(/changed in another/);
        expect(registry.read().clients).toEqual(["cursor"]);
    });

    it("rejects a stale form save or deletion after another package changed the catalog", () => {
        registry.register(["cursor"]);
        registry.write("db", "app-db", entry());
        const form = registry.target("db");
        form.readEntries();
        new Registry([json, toml], registry.file).write("db", "app-db", entry("concurrent.local"));
        expect(() => form.writeEntry("app-db", entry("stale.local"))).toThrow(/changed while the form/);
        expect(() => form.removeEntry("app-db")).toThrow(/changed since it was displayed/);
        expect(json.readEntries()["app-db"].env.DB_HOST).toBe("concurrent.local");
    });

    it("does not overwrite a catalog edited outside the lock while applying settings", () => {
        registry.register(["cursor"]);
        const write = json.writeEntry;
        json.writeEntry = (name, value) => {
            const result = write(name, value);
            fs.writeFileSync(registry.file, '{"version":99}');
            return result;
        };
        expect(() => registry.write("db", "app-db", entry())).toThrow(/changed outside/);
        expect(fs.readFileSync(registry.file, "utf8")).toBe('{"version":99}');
    });

    it("presents persistent multi-service registration without installing the launcher", async () => {
        const text = await screen(["cursor", "codex", "a", "y"], (prompter) => registrationMenu(prompter, registry));
        expect(registry.read().clients).toEqual(["cursor", "codex"]);
        expect(text).toContain("Registration saved");
        await screen(["cursor", "back"], (prompter) => registrationMenu(prompter, registry));
        expect(registry.read().clients).toEqual(["cursor", "codex"]);
    });

    it("discovers legacy sync copies before registration and merges them without rewriting either source", async () => {
        json.writeEntry("legacy-db", entry());
        toml.writeEntry("legacy-db", { ...entry(), env: Object.fromEntries(Object.entries(entry().env).reverse()) });
        const beforeJson = fs.readFileSync(json.location, "utf8");
        const beforeToml = fs.readFileSync(toml.location, "utf8");
        expect(registry.candidates(undefined, ["cursor", "codex"]).entries).toHaveLength(2);
        expect(fs.readFileSync(registry.file, "utf8")).toBe(JSON.stringify({ version: 1, clients: [], connections: {} }));
        const text = await screen(["cursor", "codex", "a", "y"], (prompter) => registrationMenu(prompter, registry));
        expect(text).toContain("1 existing AKMS");
        expect(text).toContain("Imported 1 existing connection(s)");
        expect(text).not.toContain("Review existing AKMS connections to import?");
        expect(text).not.toContain("test-secret");
        expect(Object.keys(registry.target("db").readEntries())).toEqual(["legacy-db"]);
        expect(fs.readFileSync(json.location, "utf8")).toBe(beforeJson);
        expect(fs.readFileSync(toml.location, "utf8")).toBe(beforeToml);
    });

    it("keeps differing descriptions intact until a version is chosen", async () => {
        json.writeEntry("legacy-db", { ...entry(), env: { ...entry().env, DB_DESCRIPTION: "First description" } });
        toml.writeEntry("legacy-db", { ...entry(), env: { ...entry().env, DB_DESCRIPTION: "Second description" } });
        const beforeJson = fs.readFileSync(json.location, "utf8");
        const beforeToml = fs.readFileSync(toml.location, "utf8");
        const text = await screen(["cursor", "codex", "a", "y", "n"], (prompter) => registrationMenu(prompter, registry));
        expect(text).toContain("Keep 1 differing connection(s) unchanged");
        expect(registry.read().connections).toEqual({});
        expect(fs.readFileSync(json.location, "utf8")).toBe(beforeJson);
        expect(fs.readFileSync(toml.location, "utf8")).toBe(beforeToml);
        const review = await screen(["legacy-db", "0", "", "y"], (prompter) => importMenu(prompter, registry));
        expect(review).toContain("First description");
        expect(review).toContain("Second description");
        expect(review).not.toContain("test-secret");
    });

    it("keeps successful registration when Esc skips the optional conflict review", async () => {
        json.writeEntry("legacy-db", entry("left.local"));
        toml.writeEntry("legacy-db", entry("right.local"));
        await screen(["cursor", "codex", "a", "y", "ESC"], async (prompter) => {
            expect(await registrationMenu(prompter, registry)).toBe(true);
        });
        expect(registry.read().clients).toEqual(["cursor", "codex"]);
        expect(registry.read().connections).toEqual({});
        expect(json.readEntries()["legacy-db"].env.DB_HOST).toBe("left.local");
    });

    it("imports connections found on one service and backfills the other", () => {
        json.writeEntry("legacy-db", entry());
        const plan = registry.planRegistration(["cursor", "codex"]);
        expect(plan.imports).toHaveLength(1);
        registry.register(["cursor", "codex"], [], plan.imports);
        expect(toml.readEntries()["legacy-db"]).toEqual(entry());
    });

    it("stops automatic import when an original changes after review", () => {
        json.writeEntry("legacy-db", entry());
        toml.writeEntry("legacy-db", entry());
        const plan = registry.planRegistration(["cursor", "codex"]);
        json.writeEntry("legacy-db", entry("newer.local"));
        expect(() => registry.register(["cursor", "codex"], [], plan.imports)).toThrow(/changed since review/);
        expect(fs.readFileSync(registry.file, "utf8")).toBe(JSON.stringify({ version: 1, clients: [], connections: {} }));
        expect(json.readEntries()["legacy-db"].env.DB_HOST).toBe("newer.local");
        expect(toml.readEntries()["legacy-db"]).toEqual(entry());
    });

    it("offers a batch import after registration while leaving differing names for review", async () => {
        json.writeEntry("matching", entry());
        toml.writeEntry("matching", entry());
        json.writeEntry("different", entry("left.local"));
        toml.writeEntry("different", entry("right.local"));
        registry.register(["cursor", "codex"]);
        const text = await screen(["all", "y", "b"], (prompter) => importMenu(prompter, registry));
        expect(text).toContain("Import all matching connections");
        expect(Object.keys(registry.read().connections)).toEqual(["matching"]);
        expect(json.readEntries().different.env.DB_HOST).toBe("left.local");
        expect(toml.readEntries().different.env.DB_HOST).toBe("right.local");
    });

    it("imports differing existing entries after choosing a version, without displaying secrets", async () => {
        json.writeEntry("app-db", entry("cursor.local"));
        toml.writeEntry("app-db", entry("codex.local"));
        registry.register(["cursor", "codex"]);
        const text = await screen(["app-db", "0", "", "y"], (prompter) => importMenu(prompter, registry));
        expect(text).not.toContain("test-secret");
        expect(toml.readEntries()["app-db"].env.DB_HOST).toBe("cursor.local");
        expect(registry.read().connections["app-db"].applied.codex).toBe(entryHash(entry("cursor.local")));
    });

    it("resolves client drift from the Sync screen", async () => {
        registry.register(["cursor", "codex"]);
        registry.write("db", "app-db", entry());
        json.writeEntry("app-db", entry("edited.local"));
        const text = await screen(["0", "client", "y"], (prompter) => syncMenu(prompter, registry));
        expect(text).toContain("Save the Cursor version in AKMS.");
        expect(text).toContain("Sync to: Cursor · Codex");
        expect(text).toContain("Save in AKMS and sync 2 services?");
        expect(text).not.toContain("test-secret");
        expect(toml.readEntries()["app-db"].env.DB_HOST).toBe("edited.local");
    });

    it("shows the AKMS-to-service direction and leaves the service unchanged when confirmation is declined", async () => {
        registry.register(["cursor", "codex"]);
        registry.write("db", "app-db", entry());
        toml.writeEntry("app-db", entry("edited.local"));
        const before = fs.readFileSync(toml.location, "utf8");
        const text = await screen(["0", "shared", "n", "b"], (prompter) => syncMenu(prompter, registry));
        expect(text).toContain("Use 1: AKMS -> Codex");
        expect(text).toContain("Copy the saved AKMS settings to Codex.");
        expect(text).toContain("Update Codex with version 1?");
        expect(fs.readFileSync(toml.location, "utf8")).toBe(before);
        await screen(["0", "shared", "y"], (prompter) => syncMenu(prompter, registry));
        expect(toml.readEntries()["app-db"]).toEqual(entry());
    });

    it("describes an unregistered service's pending removal instead of promising an update", async () => {
        registry.register(["cursor", "codex"]);
        registry.write("db", "app-db", entry());
        toml.writeEntry("app-db", entry("edited.local"));
        registry.register(["cursor"]);
        const text = await screen(["0", "shared", "y"], (prompter) => syncMenu(prompter, registry));
        expect(text).toContain("Codex is no longer registered.");
        expect(text).toContain("Remove from Codex?");
        expect(text).not.toContain("Use 1:");
        expect(text).not.toContain("Restore from Codex");
        expect(toml.readEntries()).toEqual({});
        expect(json.readEntries()["app-db"]).toEqual(entry());
    });

    it("offers restoration when a registered service has changed during a pending deletion", async () => {
        registry.register(["cursor", "codex"]);
        registry.write("db", "app-db", entry());
        toml.writeEntry("app-db", entry("edited.local"));
        registry.remove("db", "app-db");
        const text = await screen(["0", "client", "y"], (prompter) => syncMenu(prompter, registry));
        expect(text).toContain("This connection was removed from AKMS.");
        expect(text).toContain("Restore from Codex");
        expect(text).toContain("Save in AKMS and sync 2 services?");
        expect(json.readEntries()["app-db"]).toEqual(entry("edited.local"));
        expect(toml.readEntries()["app-db"]).toEqual(entry("edited.local"));
    });
});
