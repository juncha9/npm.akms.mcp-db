import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { DEFAULT_POSTGRES_PORT, DEFAULT_SSH_PORT, MAX_PORT } from "@/_defs";
import type { DbDriverName, DbSetupAnswers, SshAuthMethod, SslMode } from "@/_types";
import { expandHomePath } from "@/_libs/env";
import { profileFromEnv, runConnectionCheck } from "./connection-check";
import { SERVER_NAME_PATTERN, answersToEntry } from "./entry";
import { PromptBackError } from "./prompter";
import type { Prompter, SelectChoice, SelectItem } from "./prompter";

/** Listed first when present, in this order — the keys `ssh` itself tries first. */
const PREFERRED_KEY_NAMES = ["id_ed25519", "id_ecdsa", "id_rsa"];

/** Files in `~/.ssh` that are never private keys, skipped without being opened. */
const NON_KEY_FILE_NAMES = ["config", "known_hosts", "known_hosts.old", "authorized_keys", "environment"];

/** Larger than any private key; anything bigger is not opened. */
const MAX_KEY_FILE_BYTES = 64 * 1024;

/** The answer that clears an optional value, since Enter keeps the one shown. */
const CLEAR_ANSWER = "-";

/** Select value for "type a path instead". Not a path a key could have. */
const OTHER_KEY_PATH = "\u0000other";

/** Column the values start at, past the longest setting name ("  SSH passphrase"). */
const FIELD_NAME_WIDTH = 18;

type DbRoute = "direct" | "ssh";

type FieldId =
    | "driver"
    | "host" | "port" | "database" | "user" | "password" | "name"
    | "ssl" | "ssl-ca"
    | "description"
    | "route" | "ssh-host" | "ssh-port" | "ssh-user" | "ssh-auth" | "ssh-key" | "ssh-passphrase" | "ssh-password" | "ssh-host-key"
    | "readonly" | "ddl";

type FormAction = "test" | "save" | "cancel";

type FormValue = FieldId | FormAction;

/** Rows drawn indented under a parent setting. */
const SUB_FIELDS: FieldId[] = ["ssl-ca", "ssh-host", "ssh-port", "ssh-user", "ssh-auth", "ssh-key", "ssh-passphrase", "ssh-password", "ssh-host-key"];

/** Rows a parent setting asks for as follow-ups when it changes; the cursor skips them afterwards. */
const FOLLOW_UPS: Partial<Record<FieldId, FieldId[]>> = {
    "ssl": ["ssl-ca"],
    "route": ["ssh-host", "ssh-port", "ssh-user", "ssh-auth", "ssh-key", "ssh-passphrase", "ssh-password", "ssh-host-key"],
    "ssh-auth": ["ssh-key", "ssh-passphrase", "ssh-password"],
};

const FIELD_NAMES: Record<FieldId, string> = {
    "driver": "Driver",
    "host": "Host",
    "port": "Port",
    "database": "Database",
    "user": "User",
    "password": "Password",
    "name": "Server name",
    "ssl": "SSL",
    "ssl-ca": "CA bundle",
    "description": "Description",
    "route": "Route",
    "ssh-host": "SSH host",
    "ssh-port": "SSH port",
    "ssh-user": "SSH user",
    "ssh-auth": "SSH auth",
    "ssh-key": "SSH key",
    "ssh-passphrase": "SSH passphrase",
    "ssh-password": "SSH password",
    "ssh-host-key": "SSH host key",
    "readonly": "Read-only",
    "ddl": "DDL",
};

/** One per supported driver — a second DBMS adds its row here, and its port default and SSL wording follow the pick. */
const DRIVER_LABELS: Record<DbDriverName, string> = {
    postgres: "PostgreSQL",
};

const AUTH_LABELS: Record<SshAuthMethod, string> = {
    key: "Private key file",
    password: "Password",
    agent: "SSH agent",
};

const ROUTE_LABELS: Record<DbRoute, string> = {
    "direct": "Directly",
    "ssh": "Through an SSH tunnel",
};

