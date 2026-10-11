import net from "node:net";

// Sits between the driver and the database to break things on cue: drop a connection the
// moment a marker passes through it, end a session with a FATAL right after the server
// answered a command, and record what each new connection sends first (a CancelRequest
// arrives on a connection of its own).

export interface TcpProxy {
    port: number;
    /** First chunk each client connection sent, in arrival order. */
    firstChunks: Buffer[];
    /** Destroys both sides of the connection whose client→server bytes next contain `marker`. */
    dropWhenSeen(marker: string): void;
    /**
     * From the moment `marker` passes, forwards nothing on that connection in either direction but
     * keeps both sockets open — a database gone silent behind a hop that still holds the TCP session.
     */
    blackholeWhenSeen(marker: string): void;
    /**
     * After the next CommandComplete whose tag starts with `commandTag` and the ReadyForQuery
     * behind it, sends a FATAL 57P01 and closes — what a shutdown or failover does right after
     * a COMMIT went through.
     */
    fatalAfterReply(commandTag: string): void;
    stop(): Promise<void>;
}

/** ErrorResponse 'E': severity FATAL, SQLSTATE 57P01, the server's shutdown message. */
function buildFatalMessage(): Buffer {
    const fields = Buffer.concat([
        Buffer.from("SFATAL\0VFATAL\0C57P01\0Mterminating connection due to administrator command\0", "utf8"),
        Buffer.from([0]),
    ]);
    const header = Buffer.alloc(5);
    header.write("E", 0, "ascii");
    header.writeInt32BE(fields.length + 4, 1);
    return Buffer.concat([header, fields]);
}

export async function startTcpProxy(targetPort: number): Promise<TcpProxy> {
    const sockets = new Set<net.Socket>();
    const firstChunks: Buffer[] = [];
    let dropMarker: string | null = null;
    let blackholeMarker: string | null = null;
    let fatalTag: string | null = null;

    const server = net.createServer((client) => {
        const upstream = net.connect(targetPort, "127.0.0.1");
        sockets.add(client);
        sockets.add(upstream);
        let sawFirstChunk = false;
        // Server→client bytes not yet split into whole messages, and whether the armed tag was just answered
        let pending = Buffer.alloc(0);
        let tagAnswered = false;
        let silent = false;

        client.on("data", (chunk: Buffer) => {
            if(sawFirstChunk == false) {
                sawFirstChunk = true;
                firstChunks.push(Buffer.from(chunk));
            }
            if(dropMarker != null && chunk.includes(dropMarker) == true) {
                dropMarker = null;
                client.destroy();
                upstream.destroy();
                return;
            }
            if(blackholeMarker != null && chunk.includes(blackholeMarker) == true) {
                blackholeMarker = null;
                silent = true;
            }
            if(silent == true) {
                return;
            }
            upstream.write(chunk);
        });
        upstream.on("data", (chunk: Buffer) => {
            if(silent == true) {
                return;
            }
            if(fatalTag == null) {
                client.write(chunk);
                return;
            }
            // [type byte][int32 length including itself][body] — forwarded message by message so the FATAL lands right after the ReadyForQuery
            pending = Buffer.concat([pending, chunk]);
            while(pending.length >= 5) {
                const length = pending.readInt32BE(1);
                if(pending.length < length + 1) {
                    break;
                }
                const message = pending.subarray(0, length + 1);
                pending = pending.subarray(length + 1);
                client.write(message);
                const type = String.fromCharCode(message[0]);
                if(type === "C" && fatalTag != null && message.subarray(5).toString("utf8").startsWith(fatalTag) == true) {
                    tagAnswered = true;
                }
                if(type === "Z" && tagAnswered == true) {
                    fatalTag = null;
                    client.write(buildFatalMessage());
                    client.end();
                    upstream.destroy();
                    return;
                }
            }
        });
        client.on("close", () => {
            upstream.destroy();
            sockets.delete(client);
        });
        upstream.on("close", () => {
            client.destroy();
            sockets.delete(upstream);
        });
        client.on("error", () => undefined);
        upstream.on("error", () => undefined);
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as net.AddressInfo;

    return {
        port: address.port,
        firstChunks: firstChunks,
        dropWhenSeen(marker: string) {
            dropMarker = marker;
        },
        blackholeWhenSeen(marker: string) {
            blackholeMarker = marker;
        },
        fatalAfterReply(commandTag: string) {
            fatalTag = commandTag;
        },
        async stop() {
            for(const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        },
    };
}
