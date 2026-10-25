import type { Registry } from "../registration/registry";
import { ManagedSession } from "../registration/menu";
import type { ManagementMode } from "../registration/menu";
import type { Readable, Writable } from "node:stream";
import { DB_ENV, SERVER_VERSION } from "@/_defs";
import type { ConfigTarget, ConfigWriteResult, DbSetupAnswers, McpServerEntry } from "@/_types";
import { describeError } from "@/_libs/text";
import { profileFromEnv, runConnectionCheck } from "./connection-check";
import { runDbForm } from "./db-form";
import { copyEntryToClient } from "./copy-entry";
import { answersToEntry, entryToAnswers, isOurEntry, summarizeEntry } from "./entry";
import { PromptBackError, PromptClosedError, Prompter, displayWidth } from "./prompter";
import type { SelectItem } from "./prompter";
import { formatClaudeAddCommand, listConfigTargets, renderMcpServerTable } from "./targets";

export { runConnectionCheck } from "./connection-check";
export type { ConnectionCheckResult } from "./connection-check";

/** Env values masked in the on-screen preview; the print view shows them, since it is for pasting. */
const SECRET_ENV_NAMES: string[] = [
    DB_ENV.PASSWORD,
    DB_ENV.URL,
    DB_ENV.SSH_PASSWORD,
    DB_ENV.SSH_PASSPHRASE,
];

/** Prefix of a database row's select value, so a database named like an action can't collide with it. */
const DATABASE_VALUE_PREFIX = "db:";

export interface ConfigCommandOptions {
    input: Readable;
    output: Writable;
    /** Supported clients; tests pass their own so nothing under the real home is touched. */
    targets?: ConfigTarget[];
    /** Client to open on; defaults to the first detected one. */
    targetId?: string;
    registryPath?: string;
    mode?: ManagementMode;
    runtimeOptions?: Registry["runtimeOptions"]; management?: ManagedSession;
}

function maskSecrets(entry: McpServerEntry): McpServerEntry {
    const env: Record<string, string> = {};
    for(const [name, value] of Object.entries(entry.env)) {
        if(SECRET_ENV_NAMES.includes(name) == true) {
            env[name] = "********";
            continue;
        }
        env[name] = value;
    }

    return { ...entry, env: env };
}

/** The entry as it reads inside the target's own file — a TOML table for Codex, JSON otherwise. */
function formatForTarget(target: ConfigTarget, name: string, entry: McpServerEntry): string {
    if(target.id === "codex") {
        return renderMcpServerTable(name, entry);
    }

    return `"${name}": ${JSON.stringify(entry, null, 4)}\n`;
}

function indent(text: string): string {
    return text.replace(/\n$/, "").split("\n").map((line) => `    ${line}`).join("\n");
}

function reportWrite(prompter: Prompter, result: ConfigWriteResult, action: string): void {
    prompter.clearScreen();
    if(result.status === "written") {
        prompter.write(`  ${prompter.paint.success(action)} ${prompter.paint.dim(result.detail)}\n`);
        prompter.write(prompter.paint.dim("  Restart the client (or reconnect it from its MCP menu) to pick up the change.\n\n"));
        return;
    }

    prompter.write(`  Not ${action.toLowerCase()}: ${result.detail}\n\n`);
}

/**
 * Add (no `existingName`) or edit one database: the settings form → preview → write. Esc at
 * the preview reopens the form on the same values. A renamed database is written under the
 * new name first, then the old name removed, so a failed write never leaves it unregistered.
 */