const SSL_HINTS: Record<SslMode, string> = {
    require: "encrypted, certificate not checked — the default",
    verify: "certificate checked against the CA bundle, or the system store",
    off: "plain text — RDS refuses this, even inside a tunnel",
};

/** Shown in place of a value the entry cannot do without. */
const REQUIRED_MARK = "(required)";

interface FoundKey {
    /** As written into the entry: `~/.ssh/<name>`, portable across machines. */
    path: string;
    /** Key type and comment from the matching `.pub`, when there is one. */
    hint: string;
}

/** The form's working copy. Settings of a route or auth not chosen are kept until saving. */
interface FormState {
    answers: DbSetupAnswers;
    route: DbRoute;
    /** False while the server name still follows the database name. */
    nameTouched: boolean;
    lastTest: "never" | "ok" | "failed";
    /** The answers at the last successful test; Save offers a test when they differ. */
    testedSnapshot: string | null;
}

export interface DbFormOptions {
    /** Values the form opens on: the stored entry, or a draft brought back from the save preview. Absent for a blank form. */
    existing?: DbSetupAnswers;
    /** The stored name when editing — the one name that is not a clash with itself. */
    originalName?: string;
    /** Heading of the form, "New database" or "Editing <name>". */
    title: string;
    /** Every server name already in the file, ours or not. */
    takenNames: string[];
    /** Where Save writes to, as shown to the user. */
    destination: string;
}

/** What Esc has to put back: the answers and the two flags a pick can change. */
interface FormSnapshot {
    answers: DbSetupAnswers;
    route: DbRoute;
    nameTouched: boolean;
}

function takeSnapshot(state: FormState): FormSnapshot {
    return {
        answers: { ...state.answers, extraEnv: { ...state.answers.extraEnv } },
        route: state.route,
        nameTouched: state.nameTouched,
    };
}

function restoreSnapshot(state: FormState, snapshot: FormSnapshot): void {
    state.answers = { ...snapshot.answers, extraEnv: { ...snapshot.answers.extraEnv } };
    state.route = snapshot.route;
    state.nameTouched = snapshot.nameTouched;
}

/**
 * Private keys in `~/.ssh`, recognized by their first bytes rather than their names —
 * a key called `work` or `aws_master.pem` is as common as `id_ed25519`.
 */
function findPrivateKeys(): FoundKey[] {
    const sshDirectory = path.join(os.homedir(), ".ssh");

    let names: string[] = [];
    try {
        names = fs.readdirSync(sshDirectory);
    }
    catch {
        return [];
    }

    const keys: FoundKey[] = [];
    for(const name of names) {
        if(name.endsWith(".pub") == true || NON_KEY_FILE_NAMES.includes(name) == true) {
            continue;
        }

        const fullPath = path.join(sshDirectory, name);
        let head = "";
        try {
            const stat = fs.statSync(fullPath);
            if(stat.isFile() == false || stat.size > MAX_KEY_FILE_BYTES) {
                continue;
            }

            const descriptor = fs.openSync(fullPath, "r");
            const buffer = Buffer.alloc(64);
            const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
            fs.closeSync(descriptor);
            head = buffer.subarray(0, bytesRead).toString("utf8");
        }
        catch {
            continue;
        }

        const isPemKey = head.startsWith("-----BEGIN") == true && head.includes("PRIVATE KEY") == true;
        const isPuttyKey = head.startsWith("PuTTY-User-Key-File") == true;
        if(isPemKey == false && isPuttyKey == false) {
            continue;
        }

        let hint = "";
        try {
            const publicKey = fs.readFileSync(`${fullPath}.pub`, "utf8").trim().split(/\s+/);
            hint = publicKey[0].replace(/^ssh-/, "");
            if(publicKey.length > 2) {
                hint += ` · ${publicKey.slice(2).join(" ")}`;
            }
        }
        catch {
            // No .pub beside it — the key is still usable, there is just nothing to show.
        }

        keys.push({ path: `~/.ssh/${name}`, hint: hint });
    }

    const rank = (key: FoundKey): number => {
        const index = PREFERRED_KEY_NAMES.indexOf(path.basename(key.path));
        if(index < 0) {
            return PREFERRED_KEY_NAMES.length;
        }
        return index;
    };

    return keys.sort((left, right) => rank(left) - rank(right) || left.path.localeCompare(right.path));
}

