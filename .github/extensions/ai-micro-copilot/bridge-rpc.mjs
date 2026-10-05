// SPDX-License-Identifier: MIT
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";

const limit = 1024 * 1024;

export class BridgePeer extends EventEmitter {
    constructor(socket, handle = async () => { throw new Error("Unsupported bridge request"); }) {
        super();
        this.socket = socket; this.handle = handle;
        this.pending = new Map(); this.sequence = 0; this.closed = false;
        let buffer = "", active = 0;
        socket.setEncoding("utf8");
        socket.on("data", chunk => {
            buffer += chunk;
            if (Buffer.byteLength(buffer) > limit) return this.close(new Error("Bridge frame exceeds 1 MiB"));
            let end;
            while ((end = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
                let frame;
                try { frame = JSON.parse(line); }
                catch { this.close(new Error("Invalid bridge JSON")); return; }
                if (!frame || !Number.isSafeInteger(frame.id) || frame.id < 1) {
                    this.close(new Error("Invalid bridge message")); return;
                }
                if (frame.type === "reply") {
                    const pending = this.pending.get(frame.id);
                    if (!pending) continue;
                    this.pending.delete(frame.id); clearTimeout(pending.timer);
                    if (frame.error) pending.reject(new Error(String(frame.error)));
                    else pending.resolve(frame.result);
                } else if (frame.type === "request" && typeof frame.method === "string" && active < 16) {
                    active++;
                    Promise.resolve().then(() => this.handle(frame.method, frame.params)).then(
                        result => this.send({ type: "reply", id: frame.id, result }),
                        error => this.send({ type: "reply", id: frame.id, error: error.message }),
                    ).finally(() => { active--; }).catch(error => this.close(error));
                } else { this.close(new Error("Invalid or excessive bridge request")); return; }
            }
        });
        socket.on("error", error => this.close(error));
        socket.on("close", () => this.close(new Error("Bridge connection closed")));
    }
    send(frame) {
        if (this.closed) throw new Error("Bridge connection closed");
        const data = JSON.stringify(frame) + "\n";
        if (Buffer.byteLength(data) > limit || this.socket.writableLength > limit)
            throw new Error("Bridge message or write backlog exceeds 1 MiB");
        this.socket.write(data);
    }
    request(method, params, timeoutMs = 15000) {
        if (this.closed) return Promise.reject(new Error("Bridge connection closed"));
        if (this.pending.size >= 16) return Promise.reject(new Error("Bridge request queue full"));
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.close(new Error(`Bridge ${method} timed out; request was not retried`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try { this.send({ type: "request", id, method, params }); }
            catch (error) { this.close(error); }
        });
    }
    close(error = new Error("Bridge connection closed")) {
        if (this.closed) return;
        this.closed = true;
        this.socket.destroy();
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer); pending.reject(error);
        }
        this.pending.clear();
        this.emit("close", error);
    }
}

export async function connectBridge({ endpoint, token }, handle) {
    const socket = createConnection(endpoint);
    const peer = new BridgePeer(socket, handle);
    try {
        await peer.request("authenticate", { token }, 5000);
        return peer;
    } catch (error) { peer.close(); throw error; }
}
