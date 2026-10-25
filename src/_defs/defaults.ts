export const SERVER_NAME = "akms-mcp-db";
export const SERVER_VERSION = "0.3.0";
/** Package identity used to recognize existing MCP entries. */
export const PACKAGE_NAME = "@akms/mcp-db";

export const DEFAULT_POSTGRES_PORT = 5432;
export const DEFAULT_SSH_PORT = 22;

/** Server-side `statement_timeout` — the database itself stops the query. */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 60000;
/** TCP + handshake limit, for the SSH hop and for the database connection each. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 20000;
/** Rows read per statement; the cursor stops there, so a huge table never lands in memory. */
export const DEFAULT_MAX_ROWS = 500;
/** Rendered tool output is cut past this many characters. */
export const DEFAULT_MAX_OUTPUT_CHARACTERS = 100000;
/** Below this a server error's own message (kept up to 1000 characters) could not fit, and the lines saying what was committed would be cut away. */
export const MIN_OUTPUT_CHARACTERS = 2000;
/** Row ceiling for the catalog tools — a schema with hundreds of tables still lists in full. */
export const CATALOG_MAX_ROWS = 5000;

export const SSH_KEEPALIVE_INTERVAL_MS = 15000;
/** Idle time before TCP keepalive probes start on a direct database connection — a silently dropped peer otherwise hangs a call. */
export const TCP_KEEPALIVE_INITIAL_DELAY_MS = 30000;
export const POOL_MAX_CLIENTS = 2;
export const POOL_IDLE_TIMEOUT_MS = 60000;
/** Shutdown waits this long for the pool and the tunnel to close, then exits anyway — a dead tunnel must not keep the process alive. */
export const SHUTDOWN_DEADLINE_MS = 5000;
export const APPLICATION_NAME = "akms-mcp-db";

export const MAX_PORT = 65535;
/** Node's setTimeout and PostgreSQL's integer settings both stop at 2^31-1 — past it Node fires after 1 ms and the server refuses the value. */
export const MAX_TIMER_MS = 2147483647;
/** The cursor asks for maxRows + 1 rows in a 32-bit protocol field. */
export const MAX_ROWS_LIMIT = 2147483646;

export const TRUTHY_ENV_VALUES = ["true", "1", "yes", "on"];
export const FALSY_ENV_VALUES = ["false", "0", "no", "off"];