async function askPort(prompter: Prompter, question: string, current: number): Promise<number> {
    for(;;) {
        const answer = await prompter.ask(question, String(current));
        const parsed = Number(answer);
        if(Number.isInteger(parsed) == true && parsed > 0 && parsed <= MAX_PORT) {
            return parsed;
        }

        prompter.write(`  Enter a port number between 1 and ${MAX_PORT}.\n`);
    }
}

/** Optional free text: Enter keeps `current`, `-` clears it. */
async function askOptional(prompter: Prompter, question: string, current: string | undefined): Promise<string | undefined> {
    const answer = await prompter.ask(question, current);
    if(answer === "" || answer === CLEAR_ANSWER) {
        return undefined;
    }

    return answer;
}

/**
 * Secret with three outcomes: a new value, keep the existing one (Enter when one exists),
 * or none. Never echoes the secret back.
 */
async function askOptionalSecret(prompter: Prompter, question: string, current: string | undefined): Promise<string | undefined> {
    let suffix = "(empty for none)";
    if(current != null) {
        suffix = `(enter keeps current, ${CLEAR_ANSWER} clears)`;
    }

    const answer = await prompter.askSecret(`${question} ${prompter.paint.dim(suffix)}`);
    if(answer === CLEAR_ANSWER) {
        return undefined;
    }

    if(answer === "") {
        return current;
    }

    return answer;
}

/**
 * Key file: the private keys found in `~/.ssh` as a list, plus "another path". A typed
 * path that does not exist is flagged, since the server would only say so at startup.
 */
async function askKeyPath(prompter: Prompter, current: string | undefined): Promise<string> {
    const found = findPrivateKeys();

    let picked = OTHER_KEY_PATH;
    if(found.length > 0 || current != null) {
        const items: SelectItem<string>[] = [];
        if(current != null && found.some((key) => key.path === current) == false) {
            items.push({ value: current, label: current, hint: "current" });
        }
        for(const key of found) {
            items.push({ value: key.path, label: key.path, hint: key.hint });
        }
        items.push({ separator: true });
        items.push({ value: OTHER_KEY_PATH, key: "other", label: "Another path…" });

        picked = await prompter.select("SSH private key", items, { defaultValue: current ?? found[0]?.path });
    }

    if(picked !== OTHER_KEY_PATH) {
        return picked;
    }

    for(;;) {
        const typed = await prompter.askRequired("SSH private key path");
        if(fs.existsSync(expandHomePath(typed)) == true) {
            return typed;
        }

        prompter.write(`  ${expandHomePath(typed)} does not exist.\n`);
        const useAnyway = await prompter.askYesNo("Use this path anyway?", false);
        if(useAnyway == true) {
            return typed;
        }
    }
}

/**
 * CA bundle for `ssl=verify`: optional, the system store when empty. A path that does not
 * exist is flagged — the server refuses to start without the file — and kept only on request.
 */
async function askCaPath(prompter: Prompter, current: string | undefined): Promise<string | undefined> {
    for(;;) {
        const typed = await askOptional(prompter, "CA bundle path (empty = system store)", current);
        if(typed == null || fs.existsSync(expandHomePath(typed)) == true) {
            return typed;
        }

        prompter.write(`  ${expandHomePath(typed)} does not exist — the server refuses to start without it.\n`);
        const useAnyway = await prompter.askYesNo("Use this path anyway?", false);
        if(useAnyway == true) {
            return typed;
        }
    }
}

function deriveServerName(database: string): string {
    return `pg_${database}`.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48);
}