async function addOrEditDatabase(
    prompter: Prompter,
    output: Writable,
    target: ConfigTarget,
    entries: Record<string, McpServerEntry>,
    existingName?: string,
    management?: ManagedSession,
): Promise<void> {
    let title = "New database";
    let draft: DbSetupAnswers | undefined;
    if(existingName != null) {
        title = `Editing ${existingName}`;
        draft = entryToAnswers(existingName, entries[existingName]);
    }

    for(;;) {
        const answers = await runDbForm(prompter, output, {
            existing: draft,
            originalName: existingName,
            title: title,
            takenNames: Object.keys(entries),
            destination: target.label,
        });
        if(answers == null) {
            output.write("  Cancelled — nothing was written.\n\n");
            await prompter.acknowledge();
            return;
        }

        let entry = answersToEntry(answers);
        entry = target.prepareEntry?.(answers.name, entry, existingName) ?? entry;
        prompter.clearScreen();
        output.write(`\n  ${prompter.paint.dim(`This goes into ${target.location}:`)}\n\n`);
        output.write(`${indent(formatForTarget(target, answers.name, maskSecrets(entry)))}\n\n`);

        let confirmed: boolean;
        try {
            confirmed = await prompter.askYesNo(target.id === "registered" ? "Save and apply to all registered services?" : "Write it?", true);
        }
        catch(ex) {
            if(ex instanceof PromptBackError == false) {
                throw ex;
            }
            draft = answers;
            continue;
        }

        if(confirmed == false) {
            output.write("  Not written. Pick the database and choose Print to get the entry ready to paste.\n\n");
            await prompter.acknowledge();
            return;
        }

        const written = (existingName && existingName !== answers.name && target.renameEntry ? target.renameEntry(existingName, answers.name, entry) : target.writeEntry(answers.name, entry));
        reportWrite(prompter, written, "Written");

        if(written.status === "written" && existingName != null && existingName !== answers.name && !target.renameEntry) {
            const removed = target.removeEntry(existingName);
            if(removed.status === "unavailable") {
                output.write(`  The old name ${existingName} is still there: ${removed.detail}\n\n`);
            }
        }
        if(written.status === "written") await management?.checkSaved(prompter, answers.name, existingName ? entries[existingName] : undefined);
        await prompter.acknowledge();
        return;
    }
}

/** Connects with a stored entry, and offers to pin an unpinned SSH host key by adding just that line. */
async function checkDatabase(
    prompter: Prompter,
    output: Writable,
    target: ConfigTarget,
    name: string,
    entry: McpServerEntry,
    management?: ManagedSession,
): Promise<void> {
    output.write("\n");
    const profile = profileFromEnv(output, entry.env);
    if(profile == null) {
        output.write("\n");
        await prompter.pause();
        return;
    }

    const result = await runConnectionCheck(profile, output);
    output.write("\n");
    await prompter.pause();

    if(result.connected == false) {
        return;
    }

    if(result.hostKeyFingerprint != null && entry.env[DB_ENV.SSH_HOST_KEY] == null) {
        const pin = await prompter.askYesNo("Pin this SSH host key?", true);
        if(pin == true) {
            const env = { ...entry.env, [DB_ENV.SSH_HOST_KEY]: result.hostKeyFingerprint };
            if(management && !await management.prepareRuntime(prompter, entry)) return;
            const written = target.writeEntry(name, { ...entry, env: env });
            reportWrite(prompter, written, "Pinned");
            await prompter.acknowledge();
        }
    }
}

/** Every form the entry can be pasted in, real secrets included — this view exists to be copied. */
function printDatabase(prompter: Prompter, name: string, entry: McpServerEntry): void {
    prompter.write(`\n  ${prompter.paint.dim("JSON — Claude Desktop, Cursor, .mcp.json (inside \"mcpServers\"):")}\n\n`);
    prompter.write(`${indent(`"${name}": ${JSON.stringify(entry, null, 4)}`)}\n\n`);
    prompter.write(`  ${prompter.paint.dim("TOML — Codex (~/.codex/config.toml):")}\n\n`);
    prompter.write(`${indent(renderMcpServerTable(name, entry))}\n\n`);
    prompter.write(`  ${prompter.paint.dim("Claude Code CLI (bash / zsh / Git Bash):")}\n\n`);
    prompter.write(`${indent(formatClaudeAddCommand(name, entry))}\n\n`);
}

