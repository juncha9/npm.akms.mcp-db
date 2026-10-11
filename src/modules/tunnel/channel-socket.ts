import { Duplex } from "node:stream";

export type ChannelOpener = (host: string, port: number) => Promise<Duplex>;

/**
 * Stands in for the `net.Socket` that `pg` expects, backed by an SSH forwarding channel.
 *
 * `pg` calls its `stream` factory synchronously, then immediately `setNoDelay()` and
 * `connect(port, host)`, and waits for `'connect'` (pg 8.23 `lib/connection.js`). An SSH channel
 * only exists after an async `forwardOut`, so this object accepts the calls at once, opens the
 * channel inside `connect`, holds writes made before it is open, and emits `'connect'` when
 * it is. No local port is opened — nothing else on this machine can reach the tunnel.
 */
export class ChannelSocket extends Duplex {
    private readonly openChannel: ChannelOpener;
    private channel: Duplex | null = null;
    private pendingWrites: [Buffer | string, BufferEncoding, (error?: Error | null) => void][] = [];

    constructor(openChannel: ChannelOpener) {
        super();
        this.openChannel = openChannel;
    }

    // net.Socket surface that pg touches — there is no TCP socket to tune here
    setNoDelay(): this {
        return this;
    }

    setKeepAlive(): this {
        return this;
    }

    setTimeout(): this {
        return this;
    }

    ref(): this {
        return this;
    }

    unref(): this {
        return this;
    }

    connect(port: number, host: string): this {
        this.openChannel(host, port).then(
            (channel) => {
                // pg gave up first (its connect timeout destroyed this socket); nobody would ever close this channel
                if(this.destroyed == true) {
                    channel.destroy();
                    return;
                }
                this.channel = channel;
                channel.on("data", (chunk: Buffer) => {
                    if(this.push(chunk) == false) {
                        channel.pause();
                    }
                });
                channel.on("end", () => {
                    this.push(null);
                });
                channel.on("close", () => {
                    this.destroy();
                });
                channel.on("error", (error: Error) => {
                    this.destroy(error);
                });
                for(const [chunk, encoding, callback] of this.pendingWrites) {
                    channel.write(chunk, encoding, callback);
                }
                this.pendingWrites = [];
                this.emit("connect");
            },
            (error: Error) => {
                this.destroy(error);
            }
        );
        return this;
    }

    override _read(): void {
        this.channel?.resume();
    }

    override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        if(this.channel == null) {
            this.pendingWrites.push([chunk, encoding, callback]);
            return;
        }
        this.channel.write(chunk, encoding, callback);
    }

    override _final(callback: (error?: Error | null) => void): void {
        this.channel?.end();
        callback();
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this.channel?.destroy();
        for(const [, , pendingCallback] of this.pendingWrites) {
            pendingCallback(error ?? new Error("channel closed before it opened"));
        }
        this.pendingWrites = [];
        callback(error);
    }
}
