import type { Writable } from "node:stream";
import { DB_ENV } from "@/_defs";
import type { DbProfile } from "@/_types";
import { describeError } from "@/_libs/text";
import { PostgresDriver, type CheckReport } from "@/modules/postgres/postgres-driver";
import { loadDbProfile } from "@/modules/profile";

export interface ConnectionCheckResult {
    /** True when every hop — the SSH tunnel when there is one, then the database — answered. */
    connected: boolean;
    /** The key the SSH host presented, pinned or not; null for a direct connection or when the handshake never got there. */
    hostKeyFingerprint: string | null;
}

/**
 * Builds a profile from an entry's env the way the server will at startup — so a value the
 * server would reject is caught here, not when the agent first calls a tool.
 */
export function profileFromEnv(output: Writable, env: Record<string, string>): DbProfile | null {
    try {
        const profile = loadDbProfile(env);
        if(profile == null) {
            output.write("  The entry has no database.\n");
        }
        return profile;
    }
    catch(ex) {
        output.write(`  The server would refuse to start with this entry: ${describeError(ex)}\n`);
        return null;
    }
}

/**
 * Connects the way the server will and reports each hop on its own line — the body of
 * `--check`, shared with the `config` command so a database that passes setup passes `--check`.
 *
 * Without this the only way to find out whether the setup works is to ask an agent to try
 * something, which mixes a setup mistake up with a policy rejection.
 */
export async function runConnectionCheck(profile: DbProfile, output: Writable): Promise<ConnectionCheckResult> {
    let route = "direct";
    if(profile.tunnel != null) {
        route = `via ssh ${profile.tunnel.username}@${profile.tunnel.host}:${profile.tunnel.port}`;
    }
    output.write(`Checking ${profile.name}  →  ${profile.driver} ${profile.user}@${profile.host}:${profile.port}/${profile.database} ${route}\n\n`);

    const driver = new PostgresDriver(profile);
    let report: CheckReport;
    try {
        report = await driver.check();
    }
    finally {
        await driver.close();
    }

    let ok = true;

    if(report.ssh != null) {
        // The key path is shown here but withheld from the runtime error message: the check is
        // run by the operator on their own terminal, whereas that message is handed to a model.
        let auth = "ssh agent";
        if(profile.tunnel?.privateKeyPath != null) {
            auth = `key ${profile.tunnel.privateKeyPath}`;
        }
        else if(profile.tunnel?.password != null) {
            auth = "password";
        }
        if(report.ssh.ok == true) {
            output.write(`  OK      ssh  ${report.ssh.endpoint}  (${auth}, ${report.ssh.durationMs}ms)\n`);
        }
        else {
            ok = false;
            output.write(`  FAILED  ssh  ${report.ssh.endpoint}  (${auth})\n`);
            output.write(`          ${report.ssh.error}\n`);
        }
        if(report.ssh.hostKeyFingerprint != null) {
            let pinNote = `not pinned — set ${DB_ENV.SSH_HOST_KEY} to it to detect a changed key`;
            if(report.ssh.pinned == true) {
                pinNote = "pinned";
                if(report.ssh.hostKeyFingerprint !== profile.tunnel?.hostKeyFingerprint) {
                    pinNote = `does NOT match ${DB_ENV.SSH_HOST_KEY} — the host was rebuilt, or this is not the host you meant`;
                }
            }
            output.write(`          host key ${report.ssh.hostKeyFingerprint}  (${pinNote})\n`);
        }
    }

    if(report.database != null) {
        if(report.database.ok == true) {
            let ssl = "ssl off";
            if(report.database.ssl == true) {
                ssl = "ssl on";
            }
            output.write(`  OK      db   PostgreSQL ${report.database.version} · ${report.database.database} as ${report.database.user} · ${ssl} · statement_timeout ${report.database.statementTimeout}  (${report.database.durationMs}ms)\n`);
        }
        else {
            ok = false;
            output.write(`  FAILED  db   ${profile.host}:${profile.port}/${profile.database}\n`);
            output.write(`          ${report.database.error}\n`);
        }
    }

    return {
        connected: ok,
        hostKeyFingerprint: report.ssh?.hostKeyFingerprint ?? null,
    };
}
