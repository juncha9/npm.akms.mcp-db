import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { describeError } from "@/_libs/text";
import { ChannelSocket } from "@/modules/tunnel/channel-socket";

describe("describeError", () => {
    it("reads the reasons out of the empty AggregateError a refused connect to localhost throws", () => {
        const refusedV6 = Object.assign(new Error("connect ECONNREFUSED ::1:5433"), { code: "ECONNREFUSED" });
        const refusedV4 = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5433"), { code: "ECONNREFUSED" });
        const aggregate = Object.assign(new AggregateError([refusedV6, refusedV4], ""), { code: "ECONNREFUSED" });
        expect(describeError(aggregate)).toBe("connect ECONNREFUSED ::1:5433; connect ECONNREFUSED 127.0.0.1:5433");
    });

    it("falls back to the code of an error with no message", () => {
        expect(describeError(Object.assign(new Error(""), { code: "EPIPE" }))).toBe("EPIPE");
        expect(describeError(new Error("plain"))).toBe("plain");
        expect(describeError("text")).toBe("text");
    });
});

describe("ChannelSocket", () => {
    it("closes a channel that opens after pg already gave up on the socket — nothing else would", async () => {
        const channel = new PassThrough();
        const socket = new ChannelSocket(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return channel;
        });
        let connected = false;
        socket.on("connect", () => {
            connected = true;
        });
        socket.on("error", () => undefined);
        socket.connect(5432, "db.internal");
        socket.destroy(new Error("timeout expired"));

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(channel.destroyed).toBe(true);
        expect(connected).toBe(false);
    });
});
