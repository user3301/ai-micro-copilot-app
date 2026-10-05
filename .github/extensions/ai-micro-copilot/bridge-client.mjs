// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";
import { callApp, readSessions } from "./core.mjs";
import { connectBridge } from "./bridge-rpc.mjs";

export class BridgeClient {
    constructor({ session, runtimePath, configPath, log }) {
        this.session = session; this.runtimePath = runtimePath; this.configPath = configPath; this.log = log;
        this.peer = null; this.catalogue = null; this.expires = 0;
        this.queue = Promise.resolve(); this.closed = false; this.lastError = "";
        this.pollMs = 2000;
    }
    serialize(operation) {
        const result = this.queue.then(() => {
            if (this.closed) throw new Error("App bridge client stopped");
            return operation();
        });
        this.queue = result.catch(() => {});
        return result;
    }
    async connect() {
        if (this.peer && !this.peer.closed) return this.peer;
        let runtime;
        try { runtime = JSON.parse(await readFile(this.runtimePath, "utf8")); }
        catch (error) {
            if (error.code === "ENOENT")
                throw new Error("Independent bridge is not running. Start node daemon.mjs in a separate persistent process first.");
            throw error;
        }
        if (runtime.protocol !== 1 || runtime.configPath !== this.configPath ||
            typeof runtime.token !== "string" || !/^[a-f0-9]{64}$/.test(runtime.token) ||
            typeof runtime.endpoint !== "string" || !/^\\\\\.\\pipe\\ai-micro-copilot-[a-f0-9]{16}$/.test(runtime.endpoint))
            throw new Error("Invalid independent bridge discovery file");
        const peer = await connectBridge(runtime, async (method, args) => {
            if (method !== "create-session" || !args || typeof args.project_id !== "string" ||
                args.name !== "AI Micro session" || args.coordinate_with_creator !== false ||
                Object.keys(args).some(key => !["project_id", "name", "coordinate_with_creator"].includes(key)))
                throw new Error("Unsupported App bridge action");
            return callApp(this.session, "create_session", args);
        });
        if (this.closed) { peer.close(); throw new Error("App bridge client stopped"); }
        this.peer = peer; this.catalogue = null; this.expires = 0;
        return peer;
    }
    async publish(peer, forceCatalogue = false) {
        await peer.request("attach");
        try {
            const sessions = await readSessions(this.session);
            if (forceCatalogue || this.catalogue === null || performance.now() >= this.expires) {
                const result = await callApp(this.session, "list_sessions_and_chats");
                const catalogue = typeof result === "string"
                    ? JSON.parse(result.replace(/^Found \d+ item\(s\):\s*/, "")) : result;
                if (!Array.isArray(catalogue)) throw new Error("Unsupported App catalogue format");
                this.catalogue = catalogue.map(item => ({ id: item?.id, app_url: item?.app_url }));
                this.expires = performance.now() + 30000;
            }
            // Do not send prompts, conversation bodies, or full pending-input objects to the daemon.
            const compact = sessions.map(s => ({
                id: s.id, name: s.name, project_id: s.project_id, is_running: s.is_running,
                awaiting_user_input: Boolean(s.awaiting_user_input),
                awaiting_plan_approval: Boolean(s.awaiting_plan_approval),
                activity: { status: s.activity?.status },
            }));
            await peer.request("snapshot", { sessions: compact, catalogue: this.catalogue });
        } catch (error) {
            this.catalogue = null;
            if (!peer.closed) {
                try { await peer.request("unavailable"); }
                catch (offlineError) { this.log(`Cannot mark App feed unavailable: ${offlineError.message}`, "error"); }
            }
            throw error;
        }
    }
    request(operation, params) {
        return this.serialize(async () => {
            const peer = await this.connect();
            if (["start", "bind", "configure"].includes(operation)) await this.publish(peer, true);
            const result = await peer.request(operation, params);
            if (result?.pollMs) this.pollMs = result.pollMs;
            return result;
        });
    }
    start() {
        const poll = async () => {
            try {
                await this.serialize(async () => {
                    const peer = await this.connect();
                    const status = await peer.request("status");
                    this.pollMs = status.pollMs ?? 2000;
                    if (status.running) await this.publish(peer);
                    if (this.lastError) {
                        this.lastError = ""; this.log("Independent bridge App feed recovered", "info");
                    }
                });
            } catch (error) {
                if (!this.closed && this.lastError !== error.message) {
                    this.lastError = error.message; this.log(error.message, "error");
                }
            } finally {
                if (!this.closed) this.timer = setTimeout(poll, this.pollMs);
            }
        };
        void poll();
    }
    close() {
        this.closed = true; clearTimeout(this.timer);
        this.peer?.close();
    }
}