/** The answers as they will be written: settings of a route, auth or SSL mode not chosen are dropped. */
function finalizeAnswers(state: FormState): DbSetupAnswers {
    const answers: DbSetupAnswers = { ...state.answers };

    if(state.route !== "ssh") {
        answers.sshHost = undefined;
        answers.sshPort = undefined;
        answers.sshUser = undefined;
        answers.sshKeyPath = undefined;
        answers.sshPassphrase = undefined;
        answers.sshPassword = undefined;
        answers.sshHostKeyFingerprint = undefined;
    }

    if(answers.sshAuth !== "key") {
        answers.sshKeyPath = undefined;
        answers.sshPassphrase = undefined;
    }

    if(answers.sshAuth !== "password") {
        answers.sshPassword = undefined;
    }

    if(answers.ssl !== "verify") {
        answers.sslCaPath = undefined;
    }

    return answers;
}

function snapshotOf(state: FormState): string {
    return JSON.stringify(finalizeAnswers(state));
}

/** Settings the entry cannot do without that are still empty, in display order. */
function missingFields(state: FormState): FieldId[] {
    const { answers } = state;
    const missing: FieldId[] = [];

    if(answers.host === "") {
        missing.push("host");
    }
    if(answers.database === "") {
        missing.push("database");
    }
    if(answers.user === "") {
        missing.push("user");
    }
    // An empty name only happens while the database is empty too — the name follows it — so
    // asking for "Database" already covers it.
    if(state.route === "ssh") {
        if(answers.sshHost == null) {
            missing.push("ssh-host");
        }
        if(answers.sshUser == null) {
            missing.push("ssh-user");
        }
        if(answers.sshAuth === "key" && answers.sshKeyPath == null) {
            missing.push("ssh-key");
        }
        if(answers.sshAuth === "password" && answers.sshPassword == null) {
            missing.push("ssh-password");
        }
    }

    return missing;
}

function describePin(fingerprint: string | undefined): string {
    if(fingerprint == null) {
        return "not pinned";
    }

    return `pinned · ${fingerprint.slice(0, 19)}…`;
}

function valueOrRequired(value: string | undefined): string {
    if(value == null || value === "") {
        return REQUIRED_MARK;
    }

    return value;
}

function describeSecret(value: string | undefined): string {
    if(value == null) {
        return "none";
    }

    return "set";
}

function fieldRow(id: FieldId, value: string, hint?: string): SelectChoice<FormValue> {
    let name = FIELD_NAMES[id];
    if(SUB_FIELDS.includes(id) == true) {
        name = `  ${name}`;
    }

    return {
        value: id,
        key: id,
        label: `${name.padEnd(FIELD_NAME_WIDTH)}${value}`,
        hint: hint,
    };
}

