// Development only. Each repository keeps its own bundled copy; no sibling checkout
// or @akms/mcp installation is needed to build, install or run a published package.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/modules/registration");
const root = path.resolve(source, "../../../..");
for(const name of ["npm.akms.mcp-ssh", "npm.akms.mcp-wsl", "npm.akms.mcp-s3", "npm.akms.mcp"]) {
    const destination = path.join(root, name, "src/modules/registration");
    if(!fs.existsSync(path.join(root, name, "package.json"))) throw new Error(`Missing sibling checkout: ${name}`);
    fs.mkdirSync(destination, { recursive: true });
    for(const file of ["types.ts", "registry.ts", "menu.ts", "comparison.ts", "runtime.ts", "runtime-menu.ts", "config-file.ts", "startup-check.ts", "updates-menu.ts", "catalog.ts", "migration-menu.ts"]) {
        fs.copyFileSync(path.join(source, file), path.join(destination, file));
    }
    fs.writeFileSync(path.join(destination, "prompter.ts"), fs.readFileSync(path.join(source, "prompter.ts"), "utf8")
        .replaceAll("../manage/prompter", name === "npm.akms.mcp" ? "../launcher/prompter" : "../manage/prompter"));
}
