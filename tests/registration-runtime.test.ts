import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Registry, entryKind } from "../src/modules/registration/registry";
import { findGlobalRuntime, installGlobalRuntime, standardLaunch, runtimePrefix, runtimeRoot, runtimeIsOlder, npmCli } from "../src/modules/registration/runtime";
import type { GlobalRuntime } from "../src/modules/registration/runtime";
import { prepareRuntime, runtimeMenu } from "../src/modules/registration/runtime-menu";
import { Prompter } from "../src/modules/manage/prompter";
import { createJsonFileTarget } from "../src/modules/manage/targets/json-file";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "akms runtime ")); vi.stubEnv("AKMS_MCP_HOME", directory); fs.writeFileSync(path.join(directory, "registry.json"), JSON.stringify({ version: 1, clients: [], connections: {} })); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
const legacy = () => ({ command: "cmd", args: ["/c", "npx", "-y", "@akms/mcp-db@0.2.1"], env: { DB_HOST: "db.local", DB_PASSWORD: "test-secret", CUSTOM: "keep" } });
function fixture() {
    const root = path.join(directory, "node_modules");
    const folder = path.join(root, "@akms", "mcp-db");
    fs.mkdirSync(path.join(folder, "lib"), { recursive: true });
    fs.writeFileSync(path.join(folder, "package.json"), JSON.stringify({ name: "@akms/mcp-db", version: "1.2.3", bin: { "akms-mcp-db": "lib/cli.js" } }));
    fs.writeFileSync(path.join(folder, "lib", "cli.js"), "process.stdin.resume();");
    const targets = ["cursor", "claude-desktop"].map((id) => createJsonFileTarget({ id: id as "cursor" | "claude-desktop", label: id, filePath: path.join(directory, id + ".json") }));
    const runtime = findGlobalRuntime("db", root)!;
    const registry = new Registry(targets, path.join(directory, "registry.json"), { find: () => runtime, check: vi.fn(async () => ({ ok: true, server: "fixture", version: "1.2.3", tools: 1, exitCode: 0, stderr: [] })) });
    return { root, folder, runtime, targets, registry };
}
async function screen(lines: string[], run: (prompter: Prompter) => Promise<unknown>) {
    const input = new PassThrough(), output = new PassThrough();
    let text = ""; output.on("data", (chunk) => { text += chunk; });
    const prompter = new Prompter(input, output); input.end(lines.join("\n") + "\n");
    try { await run(prompter); } finally { prompter.close(); }
    return text;
}

