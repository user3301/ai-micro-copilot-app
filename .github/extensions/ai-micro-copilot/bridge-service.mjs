// SPDX-License-Identifier: MIT
import { createServer } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { Controller } from "./controller.mjs";
import { parseSnapshot } from "./core.mjs";
import { sessionUrl } from "./navigation.mjs";
import { BridgePeer } from "./bridge-rpc.mjs";

export class BridgeService {
    constructor({ config, token, open, navigate, save, log, now = () => performance.now(),
        prepare = async () => {}, release = () => {} }) {
        this.token = token; this.now = now; this.log = log;
        this.feed = null; this.receivedAt = -Infinity;
        this.sessions = []; this.catalogue = [];
        this.prepare = prepare; this.release = release;
        this.peers = new Set();
        this.controls = Promise.resolve();
        this.stopping = false; this.shutdown = null;
        this.controller = new Controller({
            config, open, save, log, now,
            readSessions: async () => {
                if (!this.fresh()) throw new Error("App status unavailable; cached navigation only");
                return this.sessions;
            },
            offlineNavigation: () => !this.fresh(),
            navigate: async id => { await navigate(sessionUrl(this.catalogue, id)); },
            call: async (name, args) => {
                if (name !== "create_session" || !this.fresh()) throw new Error("App status unavailable");
                return this.feed.request("create-session", args);
            },
        });
    }
    fresh() {
        return Boolean(this.feed && !this.feed.closed &&
            this.now() - this.receivedAt < Math.max(5000, this.controller.config.pollMs * 2 + 1000));
    }
    status() {
        const status = this.controller.status();
        return { ...status, daemonPid: process.pid, pollMs: this.controller.config.pollMs, appConnected: this.fresh(),
            navigationMode: this.fresh() ? "live" : "cached",
            stale: status.stale || !this.fresh(),
            slots: status.slots.map(slot => slot.sessionId !== null && !this.fresh()
                ? { ...slot, state: "unknown" } : slot) };
    }
    async reconcile() {
        if (this.controller.running) await this.controller.tick();
    }
    async listen(endpoint) {
        this.server = createServer(socket => {
            if (this.stopping) { socket.destroy(); return; }
            let authenticated = false;
            const peer = new BridgePeer(socket, async (method, params) => {
                if (this.stopping) throw new Error("Bridge service is shutting down");
                if (!authenticated) {
                    const supplied = Buffer.from(typeof params?.token === "string" ? params.token : "");
                    const expected = Buffer.from(this.token);
                    if (method !== "authenticate" || supplied.length !== expected.length ||
                        !timingSafeEqual(supplied, expected)) throw new Error("Bridge authentication failed");
                    authenticated = true; clearTimeout(authTimer);
                    return { protocol: 1 };
                }
                if (["start", "stop", "bind", "configure"].includes(method)) {
                    const result = this.controls.then(() => this.handle(peer, method, params));
                    this.controls = result.catch(() => {});
                    return result;
                }
                return this.handle(peer, method, params);
            });
            this.peers.add(peer);
            const authTimer = setTimeout(() => peer.close(new Error("Bridge authentication timed out")), 5000);
            peer.on("close", () => {
                clearTimeout(authTimer); this.peers.delete(peer);
                if (this.feed === peer) {
                    this.feed = null; this.receivedAt = -Infinity;
                    this.controller.stale = true;
                    if (!this.stopping)
                        this.controller.enqueue(() => this.reconcile())
                            .catch(error => this.controller.report(error));
                }
            });
        });
        this.server.maxConnections = 16;
        await new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(endpoint, resolve);
        });
        this.server.on("error", error => this.controller.report(error));
    }
    async handle(peer, method, params) {
        if (this.stopping) throw new Error("Bridge service is shutting down");
        if (method === "attach") {
            if (this.feed && this.feed !== peer && !this.feed.closed)
                throw new Error("Another extension is providing App status");
            this.feed = peer;
            return this.status();
        }
        if (method === "snapshot" || method === "unavailable") {
            if (this.feed !== peer) throw new Error("Attach the App feed first");
            // Invalidate before validating: a malformed update must never preserve a live indication.
            this.receivedAt = -Infinity; this.controller.stale = true;
            if (method === "snapshot") {
                try {
                    const sessions = parseSnapshot({ sessions: params?.sessions });
                    if (!Array.isArray(params?.catalogue)) throw new Error("Invalid App catalogue");
                    for (const id of this.controller.config.slots.filter(Boolean)) {
                        if (sessions.some(s => s.id === id)) sessionUrl(params.catalogue, id);
                    }
                    this.sessions = sessions; this.catalogue = params.catalogue;
                    this.receivedAt = this.now();
                } catch (error) {
                    this.catalogue = [];
                    throw error;
                }
            }
            await this.controller.enqueue(() => this.reconcile());
            return this.status();
        }
        if (method === "status") return this.status();
        if (method === "stop") {
            try { await this.controller.stop(); } finally { this.release(); }
            return this.status();
        }
        if (method === "start") {
            try { await this.prepare(); await this.controller.start(); }
            catch (error) { this.release(); throw error; }
            return this.status();
        }
        if (method === "bind" || method === "configure") {
            if (!this.fresh()) throw new Error("App status unavailable; configuration was not changed");
            const ids = method === "bind" ? [params?.sessionId] : params?.slots;
            if (Array.isArray(ids)) {
                for (const id of ids.filter(id => id !== null)) sessionUrl(this.catalogue, id);
            }
            if (method === "bind") await this.controller.bind(params?.slot, params?.sessionId);
            else await this.controller.configure(params);
            return this.status();
        }
        throw new Error(`Unsupported bridge operation: ${method}`);
    }
    close(beforeUnlock = async () => {}) {
        if (this.shutdown) return this.shutdown;
        this.stopping = true;
        // Reject traffic but retain the singleton pipe until hardware and discovery cleanup finish.
        for (const peer of this.peers) peer.close();
        this.shutdown = (async () => {
            await this.controls;
            try { await this.controller.stop(); }
            finally {
                try { this.release(); }
                finally {
                    try { await beforeUnlock(); }
                    finally {
                        if (this.server?.listening)
                            await new Promise(resolve => this.server.close(resolve));
                    }
                }
            }
        })();
        return this.shutdown;
    }
}
