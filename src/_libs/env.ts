import os from "node:os";
import path from "node:path";
import { FALSY_ENV_VALUES, TRUTHY_ENV_VALUES } from "@/_defs";

// A malformed value fails startup instead of being read as "not set" —
// `DB_READONLY=ture` must not quietly mean "writable".

export type EnvSource = Record<string, string | undefined>;

/** Trimmed value, or undefined when the variable is missing or blank. */
export function readEnv(env: EnvSource, name: string): string | undefined {
    const value = env[name];
    if(value == null) {
        return undefined;
    }
    const trimmed = value.trim();
    if(trimmed === "") {
        return undefined;
    }
    return trimmed;
}

export function readBooleanEnv(env: EnvSource, name: string): boolean | undefined {
    const value = readEnv(env, name);
    if(value == null) {
        return undefined;
    }
    const normalized = value.toLowerCase();
    if(TRUTHY_ENV_VALUES.includes(normalized) == true) {
        return true;
    }
    if(FALSY_ENV_VALUES.includes(normalized) == false) {
        throw new Error(`${name} must be one of ${[...TRUTHY_ENV_VALUES, ...FALSY_ENV_VALUES].join(", ")} (got "${value}")`);
    }
    return false;
}

/** Untrimmed value, or undefined when missing or empty — spaces around a password may be part of it. */
export function readSecretEnv(env: EnvSource, name: string): string | undefined {
    const value = env[name];
    if(value == null || value === "") {
        return undefined;
    }
    return value;
}

/** A positive integer no larger than `maximum` — a port past 65535 or a timer past 2^31-1 fails here, not at the first query. */
export function readIntegerEnv(env: EnvSource, name: string, maximum: number = Number.MAX_SAFE_INTEGER): number | undefined {
    const value = readEnv(env, name);
    if(value == null) {
        return undefined;
    }
    const parsed = Number(value);
    if(Number.isInteger(parsed) == false || parsed <= 0 || parsed > maximum) {
        throw new Error(`${name} must be a positive integer up to ${maximum} (got "${value}")`);
    }
    return parsed;
}

/** `~/x` → `<home>/x`; anything else resolved to an absolute path. */
export function expandHomePath(inputPath: string): string {
    if(inputPath === "~") {
        return os.homedir();
    }
    if(inputPath.startsWith("~/") == true || inputPath.startsWith("~\\") == true) {
        return path.join(os.homedir(), inputPath.slice(2));
    }
    return path.resolve(inputPath);
}