/** The form: every setting with its current value, then the actions. */
function buildRows(state: FormState, destination: string): SelectItem<FormValue>[] {
    const { answers } = state;
    const rows: SelectItem<FormValue>[] = [];

    rows.push(fieldRow("driver", DRIVER_LABELS[answers.driver], "the only driver so far"));

    let hostHint: string | undefined;
    if(state.route === "ssh") {
        hostHint = "resolved on the SSH host — a private RDS endpoint works";
    }
    rows.push(fieldRow("host", valueOrRequired(answers.host), hostHint));
    rows.push(fieldRow("port", String(answers.port)));
    rows.push(fieldRow("database", valueOrRequired(answers.database)));
    rows.push(fieldRow("user", valueOrRequired(answers.user)));
    rows.push(fieldRow("password", describeSecret(answers.password), "stored in the config file as plain text"));

    let nameValue = answers.name;
    let nameHint = "what the agent sees";
    if(state.nameTouched == false) {
        nameHint = "follows the database until you change it";
    }
    if(nameValue === "") {
        nameValue = "pg_<database>";
    }
    rows.push(fieldRow("name", nameValue, nameHint));

    rows.push(fieldRow("ssl", answers.ssl, SSL_HINTS[answers.ssl]));
    if(answers.ssl === "verify") {
        rows.push(fieldRow("ssl-ca", answers.sslCaPath ?? "system store", "the RDS bundle is not in Node's default store"));
    }

    rows.push(fieldRow("description", answers.description ?? "none", "shown to the agent"));

    rows.push(fieldRow("route", ROUTE_LABELS[state.route]));
    if(state.route === "ssh") {
        rows.push(fieldRow("ssh-host", valueOrRequired(answers.sshHost)));
        rows.push(fieldRow("ssh-port", String(answers.sshPort ?? DEFAULT_SSH_PORT)));
        rows.push(fieldRow("ssh-user", valueOrRequired(answers.sshUser)));
        rows.push(fieldRow("ssh-auth", AUTH_LABELS[answers.sshAuth]));
        if(answers.sshAuth === "key") {
            rows.push(fieldRow("ssh-key", valueOrRequired(answers.sshKeyPath)));
            rows.push(fieldRow("ssh-passphrase", describeSecret(answers.sshPassphrase)));
        }
        if(answers.sshAuth === "password") {
            let password = REQUIRED_MARK;
            if(answers.sshPassword != null) {
                password = "set";
            }
            rows.push(fieldRow("ssh-password", password, "stored in the config file as plain text"));
        }
        rows.push(fieldRow("ssh-host-key", describePin(answers.sshHostKeyFingerprint)));
    }

    let readonly = "no";
    if(answers.readonly == true) {
        readonly = "yes";
    }
    rows.push(fieldRow("readonly", readonly, "enter toggles · reads only, in BEGIN READ ONLY … ROLLBACK"));

    let ddl = "allowed";
    if(answers.allowDdl == false) {
        ddl = "refused";
    }
    rows.push(fieldRow("ddl", ddl, "enter toggles · CREATE / ALTER / DROP …"));

    rows.push({ separator: true });

    let testHint = "not run yet";
    if(state.lastTest === "ok") {
        testHint = "last run: OK";
    }
    else if(state.lastTest === "failed") {
        testHint = "last run: failed";
    }
    rows.push({ value: "test", key: "test", label: "Test the connection", hint: testHint });
    rows.push({ value: "save", key: "save", label: "Save", hint: `to ${destination}` });
    rows.push({ value: "cancel", key: "cancel", label: "Cancel" });

    return rows;
}

/**
 * Where the cursor goes after a setting is edited: the next row, so pressing Enter down
 * the list fills the form top to bottom. A parent setting skips the rows it just asked for
 * as follow-ups, and the last setting hands over to Save.
 */
function nextCursor(state: FormState, destination: string, edited: FieldId): FormValue {
    if(edited === "readonly" || edited === "ddl") {
        return edited;
    }

    const values = buildRows(state, destination).flatMap((row) => {
        if("value" in row) {
            return [row.value];
        }
        return [];
    });

    const followUps = FOLLOW_UPS[edited] ?? [];
    let index = values.indexOf(edited) + 1;
    while(index < values.length && followUps.includes(values[index] as FieldId) == true) {
        index += 1;
    }

    const next = values[index];
    if(next == null || next === "test") {
        return "save";
    }

    return next;
}

/**
 * Connects with the form's current values. On success, offers to pin an unpinned SSH host
 * key — while the operator is at the terminal anyway, so pinning becomes the default instead
 * of a step nobody takes. A pinned key that changed is offered for re-pinning with No as the
 * default: it is also what an impersonated host looks like.
 *
 * @returns True when every hop answered.
 */
async function testConnection(prompter: Prompter, output: Writable, state: FormState): Promise<boolean> {
    const answers = finalizeAnswers(state);

    output.write("\n");
    const profile = profileFromEnv(output, answersToEntry(answers).env);
    if(profile == null) {
        output.write("\n");
        state.lastTest = "failed";
        return false;
    }

    const result = await runConnectionCheck(profile, output);
    output.write("\n");

    if(result.connected == true) {
        if(result.hostKeyFingerprint != null && state.answers.sshHostKeyFingerprint == null) {
            // Esc here means "not now" — the connection itself still counts as tested.
            try {
                const pin = await prompter.askYesNo("Pin this SSH host key? (a changed key then aborts the connection)", true);
                if(pin == true) {
                    state.answers.sshHostKeyFingerprint = result.hostKeyFingerprint;
                }
            }
            catch(ex) {
                if(ex instanceof PromptBackError == false) {
                    throw ex;
                }
            }
        }

        state.lastTest = "ok";
        state.testedSnapshot = snapshotOf(state);
        return true;
    }

    const hostKeyChanged = result.hostKeyFingerprint != null
        && state.answers.sshHostKeyFingerprint != null
        && result.hostKeyFingerprint !== state.answers.sshHostKeyFingerprint;
    if(hostKeyChanged == true) {
        output.write("  The SSH host presented a different key than the pinned one. Re-pin only if you know it was rebuilt.\n");
        try {
            const repin = await prompter.askYesNo(`Pin ${result.hostKeyFingerprint} instead?`, false);
            if(repin == true) {
                state.answers.sshHostKeyFingerprint = result.hostKeyFingerprint ?? undefined;
                output.write("  Pinned the new key — test again to confirm.\n");
            }
        }
        catch(ex) {
            if(ex instanceof PromptBackError == false) {
                throw ex;
            }
        }
    }

    state.lastTest = "failed";
    return false;
}

