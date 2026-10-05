// SPDX-License-Identifier: MIT
import { eventAction, lightsFor, nextSlot, sessionState, validateConfig } from "./core.mjs";

export class Controller {
    constructor({ config, readSessions, call, navigate, open, save, log, now = () => performance.now(),
        offlineNavigation = () => false }) {
        this.config = validateConfig(config);
        this.readSessions = readSessions; this.call = call;
        this.navigate = navigate;
        this.offlineNavigation = offlineNavigation;
        this.open = open; this.save = save; this.log = log;
        this.sessions = []; this.selected = null; this.running = false;
        this.stale = true; this.device = null; this.fault = null;
        this.identity = null;
        this.now = now; this.lastInputAt = now();
        this.refreshedAt = -Infinity;
        this.backgroundIdle = false; this.backgroundBrightness = null;
        this.queue = Promise.resolve(); this.queued = 0; this.lastError = "";
    }
    enqueue(operation, force = false) {
        if (!force && this.queued >= 16) return Promise.reject(new Error("Input queue full; action was not executed"));
        this.queued++;
        const result = this.queue.then(operation);
        this.queue = result.then(() => { this.queued--; }, () => { this.queued--; });
        return result;
    }
    report(error) {
        if (this.lastError !== error.message) {
            this.lastError = error.message;
            this.log(error.message, "error");
        }
    }
    async refresh() {
        try {
            this.sessions = await this.readSessions();
            this.refreshedAt = this.now();
            this.stale = false;
        } catch (error) {
            this.stale = true;
            throw error;
        }
    }
    async connect() {
        this.device = await this.open({
            transport: this.config.transport,
            serialNumber: this.config.serialNumber ?? this.identity,
        });
        this.identity = this.device.info?.serialNumber ?? this.identity;
        this.fault = null;
        this.backgroundBrightness = null;
        const device = this.device;
        device.on("fault", error => {
            if (this.device === device) { this.fault = error; this.report(error); }
        });
        device.on("input", message => {
            if (!this.running || this.device !== device || this.fault) return;
            try {
                const action = eventAction(message, this.config);
                if (action) {
                    this.lastInputAt = this.now();
                    this.enqueue(() => {
                        if (this.device !== device) throw new Error("Connection changed; queued action was not executed");
                        return this.perform(action);
                    }).catch(error => this.report(error));
                }
            } catch (error) { this.report(error); }
        });
        await this.paintBackground();
    }
    async paintBackground() {
        const idle = this.config.backgroundIdleMs > 0 &&
            this.now() - this.lastInputAt >= this.config.backgroundIdleMs;
        const brightness = idle ? 0 : this.config.brightness * 0.4;
        if (idle === this.backgroundIdle && brightness === this.backgroundBrightness) return;
        await this.device.request("v.oai.rgbcfg", {
            ambient: { c: idle ? 0 : 0x8050ff, b: brightness, e: idle ? "off" : "solid" },
            keys: { c: idle ? 0 : 0xffffff, b: brightness, e: idle ? "off" : "solid" },
        });
        this.backgroundIdle = idle; this.backgroundBrightness = brightness;
    }
    async paint() {
        await this.device.request("v.oai.thstatus",
            lightsFor(this.config.slots, this.sessions, this.config.brightness, this.stale));
    }
    start() {
        return this.enqueue(async () => {
            if (this.running) return this.status();
            if (this.config.slots.every(id => id === null)) throw new Error("Bind at least one session first");
            this.lastInputAt = this.now();
            await this.refresh();
            try {
                await this.connect();
                await this.paint();
                this.running = true;
                this.schedule();
                return this.status();
            } catch (error) {
                if (this.device) await this.device.close();
                this.device = null;
                throw error;
            }
        });
    }
    schedule() {
        if (!this.running) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.enqueue(() => this.tick()).catch(error => this.report(error))
                .finally(() => this.schedule());
        }, this.config.pollMs);
    }
    async tick() {
        if (!this.running) return;
        try {
            await this.refresh();
        } catch (error) { this.report(error); }
        try {
            if (this.fault && this.device) {
                const device = this.device; this.device = null;
                await device.close();
            }
            if (!this.device) await this.connect();
            await this.paintBackground();
            await this.paint();
            if (!this.stale && this.lastError) {
                this.lastError = "";
                this.log("AI Micro connection and session status recovered", "info");
            }
        } catch (error) {
            this.fault = error;
            this.report(error);
        }
    }
    stop() {
        // Stop accepting events immediately, before waiting for the serialized queue.
        this.running = false;
        clearTimeout(this.timer);
        return this.enqueue(async () => {
            this.running = false;
            clearTimeout(this.timer);
            this.identity = null;
            if (!this.device) return;
            const device = this.device; this.device = null;
            try {
                await device.request("v.oai.thstatus",
                    lightsFor([null, null, null, null, null, null], [], 0));
                await device.request("v.oai.rgbcfg", {
                    ambient: { c: 0, b: 0, e: "off" }, keys: { c: 0, b: 0, e: "off" },
                });
            } finally { await device.close(); }
        }, true);
    }
    configure(update) {
        return this.enqueue(() => this.applyConfig(update));
    }
    bind(slot, sessionId) {
        return this.enqueue(async () => {
            if (!Number.isInteger(slot) || slot < 1 || slot > 6)
                throw new Error("slot must be 1 to 6");
            if (sessionId !== null && (typeof sessionId !== "string" || !sessionId.trim()))
                throw new Error("sessionId must be a stable session ID or null");
            const slots = [...this.config.slots];
            slots[slot - 1] = sessionId;
            return this.applyConfig({ slots });
        });
    }
    async applyConfig(update) {
        validateConfig(update);
        const next = validateConfig({ ...this.config, ...update,
            keys: { ...this.config.keys, ...update.keys } });
        const connectionChanged = next.serialNumber !== this.config.serialNumber ||
            next.transport !== this.config.transport;
        if (this.running && connectionChanged)
            throw new Error("Stop the bridge before changing transport or serialNumber");
        await this.refresh();
        for (const id of next.slots) {
            if (id !== null && !this.sessions.some(s => s.id === id))
                throw new Error(`Session not found in Copilot App: ${id}`);
        }
        await this.save(next);
        if (this.selected !== null && next.slots[this.selected] !== this.config.slots[this.selected])
            this.selected = null;
        this.config = next;
        if (connectionChanged) this.identity = null;
        if (this.device && !this.fault) {
            try {
                await this.paintBackground();
                await this.paint();
            } catch (error) {
                this.fault = error;
                this.report(error);
                throw new Error(`Configuration saved; device sync failed and will retry: ${error.message}`);
            }
        }
        return this.status();
    }
    async focus(slot) {
        const id = this.config.slots[slot];
        if (!id) throw new Error(`Agent ${slot + 1} is not bound`);
        if (!this.sessions.some(s => s.id === id)) throw new Error("Bound session is unavailable; rebind this slot");
        await this.navigate(id);
        this.selected = slot;
    }
    async perform({ action, slot }) {
        if (!this.running) return;
        if (!this.device || this.fault) throw new Error("Device disconnected; queued action was not executed");
        const device = this.device;
        try { await this.paintBackground(); }
        catch (error) { this.fault = error; throw error; }
        if (action === "none") return;
        const cachedNavigation = ["slot", "next", "previous", "focus"].includes(action);
        if (!cachedNavigation || this.stale || this.now() - this.refreshedAt >= 2500 ||
            this.offlineNavigation()) {
            try { await this.refresh(); }
            catch (error) {
                if (!cachedNavigation || !this.offlineNavigation()) throw error;
                this.report(error);
                await this.paint();
            }
        }
        if (!this.running) return;
        if (this.device !== device || this.fault)
            throw new Error("Device disconnected during status refresh; action was not executed");
        if (action === "slot") return this.focus(slot);
        if (action === "next" || action === "previous")
            return this.focus(nextSlot(this.config.slots, this.selected, action === "next" ? 1 : -1,
                id => this.sessions.some(s => s.id === id)));
        if (action === "attention")
            return this.focus(nextSlot(this.config.slots, this.selected, 1,
                id => sessionState(this.sessions.find(s => s.id === id)) === "waiting"));
        if (action === "status") {
            this.log(JSON.stringify(this.status()), "info");
            return;
        }
        if (action === "brightness") {
            const value = this.config.brightness;
            const brightness = value < 0.1 ? 0.1 : value < 0.25 ? 0.25 : value < 0.5 ? 0.5 : 0;
            const next = { ...this.config, brightness };
            await this.save(next); this.config = next;
            await this.paintBackground();
            return this.paint();
        }
        if (this.selected === null) throw new Error("Press a bound Agent key first");
        if (action === "focus") return this.focus(this.selected);
        if (action === "new-session") {
            const selected = this.sessions.find(s => s.id === this.config.slots[this.selected]);
            if (!selected?.project_id) throw new Error("Selected session has no project; cannot create a session");
            // No kickoff: this opens an idle workspace, never an autonomous agent run.
            await this.call("create_session", {
                project_id: selected.project_id, name: "AI Micro session",
                coordinate_with_creator: false,
            });
            return;
        }
        throw new Error(`Unsupported action: ${action}`);
    }
    status() {
        return {
            running: this.running, connected: Boolean(this.device && !this.fault),
            transport: this.config.transport,
            serialNumber: this.device?.info?.serialNumber ?? this.config.serialNumber ?? this.identity,
            firmwareVersion: this.device?.info?.version ?? null,
            stale: this.stale, selectedSlot: this.selected === null ? null : this.selected + 1,
            backgroundIdle: this.running && this.backgroundIdle,
            backgroundIdleMs: this.config.backgroundIdleMs,
            error: this.lastError || null,
            slots: this.config.slots.map((id, slot) => {
                const session = this.sessions.find(s => s.id === id);
                return { slot: slot + 1, sessionId: id, name: session?.name ?? null,
                    state: id === null ? "empty" : this.stale ? "unknown" : sessionState(session) };
            }),
        };
    }
}
