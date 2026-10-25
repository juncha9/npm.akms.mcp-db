import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const guard = await import(new URL("../scripts/release-guard.mjs", import.meta.url).href);
let workspace: string;
beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "akms-release-test-"));
    for(const checkout of guard.CHECKOUTS as string[]) {
        const root = path.join(workspace, checkout);
        fs.mkdirSync(path.join(root, "src/_defs"), { recursive: true });
        fs.mkdirSync(path.join(root, "src/modules/registration"), { recursive: true });
        fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: checkout.replace("npm.akms.", "@akms/"), version: "0.2.1" }));
        fs.writeFileSync(path.join(root, "src/_defs/defaults.ts"), 'export const SERVER_VERSION = "0.2.1";\n');
        if(checkout === "npm.akms.mcp-s3") fs.writeFileSync(path.join(root, "src/profile.ts"), 'export const SERVER_VERSION = "0.2.1";\n');
        fs.writeFileSync(path.join(root, "src/modules/registration/runtime.ts"), 'export const fixture = true;\n');
        fs.writeFileSync(path.join(root, "src/modules/registration/prompter.ts"), `export { Prompter } from "../${checkout === "npm.akms.mcp" ? "launcher" : "manage"}/prompter";\n`);
    }
});
afterEach(() => {
    expect(path.dirname(workspace)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(workspace)).toMatch(/^akms-release-test-/);
    fs.rmSync(workspace, { recursive: true, force: true });
});

const protectedSsh = () => ({ SERVER_VERSION: "0.2.1", inspectLocalPath: (file: string) => ({ allowed: !/(^|\/)\.akms\/mcp(\/|$)/i.test(file.replaceAll("\\", "/")) }) });
const clean = () => ({ execute: vi.fn(async () => ({ stdout: "", stderr: "" })), latest: vi.fn(async () => "0.2.0"), loadSsh: protectedSsh });

describe("release gate", () => {
    it("passes all five packages when release prerequisites hold and skips the launcher server constant", async () => {
        fs.rmSync(path.join(workspace, "npm.akms.mcp/src/_defs/defaults.ts"));
        for(const checkout of guard.CHECKOUTS as string[]) {
            const result = await guard.checkRelease(path.join(workspace, checkout), clean());
            expect(result.passed, JSON.stringify(result)).toBe(true);
            expect(result.checks.some((item) => item.name === "server_version")).toBe(checkout !== "npm.akms.mcp");
        }
    });
    it("reports dirty files, reused version, wrong server version, copy drift and unsafe WSL dependency together", async () => {
        const root = path.join(workspace, "npm.akms.mcp-wsl");
        fs.writeFileSync(path.join(root, "src/_defs/defaults.ts"), 'export const SERVER_VERSION = "0.1.9";\n');
        fs.appendFileSync(path.join(root, "src/modules/registration/runtime.ts"), "// drift\n");
        const result = await guard.checkRelease(root, {
            execute: async () => ({ stdout: " M package.json\n?? pending.ts\n" }),
            latest: async () => "0.2.1",
            loadSsh: () => ({ SERVER_VERSION: "0.1.9", inspectLocalPath: () => ({ allowed: true }) }),
        });
        expect(result.passed).toBe(false);
        expect(result.checks.filter((item) => !item.passed).map((item) => item.name)).toEqual([
            "working_tree", "version_vs_latest", "server_version", "registration_copies", "wsl_ssh_registry_protection",
        ]);
        expect(result.checks.at(-1).detail).toContain("0.1.9");
    });
    it("blocks registry failures and a source tree without git metadata", async () => {
        const result = await guard.checkRelease(path.join(workspace, "npm.akms.mcp-db"), {
            execute: async () => { throw new Error("not a git repository"); },
            latest: async () => { throw new Error("registry unavailable"); },
        });
        expect(result.checks.filter((item) => !item.passed).map((item) => item.name)).toEqual(["working_tree", "version_vs_latest"]);
    });
    it("checks the S3 server's actual profile.ts constant", async () => {
        const root = path.join(workspace, "npm.akms.mcp-s3");
        fs.writeFileSync(path.join(root, "src/profile.ts"), 'export const SERVER_VERSION = "0.2.0";\n');
        const result = await guard.checkRelease(root, clean());
        expect(result.checks.find((item) => item.name === "server_version").passed).toBe(false);
    });
    it("blocks release when the published latest could not be verified", async () => {
        const result = await guard.checkRelease(path.join(workspace, "npm.akms.mcp-s3"), { ...clean(), latest: async () => null });
        expect(result.passed).toBe(false);
        expect(result.checks[1].detail).toContain("could not be verified");
    });
    it("checks new shared files automatically and permits only the launcher's dedicated adapters", async () => {
        const launcher = path.join(workspace, "npm.akms.mcp/src/modules/registration");
        fs.mkdirSync(path.join(launcher, "targets"));
        fs.writeFileSync(path.join(launcher, "targets/codex.ts"), "// launcher adapter\n");
        fs.writeFileSync(path.join(launcher, "paths.ts"), "// launcher paths\n");
        expect(await guard.registrationDifferences(workspace)).toEqual([]);
        fs.writeFileSync(path.join(workspace, "npm.akms.mcp-db/src/modules/registration/startup-check.ts"), "// new shared file\n");
        const differences = await guard.registrationDifferences(workspace);
        expect(differences).toHaveLength(4);
        expect(differences.every((item) => item.includes("startup-check.ts"))).toBe(true);
        fs.writeFileSync(path.join(workspace, "npm.akms.mcp-ssh/src/modules/registration/stale.ts"), "// removed upstream\n");
        expect((await guard.registrationDifferences(workspace)).some((item) => item.includes("stale.ts"))).toBe(true);
    });
    it("rejects a dependency that only denies writes or denies every control path", async () => {
        const root = path.join(workspace, "npm.akms.mcp-wsl");
        await expect(guard.installedSshProtection(root, () => ({ inspectLocalPath: (_file: string, access: string) => ({ allowed: access === "read" }) }))).rejects.toThrow("for read");
        await expect(guard.installedSshProtection(root, () => ({ inspectLocalPath: () => ({ allowed: false }) }))).rejects.toThrow("ordinary-path control");
    });
});