/** The database rows of the main menu: name, endpoint, route and settings, aligned into columns. */
function buildDatabaseItems(names: string[], entries: Record<string, McpServerEntry>): SelectItem<string>[] {
    const nameWidth = Math.max(...names.map((name) => displayWidth(name)));
    const summaries = names.map((name) => summarizeEntry(entries[name]));
    const endpointWidth = Math.max(...summaries.map((summary) => displayWidth(summary.endpoint)));

    return names.map((name, index) => {
        const summary = summaries[index];
        const hintParts = [summary.route];
        if(summary.notes !== "") {
            hintParts.push(summary.notes);
        }

        return {
            value: `${DATABASE_VALUE_PREFIX}${name}`,
            key: name,
            label: `${name.padEnd(nameWidth)}  ${summary.endpoint.padEnd(endpointWidth)}`,
            hint: hintParts.join(" · "),
        };
    });
}

/**
 * What to do with one picked database. Esc at the menu goes back to the list; Esc inside a
 * question an action opened comes back to this menu.
 */
async function manageDatabase(
    prompter: Prompter,
    output: Writable,
    target: ConfigTarget,
    targets: ConfigTarget[],
    entries: Record<string, McpServerEntry>,
    name: string,
    management?: ManagedSession,
): Promise<void> {
    for(;;) {
        const action = await prompter.select(
            name,
            [
                { value: "edit", key: "e", label: "Edit", hint: "open its settings" },
                { value: "check", key: "c", label: "Check the connection", hint: "connect now and offer to pin the SSH host key" },
                { value: "print", key: "p", label: "Print the entry", hint: "JSON, Codex TOML and a claude command, ready to paste" },
                ...targets.some((candidate) => candidate.id !== target.id)
                    ? [{ value: "copy", key: "o", label: "Copy to another client", hint: "keep this entry and copy its settings" }]
                    : [],
                { value: "remove", key: "r", label: "Remove", hint: `from ${target.label}` },
                { separator: true },
                { value: "back", key: "b", label: "Back" },
            ],
            { defaultValue: "edit", cancelValue: "back" },
        );

        try {
            prompter.clearScreen();

            if(action === "edit") {
                if(management && !await management.prepareRuntime(prompter, entries[name])) return;
                await addOrEditDatabase(prompter, output, target, entries, name, management);
                return;
            }

            if(action === "check") {
                await checkDatabase(prompter, output, target, name, entries[name], management);
                return;
            }

            if(action === "print") {
                printDatabase(prompter, name, entries[name]);
                await prompter.acknowledge();
                return;
            }

            if(action === "copy") {
                await copyEntryToClient(prompter, target, targets, name, entries[name]);
                await prompter.acknowledge();
                return;
            }

            if(action === "remove") {
                const remove = await prompter.askYesNo(`Remove ${name} from ${target.location}?`, false);
                if(remove == true) {
                    reportWrite(prompter, target.removeEntry(name), "Removed");
                    await prompter.acknowledge();
                }
            }
            return;
        }
        catch(ex) {
            if(ex instanceof PromptBackError == false) {
                throw ex;
            }
        }
    }
}

/**
 * `akms-mcp-db config` — an interactive manager for the databases registered in an MCP
 * client's config. The databases themselves are the menu: pick one to edit, check, copy, print or
 * remove it, or pick an action below them. The `DB_*` names never have to be typed.
 *
 * @returns Process exit code.
 */