/**
 * Edits one setting. A choice that brings new required settings with it (the tunnel route,
 * key auth) asks for them right away, so the form is never left half-filled by a switch.
 */
async function editField(prompter: Prompter, output: Writable, state: FormState, id: FieldId): Promise<void> {
    const { answers } = state;

    if(id === "driver") {
        answers.driver = await prompter.select<DbDriverName>(
            "Driver",
            [
                { value: "postgres", label: DRIVER_LABELS.postgres, hint: "PostgreSQL 12 or later" },
            ],
            { defaultValue: answers.driver },
        );
        return;
    }

    if(id === "host") {
        let current: string | undefined;
        if(answers.host !== "") {
            current = answers.host;
        }
        answers.host = await prompter.askRequired("Database host (hostname or IP)", current);
        return;
    }

    if(id === "port") {
        answers.port = await askPort(prompter, "Database port", answers.port);
        return;
    }

    if(id === "database") {
        let current: string | undefined;
        if(answers.database !== "") {
            current = answers.database;
        }
        answers.database = await prompter.askRequired("Database name", current);
        if(state.nameTouched == false) {
            answers.name = deriveServerName(answers.database);
        }
        return;
    }

    if(id === "user") {
        let current: string | undefined;
        if(answers.user !== "") {
            current = answers.user;
        }
        answers.user = await prompter.askRequired("Database user", current);
        return;
    }

    if(id === "password") {
        answers.password = await askOptionalSecret(prompter, "Database password", answers.password);
        return;
    }

    if(id === "name") {
        let current: string | undefined;
        if(answers.name !== "") {
            current = answers.name;
        }
        for(;;) {
            const name = await prompter.askRequired("Server name the agent sees", current);
            if(SERVER_NAME_PATTERN.test(name) == true) {
                answers.name = name;
                state.nameTouched = true;
                return;
            }
            prompter.write("  Use letters, digits, '-' and '_' only (max 48) — the name becomes part of every tool name.\n");
        }
    }

    if(id === "ssl") {
        answers.ssl = await prompter.select<SslMode>(
            "SSL",
            [
                { value: "require", label: "require", hint: SSL_HINTS.require },
                { value: "verify", label: "verify", hint: SSL_HINTS.verify },
                { value: "off", label: "off", hint: SSL_HINTS.off },
            ],
            { defaultValue: answers.ssl },
        );

        if(answers.ssl === "verify" && answers.sslCaPath == null) {
            answers.sslCaPath = await askCaPath(prompter, undefined);
        }
        return;
    }

    if(id === "ssl-ca") {
        answers.sslCaPath = await askCaPath(prompter, answers.sslCaPath);
        return;
    }

    if(id === "description") {
        answers.description = await askOptional(prompter, "Description shown to the agent", answers.description);
        return;
    }

    if(id === "route") {
        state.route = await prompter.select<DbRoute>(
            "Route",
            [
                { value: "direct", label: ROUTE_LABELS.direct, hint: "the database is reachable from this machine" },
                { value: "ssh", label: ROUTE_LABELS.ssh, hint: "a bastion resolves the database host — RDS behind a VPC" },
            ],
            { defaultValue: state.route },
        );

        if(state.route === "ssh") {
            if(answers.sshHost == null) {
                answers.sshHost = await prompter.askRequired("SSH host");
            }
            if(answers.sshUser == null) {
                answers.sshUser = await prompter.askRequired("SSH user");
            }
            if(answers.sshAuth === "key" && answers.sshKeyPath == null) {
                answers.sshKeyPath = await askKeyPath(prompter, undefined);
            }
            if(answers.sshAuth === "password" && answers.sshPassword == null) {
                answers.sshPassword = await askOptionalSecret(prompter, "SSH password", undefined);
            }
        }
        return;
    }

    if(id === "ssh-host") {
        answers.sshHost = await prompter.askRequired("SSH host", answers.sshHost);
        return;
    }

    if(id === "ssh-port") {
        answers.sshPort = await askPort(prompter, "SSH port", answers.sshPort ?? DEFAULT_SSH_PORT);
        return;
    }

    if(id === "ssh-user") {
        answers.sshUser = await prompter.askRequired("SSH user", answers.sshUser);
        return;
    }

    if(id === "ssh-auth") {
        answers.sshAuth = await prompter.select<SshAuthMethod>(
            "SSH authentication",
            [
                { value: "key", label: AUTH_LABELS.key, hint: "only the path is stored — recommended" },
                { value: "password", label: AUTH_LABELS.password, hint: "stored in the config file as plain text" },
                { value: "agent", label: AUTH_LABELS.agent, hint: "keys already loaded in ssh-agent" },
            ],
            { defaultValue: answers.sshAuth },
        );

        if(answers.sshAuth === "key" && answers.sshKeyPath == null) {
            answers.sshKeyPath = await askKeyPath(prompter, undefined);
        }
        if(answers.sshAuth === "password" && answers.sshPassword == null) {
            answers.sshPassword = await askOptionalSecret(prompter, "SSH password", undefined);
        }
        return;
    }

    if(id === "ssh-key") {
        answers.sshKeyPath = await askKeyPath(prompter, answers.sshKeyPath);
        return;
    }

    if(id === "ssh-passphrase") {
        answers.sshPassphrase = await askOptionalSecret(prompter, "SSH key passphrase", answers.sshPassphrase);
        return;
    }

    if(id === "ssh-password") {
        answers.sshPassword = await askOptionalSecret(prompter, "SSH password", answers.sshPassword);
        return;
    }

    if(id === "readonly") {
        answers.readonly = answers.readonly == false;
        return;
    }

    if(id === "ddl") {
        answers.allowDdl = answers.allowDdl == false;
        return;
    }

    // ssh-host-key: pinned → offer to unpin; unpinned → pinning happens in a test.
    if(answers.sshHostKeyFingerprint != null) {
        const unpin = await prompter.askYesNo(`Unpin ${answers.sshHostKeyFingerprint}?`, false);
        if(unpin == true) {
            answers.sshHostKeyFingerprint = undefined;
        }
        return;
    }

    const missing = missingFields(state);
    if(missing.length > 0) {
        output.write(`  Fill in ${missing.map((field) => FIELD_NAMES[field]).join(", ")} first — the key is pinned by testing the connection.\n`);
        return;
    }

    await testConnection(prompter, output, state);
}

