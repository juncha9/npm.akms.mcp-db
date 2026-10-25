import fs from "node:fs";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import type { Client, ConnectConfig } from "ssh2";
import { SSH_KEEPALIVE_INTERVAL_MS } from "@/_defs";
import type { SshTunnelProfile } from "@/_types";
import { $logger } from "@/_libs/logger";

const WINDOWS_AGENT_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";

/** `SHA256:<base64 without padding>` — the string `ssh-keygen -lf` and `@akms/mcp-ssh --check` print. */
export function toHostKeyFingerprint(hostKey: Buffer): string {
    const digest = createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "");
    return `SHA256:${digest}`;
}

/**
 * One SSH connection, opened on first use and reopened on the next use after it drops.
 * Each database connection rides its own forwarding channel over it.
 *
 * Reconnecting quietly is safe here, unlike an interactive shell: a database session has no
 * state on the SSH side worth preserving, and `pg` already treats a dropped stream as a dead client.
 */
export class SshTunnel {
    readonly profile: SshTunnelProfile;
    private readonly connectTimeoutMs: number;
    private client: Client | null = null;
    private connecting: Promise<Client> | null = null;
    private observedFingerprint: string | null = null;
    private closed = false;

    constructor(profile: SshTunnelProfile, connectTimeoutMs: number) {
        this.profile = profile;
        this.connectTimeoutMs = connectTimeoutMs;
    }

    /** Host key the server presented, once a handshake has been attempted. */
    get hostKeyFingerprint(): string | null {
        return this.observedFingerprint;
    }

    get endpoint(): string {
        return `${this.profile.username}@${this.profile.host}:${this.profile.port}`;
    }

    /**
     * Opens a channel to `host:port` as seen from the SSH server — a private hostname such as an
     * RDS endpoint is resolved there, not here.
     */
    async openChannel(host: string, port: number): Promise<Duplex> {
        const client = await this.connect();
        const channel = await new Promise<Duplex>((resolve, reject) => {
            client.forwardOut("127.0.0.1", 0, host, port, (error, stream) => {
                if(error != null) {
                    reject(new Error(`ssh server ${this.profile.host} could not open a channel to ${host}:${port}: ${error.message}`));
                    return;
                }
                resolve(stream);
            });
        });
        return channel;
    }

    /** Connects, or joins the attempt already in flight. */
    async connect(): Promise<Client> {
        if(this.closed == true) {
            throw new Error("ssh tunnel is closed");
        }
        if(this.client != null) {
            return this.client;
        }
        if(this.connecting != null) {
            return await this.connecting;
        }

        const _logger = $logger.child({ context: "SshTunnel", ssh: this.endpoint });
        const attempt = (async () => {
            // Direct PostgreSQL connections never need ssh2 or its crypto runtime.
            const { default: { Client } } = await import("ssh2");
            if(this.closed == true) {
                throw new Error("ssh tunnel is closed");
            }
            const config = this.buildConnectConfig();
            return await new Promise<Client>((resolve, reject) => {
                const client = new Client();
                client.on("ready", () => {
                    // close() ran while the handshake was in flight; keeping this client would leak the connection
                    if(this.closed == true) {
                        client.end();
                        reject(new Error("ssh tunnel is closed"));
                        return;
                    }
                    _logger.info("ssh tunnel connected");
                    this.client = client;
                    resolve(client);
                });
                client.on("error", (error: Error) => {
                    _logger.error(error, "ssh tunnel error");
                    if(this.client === client) {
                        this.client = null;
                    }
                    reject(error);
                });
                client.on("close", () => {
                    if(this.client === client) {
                        _logger.warn("ssh tunnel closed; the next query reconnects");
                        this.client = null;
                    }
                });
                client.connect(config);
            });
        })();
        this.connecting = attempt;
        try {
            return await attempt;
        }
        finally {
            this.connecting = null;
        }
    }

    close(): void {
        this.closed = true;
        this.client?.end();
        this.client = null;
    }

    private buildConnectConfig(): ConnectConfig {
        const profile = this.profile;
        const _logger = $logger.child({ context: "SshTunnel", ssh: this.endpoint });
        const config: ConnectConfig = {
            host: profile.host,
            port: profile.port,
            username: profile.username,
            readyTimeout: this.connectTimeoutMs,
            keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
            hostVerifier: (hostKey: Buffer) => {
                const fingerprint = toHostKeyFingerprint(hostKey);
                this.observedFingerprint = fingerprint;
                if(profile.hostKeyFingerprint == null) {
                    _logger.info("host key accepted unpinned; set DB_SSH_HOST_KEY to pin it", { host_key_fingerprint: fingerprint });
                    return true;
                }
                if(profile.hostKeyFingerprint === fingerprint) {
                    return true;
                }
                _logger.error(null, "host key does not match the pinned fingerprint", {
                    expected: profile.hostKeyFingerprint,
                    actual: fingerprint,
                });
                return false;
            },
        };

        // Key file first, then password, then the SSH agent — the same order as @akms/mcp-ssh
        if(profile.privateKeyPath != null) {
            try {
                config.privateKey = fs.readFileSync(profile.privateKeyPath);
            }
            catch(ex) {
                _logger.error(ex, "cannot read the tunnel's private key file", { private_key_path: profile.privateKeyPath });
                throw new Error("cannot read the private key configured in DB_SSH_KEY (see the server log for the path)");
            }
            config.passphrase = profile.passphrase;
            return config;
        }
        if(profile.password != null) {
            config.password = profile.password;
            return config;
        }
        let agent = process.env.SSH_AUTH_SOCK;
        if((agent == null || agent === "") && process.platform === "win32") {
            agent = WINDOWS_AGENT_PIPE;
        }
        config.agent = agent;
        return config;
    }
}
