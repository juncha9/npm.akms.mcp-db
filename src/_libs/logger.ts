import { LOG_LEVEL_ENV } from "@/_defs";

// stdout carries the MCP protocol stream, so every log line goes to stderr.

type LogLevel = "silent" | "debug" | "info" | "warn" | "error";
type LogMeta = Record<string, unknown>;

export interface Logger {
    child(meta: LogMeta): Logger;
    debug(message: string, meta?: LogMeta): void;
    info(message: string, meta?: LogMeta): void;
    warn(message: string, meta?: LogMeta): void;
    error(error: unknown, message: string, meta?: LogMeta): void;
}

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
    silent: 0,
    debug: 1,
    info: 2,
    warn: 3,
    error: 4,
};

const SECRET_META_KEYS = ["password", "passphrase", "privatekey", "privatekeypath", "secret", "token", "url"];

function resolveThreshold(): LogLevel {
    const configured = process.env[LOG_LEVEL_ENV];
    if(configured == null) {
        return "info";
    }
    const normalized = configured.toLowerCase();
    if(Object.hasOwn(LEVEL_WEIGHTS, normalized) == false) {
        return "info";
    }
    return normalized as LogLevel;
}

function write(level: Exclude<LogLevel, "silent">, message: string, meta: LogMeta): void {
    const threshold = resolveThreshold();
    if(threshold === "silent") {
        return;
    }
    if(LEVEL_WEIGHTS[level] < LEVEL_WEIGHTS[threshold]) {
        return;
    }

    const masked: LogMeta = {};
    for(const [key, value] of Object.entries(meta)) {
        if(SECRET_META_KEYS.includes(key.toLowerCase()) == true) {
            masked[key] = "***";
            continue;
        }
        masked[key] = value;
    }

    let line = `${new Date().toISOString()} [${level}] ${message}`;
    if(Object.keys(masked).length > 0) {
        line += ` ${JSON.stringify(masked)}`;
    }
    process.stderr.write(`${line}\n`);
}

function createLogger(boundMeta: LogMeta): Logger {
    return {
        child(meta) {
            return createLogger({ ...boundMeta, ...meta });
        },
        debug(message, meta) {
            write("debug", message, { ...boundMeta, ...meta });
        },
        info(message, meta) {
            write("info", message, { ...boundMeta, ...meta });
        },
        warn(message, meta) {
            write("warn", message, { ...boundMeta, ...meta });
        },
        error(error, message, meta) {
            const errorMeta: LogMeta = { ...boundMeta, ...meta };
            if(error instanceof Error) {
                errorMeta.error_name = error.name;
                errorMeta.error_message = error.message;
                errorMeta.stack = error.stack;
            }
            else if(error != null) {
                errorMeta.error_message = String(error);
            }
            write("error", message, errorMeta);
        },
    };
}

export const $logger = createLogger({});