/**
 * The settings form for one database: every setting listed with its value, picked and
 * edited one at a time, in any order, as often as needed. Test and Save sit below the settings.
 *
 * Flow per pick:
 *  1) A setting — edit it, then move the cursor to the next one
 *  2) Test — connect with the current values; offer to pin the SSH host key
 *  3) Save — require what is missing, settle a name clash, offer a test if the values
 *     changed since the last one, and hand the answers back
 *  4) Cancel / Esc — leave; a form with changes asks first
 *
 * Esc inside anything a pick opened — the edit itself, a follow-up question, the save
 * questions — returns to the form with the setting as it was: the state is snapshotted
 * before the pick and restored on `PromptBackError`.
 *
 * On a TTY the form redraws in place: answered prompts leave no trail, since the form
 * itself shows every value.
 *
 * @returns The answers to write, or null when cancelled.
 */
export async function runDbForm(prompter: Prompter, output: Writable, options: DbFormOptions): Promise<DbSetupAnswers | null> {
    const { existing, originalName, title, takenNames, destination } = options;

    let state: FormState;
    if(existing != null) {
        let route: DbRoute = "direct";
        if(existing.sshHost != null) {
            route = "ssh";
        }

        state = { answers: { ...existing }, route: route, nameTouched: true, lastTest: "never", testedSnapshot: null };
    }
    else {
        const foundKeys = findPrivateKeys();
        state = {
            answers: {
                name: "",
                driver: "postgres",
                host: "",
                port: DEFAULT_POSTGRES_PORT,
                database: "",
                user: "",
                ssl: "require",
                sshAuth: "key",
                sshKeyPath: foundKeys[0]?.path,
                readonly: false,
                allowDdl: true,
                extraEnv: {},
            },
            route: "direct",
            nameTouched: false,
            lastTest: "never",
            testedSnapshot: null,
        };
    }

    const initialSnapshot = snapshotOf(state);

    output.write(prompter.paint.dim(`\n  Pick a setting to change it. In a text field, Enter keeps the value shown and ${CLEAR_ANSWER} clears it. Esc goes back.\n\n`));

    const previousTransient = prompter.transient;
    prompter.transient = true;

    try {
        let cursor: FormValue = "host";

        for(;;) {
            const picked = await prompter.select(title, buildRows(state, destination), { defaultValue: cursor, cancelValue: "cancel" });
            const before = takeSnapshot(state);

            try {
                // (4) Cancel
                if(picked === "cancel") {
                    if(snapshotOf(state) !== initialSnapshot) {
                        const discard = await prompter.askYesNo("Discard the changes?", false);
                        if(discard == false) {
                            continue;
                        }
                    }
                    return null;
                }

                const missing = missingFields(state);

                // (2) Test
                if(picked === "test") {
                    if(missing.length > 0) {
                        output.write(`  Fill in ${missing.map((field) => FIELD_NAMES[field]).join(", ")} first.\n`);
                        cursor = missing[0];
                        continue;
                    }

                    const connected = await testConnection(prompter, output, state);
                    cursor = "test";
                    if(connected == true) {
                        cursor = "save";
                    }
                    continue;
                }

                // (3) Save
                if(picked === "save") {
                    if(missing.length > 0) {
                        output.write(`  Fill in ${missing.map((field) => FIELD_NAMES[field]).join(", ")} first.\n`);
                        cursor = missing[0];
                        continue;
                    }

                    const name = state.answers.name;
                    if(name !== originalName && takenNames.includes(name) == true) {
                        const replace = await prompter.askYesNo(`"${name}" already exists in this file. Replace it?`, false);
                        if(replace == false) {
                            cursor = "name";
                            continue;
                        }
                    }

                    if(snapshotOf(state) !== state.testedSnapshot) {
                        const testFirst = await prompter.askYesNo("Test the connection before saving?", true);
                        if(testFirst == true) {
                            const connected = await testConnection(prompter, output, state);
                            if(connected == false) {
                                const next = await prompter.select(
                                    "The check failed. What now?",
                                    [
                                        { value: "back", key: "back", label: "Back to the settings" },
                                        { value: "save", key: "save", label: "Save anyway", hint: "the database may be unreachable from here" },
                                        { value: "discard", key: "discard", label: "Discard", hint: "nothing is written" },
                                    ],
                                    { defaultValue: "back", cancelValue: "back" },
                                );

                                if(next === "discard") {
                                    return null;
                                }

                                if(next === "back") {
                                    cursor = "test";
                                    continue;
                                }
                            }
                        }
                    }

                    return finalizeAnswers(state);
                }

                // (1) A setting
                await editField(prompter, output, state, picked);
                cursor = nextCursor(state, destination, picked);
            }
            catch(ex) {
                // Esc anywhere a pick opened: the form comes back exactly as it was, cursor on the row.
                if(ex instanceof PromptBackError == false) {
                    throw ex;
                }
                restoreSnapshot(state, before);
                cursor = picked;
            }
        }
    }
    finally {
        prompter.transient = previousTransient;
    }
}