describe("SemVer precedence for release versions", () => {
    it.each([
        ["0.2.1", "0.2.1", 0], ["0.2.1+build.2", "0.2.1+build.1", 0],
        ["0.2.1-rc.1", "0.2.1", -1], ["0.2.1", "0.2.1-rc.1", 1],
        ["0.2.1-beta.10", "0.2.1-beta.2", 1], ["0.2.1-beta", "0.2.1-beta.1", -1],
        ["0.2.1-1", "0.2.1-alpha", -1], ["10.0.0", "2.99.99", 1],
    ])("compares %s and %s", (left, right, expected) => expect(guard.compareVersions(left, right)).toBe(expected));
    it.each(["01.2.3", "1.2", "1.2.3-01", "latest"])("rejects malformed version %s", (version) => {
        expect(() => guard.compareVersions(version, "1.0.0")).toThrow("SemVer");
    });
});

describe("fresh registry metadata", () => {
    it("uses package dist-tags and removes its fresh cache", async () => {
        let cache = "";
        const execute = vi.fn(async (_command: string, args: string[]) => {
            expect(args.slice(1, 4)).toEqual(["view", "@akms/mcp-db", "dist-tags"]);
            expect(args).toContain("--offline=false");
            cache = args[args.indexOf("--cache") + 1];
            expect(fs.readdirSync(cache)).toEqual([]);
            return { stdout: '{"latest":"0.2.0","beta":"0.3.0-beta.1"}' };
        });
        expect(await guard.publishedLatest(workspace, "@akms/mcp-db", execute)).toBe("0.2.0");
        expect(fs.existsSync(cache)).toBe(false);
    });
    it("blocks missing packages, missing latest tags and failed authentication", async () => {
        await expect(guard.publishedLatest(workspace, "@akms/new", async () => { throw { stdout: '{"error":{"code":"E404"}}' }; })).rejects.toThrow("E404");
        await expect(guard.publishedLatest(workspace, "@akms/no-latest", async () => ({ stdout: '{"beta":"0.2.0"}' }))).rejects.toThrow("no valid latest");
        await expect(guard.publishedLatest(workspace, "@akms/auth", async () => { throw { stdout: '{"error":{"code":"E401"}}' }; })).rejects.toThrow("release blocked");
    });
    it("wires identical guards into all five package manifests", () => {
        const source = fs.readFileSync(new URL("../scripts/release-guard.mjs", import.meta.url), "utf8");
        const ownRoot = path.resolve(import.meta.dirname, "..");
        const roots = new Set([ownRoot, ...(guard.CHECKOUTS as string[])
            .map((checkout) => path.join(path.dirname(ownRoot), checkout))
            .filter((root) => fs.existsSync(path.join(root, "package.json")))]);
        for(const root of roots) {
            const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
            expect(manifest.scripts.prepublishOnly).toBe("node scripts/release-guard.mjs");
            expect(fs.readFileSync(path.join(root, "scripts/release-guard.mjs"), "utf8")).toBe(source);
        }
    });
});