export async function runTargetConfigCommand(options: ConfigCommandOptions): Promise<number> {
    const { input, output } = options;
    const targets = options.targets ?? listConfigTargets();

    let target = targets[0];
    if(options.targetId != null) {
        const requested = targets.find((candidate) => candidate.id === options.targetId);
        if(requested == null) {
            output.write(`Unknown client "${options.targetId}". One of: ${targets.map((candidate) => candidate.id).join(", ")}\n`);
            return 1;
        }
        target = requested;
    }

    const prompter = new Prompter(input, output);
    const paint = prompter.paint;

    try {
        if(options.management && !await options.management.initialize(prompter)) return 0;
        for(;;) {
            let entries: Record<string, McpServerEntry> = {};
            let names: string[] = [];
            let readError: string | null = null;

            try {
                entries = target.readEntries();
                names = Object.keys(entries).filter((name) => isOurEntry(entries[name]) == true);
            }
            catch(ex) {
                readError = describeError(ex);
            }

            // (1) Where we are
            prompter.clearScreen();
            if(options.management) {
                output.write(paint.bold("Database connections") + "\n");
                options.management.writeStatus(prompter);
            } else output.write(`\n${paint.bold(target.label)}  ${paint.dim(target.location)}\n`);
            if(readError != null) {
                output.write(`  Cannot read it: ${readError}\n  Fix the file by hand, or switch to another client.\n`);
            }
            else {
                const otherCount = Object.keys(entries).length - names.length;
                if(otherCount > 0) {
                    output.write(paint.dim(`  ${otherCount} other MCP server(s) in this file are not managed here.\n`));
                }
            }
            output.write("\n");

            // (2) The databases are the menu; actions follow them
            const items: SelectItem<string>[] = [];
            if(names.length > 0) {
                items.push(...buildDatabaseItems(names, entries));
                items.push({ separator: true });
            }
            if(readError == null) {
                items.push({ value: "add", key: "a", label: "Add a database" });
            }

            const otherTargets = targets.filter((candidate) => candidate.id !== target.id);
            if(otherTargets.length > 0) {
                const detectedOthers = otherTargets.filter((candidate) => candidate.detected == true).map((candidate) => candidate.label);
                let switchHint = "";
                if(detectedOthers.length > 0) {
                    switchHint = `also found: ${detectedOthers.join(", ")}`;
                }
                items.push({ value: "switch", key: "t", label: "Switch client", hint: switchHint });
            }
            if(options.management) { options.management.decorate(items); items.push(...options.management.items()); }
            items.push({ value: "quit", key: "q", label: "Quit" });

            let question = "No databases here yet";
            if(names.length === 1) {
                question = "1 database — pick it to manage it";
            }
            else if(names.length > 1) {
                question = `${names.length} databases — pick one to manage it`;
            }

            let defaultValue = "add";
            if(names.length > 0) {
                defaultValue = `${DATABASE_VALUE_PREFIX}${names[0]}`;
            }

            const picked = await prompter.select(question, items, { defaultValue: defaultValue, cancelValue: "quit" });

            if(picked === "quit") {
                return 0;
            }

            prompter.clearScreen();
            if(options.management && await options.management.handle(picked, prompter)) continue;

            if(picked === "switch") {
                const switched = await prompter.select(
                    "Which client?",
                    targets.map((candidate) => {
                        let hint = candidate.location;
                        if(candidate.detected == false) {
                            hint += " · not found on this machine";
                        }
                        return { value: candidate.id, label: candidate.label, hint: hint };
                    }),
                    { defaultValue: target.id, cancelValue: target.id },
                );
                target = targets.find((candidate) => candidate.id === switched) ?? target;
                continue;
            }

            // (3) Act — a failure is reported and the menu comes back, rather than exiting
            try {
                if(picked === "add") {
                    await addOrEditDatabase(prompter, output, target, entries, undefined, options.management);
                    continue;
                }

                if(picked.startsWith(DATABASE_VALUE_PREFIX) == true) {
                    await manageDatabase(prompter, output, target, targets, entries, picked.slice(DATABASE_VALUE_PREFIX.length), options.management);
                }
            }
            catch(ex) {
                if(ex instanceof PromptClosedError) {
                    throw ex;
                }
                // Esc that no level below claimed: this menu is the level above.
                if(ex instanceof PromptBackError) {
                    continue;
                }
                output.write(`  Failed: ${describeError(ex)}\n\n`);
                await prompter.acknowledge();
            }
        }
    }
    catch(ex) {
        // Input ending (Ctrl+C, Ctrl+D, a piped script running out) is a way to leave, not a crash.
        if(ex instanceof PromptClosedError) {
            output.write("\n");
            return 0;
        }
        throw ex;
    }
    finally {
        prompter.close();
    }
}

/** Independent registration and shared connection management; never invokes @akms/mcp. */
export async function runConfigCommand(options: ConfigCommandOptions): Promise<number> {
    const management = new ManagedSession({ kind: "db", version: SERVER_VERSION, targets: options.targets ?? listConfigTargets(), registryPath: options.registryPath, mode: options.mode, targetId: options.targetId, runtimeOptions: options.runtimeOptions });
    return runTargetConfigCommand({ ...options, targets: [management.target], targetId: undefined, management });
}