describe("globally installed direct runtime", () => {
    it("discovers a validated global package and recognizes its saved path after removal", () => {
        const { root, folder, runtime } = fixture();
        expect(runtime.command).toBe(process.execPath);
        expect(runtime.args).toEqual([path.join(folder, "lib", "cli.js")]);
        expect(entryKind({ ...runtime, env: {} })).toBe("db");
        fs.unlinkSync(runtime.args[0]);
        expect(findGlobalRuntime("db", root)).toBeNull();
        expect(entryKind({ ...runtime, env: {} })).toBe("db");
    });

    it("converts all standard launches in one review, preserving secrets and custom commands", async () => {
        const { registry, targets, runtime } = fixture();
        registry.register(["cursor", "claude-desktop"]);
        registry.write("db", "first", legacy());
        registry.write("db", "second", legacy());
        const custom = { ...legacy(), args: [...legacy().args, "--custom-argument"] };
        registry.write("db", "custom", custom);
        const text = await screen(["apply", "y", "b"], (prompter) => runtimeMenu(prompter, registry, "db"));
        expect(text).toContain("Convert 2 connection(s)");
        expect(registry.runtimeOptions.check).toHaveBeenCalledTimes(1);
        expect(text).toContain("OK first: fixture@1.2.3");
        expect(text).toContain("OK second:");
        expect(text).toContain("custom");
        expect(text).not.toContain("test-secret");
        for(const target of targets) {
            expect(target.readEntries().first).toEqual({ command: runtime.command, args: runtime.args, env: legacy().env });
            expect(target.readEntries().second.env).toEqual(legacy().env);
            expect(target.readEntries().custom).toEqual(custom);
        }
        expect(registry.planRuntime("db").names).toEqual([]);
        const form = registry.target("db"); form.readEntries();
        form.writeEntry("first", legacy());
        expect(targets[0].readEntries().first.command).toBe(process.execPath);
    });

    it("keeps an externally edited client untouched and rejects stale runtime reviews", () => {
        const { registry, targets } = fixture();
        registry.register(["cursor", "claude-desktop"]);
        registry.write("db", "first", legacy());
        const plan = registry.planRuntime("db");
        targets[1].writeEntry("first", { ...legacy(), env: { ...legacy().env, DB_HOST: "external.local" } });
        const results = registry.applyRuntime(plan);
        expect(results.map((result) => result.status)).toEqual(["synced", "conflict"]);
        expect(targets[1].readEntries().first.command).toBe("cmd");
        const next = registry.planRuntime("db");
        registry.write("db", "new", legacy());
        expect(() => registry.applyRuntime(next)).toThrow(/changed since review/);
    });

    it("installs only when missing and never silently falls back to npx", async () => {
        fs.writeFileSync(path.join(directory, "other.json"), JSON.stringify({ version: 1, clients: [], connections: {} }));
        const { runtime, targets } = fixture();
        let installed: GlobalRuntime | null = null, calls = 0;
        const registry = new Registry(targets, path.join(directory, "other.json"), {
            find: () => installed,
            install: async () => { calls++; installed = runtime; },
        });
        registry.register(["cursor"]);
        await screen([], async (prompter) => {
            expect(await prepareRuntime(prompter, registry, "db")).toBe(true);
            expect(await prepareRuntime(prompter, registry, "db")).toBe(true);
        });
        expect(calls).toBe(1);
        const form = registry.target("db"); form.readEntries();
        form.writeEntry("new", legacy());
        expect(targets[0].readEntries().new.command).toBe(process.execPath);
        installed = null;
        expect(() => form.writeEntry("another", legacy())).toThrow(/Install the AKMS runtime first/);
        expect(targets[0].readEntries().another).toBeUndefined();
    });

    it("does not replace npm-linked development packages with published releases", async () => {
        const { targets, runtime } = fixture();
        const install = vi.fn();
        const registry = new Registry(targets, path.join(directory, "other.json"), { find: () => ({ ...runtime, linked: true }), install });
        await expect(registry.installRuntime("db")).rejects.toThrow(/linked development/);
        expect(install).not.toHaveBeenCalled();
    });

    it("does not rewrite extra flags or arbitrary node scripts as standard launches", () => {
        expect(standardLaunch({ ...legacy(), args: [...legacy().args, "--check"] }, "db")).toBe(false);
        expect(standardLaunch({ command: "node", args: ["@akms/mcp-db"], env: {} }, "db")).toBe(false);
        expect(standardLaunch(legacy(), "db")).toBe(true);
    });

    it("invokes npm with a global latest install once, using an isolated fake npm CLI", async () => {
        const npm = path.join(directory, "npm-cli.js"), record = path.join(directory, "arguments.json");
        fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ type: "commonjs" }));
        fs.writeFileSync(npm, `require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));`);
        vi.stubEnv("npm_execpath", npm);
        await installGlobalRuntime("db");
        expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual(["install", "--global", "--prefix", path.join(directory, "runtime"), "--prefer-online", "--no-fund", "--no-audit", "@akms/mcp-db@latest"]);
    });

    it("finds a linked dedicated runtime without npm and preserves Node's version-switching alias", () => {
        const { folder } = fixture();
        const alias = path.join(runtimeRoot(), "@akms", "mcp-db");
        fs.mkdirSync(path.dirname(alias), { recursive: true });
        fs.symlinkSync(folder, alias, process.platform === "win32" ? "junction" : "dir");
        const nodeAlias = path.join(directory, "node-switch", "node.exe");
        vi.stubGlobal("process", { ...process, execPath: nodeAlias, env: { AKMS_MCP_HOME: directory, PATH: "" } });
        expect(runtimePrefix()).toBe(path.join(directory, "runtime"));
        expect(findGlobalRuntime("db")).toEqual({ command: nodeAlias, args: [path.join(alias, "lib", "cli.js")], version: "1.2.3", linked: true });
        expect(runtimeRoot(runtimePrefix(), "linux")).toBe(path.join(directory, "runtime", "lib", "node_modules"));
        expect(runtimeRoot(runtimePrefix(), "win32")).toBe(path.join(directory, "runtime", "node_modules"));
        // The old Node-version-specific path remains eligible for migration.
        expect(standardLaunch({ command: nodeAlias, args: [path.join(directory, "old-node", "node_modules", "@akms", "mcp-db", "lib", "cli.js")], env: {} }, "db")).toBe(true);
        fs.unlinkSync(alias);
    });

    it.each([
        ["1.2.9", "1.2.10", true], ["1.9.0", "2.0.0", true], ["2.0.0", "1.9.9", false],
        ["1.0.0-rc.9", "1.0.0-rc.10", true], ["1.0.0-rc.1", "1.0.0", true],
        ["1.0.0", "1.0.0-rc.1", false], ["1.0.0+build.1", "1.0.0+build.2", false],
        ["linked", "1.0.0", false],
    ])("compares runtime %s with setup %s", (installed, version, older) => {
        expect(runtimeIsOlder(installed, version)).toBe(older);
    });

    it.each([true, false])("offers an older runtime update before continuing (accept=%s)", async (accept) => {
        const { targets, runtime } = fixture();
        let installed = { ...runtime, version: "0.1.0" };
        const install = vi.fn(async () => { installed = { ...runtime, version: "0.2.1" }; });
        const registry = new Registry(targets, path.join(directory, "versioned.json"), { find: () => installed, install });
        const text = await screen([accept ? "" : "n"], async (prompter) => {
            expect(await prepareRuntime(prompter, registry, "db", "0.2.1")).toBe(true);
        });
        expect(text).toContain("Installed runtime: 0.1.0. This setup: 0.2.1.");
        expect(install).toHaveBeenCalledTimes(accept ? 1 : 0);
    });

    it("skips version prompts for linked installs and hides Update in the runtime menu", async () => {
        const { targets, runtime } = fixture();
        const install = vi.fn();
        const registry = new Registry(targets, path.join(directory, "linked.json"), { find: () => ({ ...runtime, version: "0.0.1", linked: true }), install });
        const text = await screen(["b"], async (prompter) => {
            expect(await prepareRuntime(prompter, registry, "db", "0.2.1")).toBe(true);
            await runtimeMenu(prompter, registry, "db");
        });
        expect(text).toContain("linked development checkout");
        expect(text).not.toContain("Update");
        expect(install).not.toHaveBeenCalled();
    });

    it.each(["available", "removed", "missing"])("handles failed installation when the runtime is %s", async (state) => {
        const { targets, runtime } = fixture();
        let installed: GlobalRuntime | null = state === "missing" ? null : { ...runtime, version: "0.1.0" };
        const registry = new Registry(targets, path.join(directory, "failed-update.json"), {
            find: () => installed,
            install: async () => { if(state === "removed") installed = null; throw new Error("offline npm failure"); },
        });
        const text = await screen(["y"], async (prompter) => {
            expect(await prepareRuntime(prompter, registry, "db", "0.2.1")).toBe(state === "available");
        });
        expect(text).toContain("offline npm failure");
        if(state === "available") expect(text).toContain("Continuing with installed runtime 0.1.0");
        else expect(text).not.toContain("Continuing with installed runtime");
    });

    it("reports the last npm error lines without terminal control sequences", async () => {
        const npm = path.join(directory, "npm-cli.js");
        fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ type: "commonjs" }));
        fs.writeFileSync(npm, `process.stderr.write('discard-one\\ndiscard-two\\n3\\n4\\n5\\n6\\n\\x1b[31mEACCES permission denied\\x1b[0m\\n8\\n'); process.exit(1);`);
        vi.stubEnv("npm_execpath", npm);
        let error: unknown;
        try { await installGlobalRuntime("db"); } catch(value) { error = value; }
        expect(String(error)).toContain("EACCES permission denied");
        expect(String(error)).toContain("--prefix");
        expect(String(error)).not.toContain("discard");
        expect(String(error)).not.toContain("\x1b");
    });

    it("finds Unix prefix npm and skips non-JavaScript PATH shims", () => {
        const prefix = path.join(directory, "node-version");
        const bundled = path.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
        fs.mkdirSync(path.dirname(bundled), { recursive: true }); fs.writeFileSync(bundled, "// npm");
        const shim = path.join(directory, "shim"), actual = path.join(directory, "actual");
        fs.mkdirSync(shim); fs.mkdirSync(actual);
        fs.writeFileSync(path.join(shim, "npm"), "#!/bin/sh\nexit 1");
        const realCli = path.join(actual, "npm-cli.js"); fs.writeFileSync(realCli, "// npm");
        vi.stubGlobal("process", { ...process, platform: "linux", execPath: path.join(prefix, "bin", "node"), env: { PATH: [shim, actual].join(path.delimiter) } });
        const realpath = fs.realpathSync.bind(fs);
        vi.spyOn(fs, "realpathSync").mockImplementation(((file: fs.PathLike) => String(file) === path.join(actual, "npm") ? realCli : realpath(file)) as typeof fs.realpathSync);
        expect(npmCli()).toBe(realpath(bundled));
        fs.unlinkSync(bundled);
        expect(npmCli()).toBe(realCli);
    });
});
