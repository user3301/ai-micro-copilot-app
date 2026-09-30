// SPDX-License-Identifier: MIT
import { open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute } from "node:path";

export const ACTIONS = ["previous", "next", "attention", "new-session", "status",
    "focus", "brightness", "none"];

export const DEFAULT_CONFIG = {
    slots: [null, null, null, null, null, null],
    transport: "usb",
    serialNumber: null,
    brightness: 0.25,
    pollMs: 2000,
    backgroundIdleMs: 300000,
    keys: {
        ACT06: "previous", ACT07: "next", ACT08: "attention",
        ACT09: "new-session", ACT10: "status", ACT11: "focus",
        ACT12: "brightness", ENC: "focus", ENC_CW: "next", ENC_CC: "previous",
        JOY_UP: "attention", JOY_DOWN: "status",
        JOY_LEFT: "previous", JOY_RIGHT: "next",
    },
};

export function validateConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Configuration must be an object");
    const config = { ...structuredClone(DEFAULT_CONFIG), ...value,
        keys: { ...DEFAULT_CONFIG.keys, ...value.keys } };
    const allowed = new Set(Object.keys(DEFAULT_CONFIG));
    if (Object.keys(value).some(key => !allowed.has(key)))
        throw new Error("Unknown configuration field");
    if (!Array.isArray(config.slots) || config.slots.length !== 6 ||
        config.slots.some(id => id !== null && (typeof id !== "string" || !id.trim())))
        throw new Error("slots must contain exactly six session IDs or null");
    const ids = config.slots.filter(id => id !== null);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate session binding");
    if (!["usb", "bluetooth"].includes(config.transport))
        throw new Error("transport must be usb or bluetooth");
    if (config.serialNumber !== null &&
        (typeof config.serialNumber !== "string" || !config.serialNumber.trim()))
        throw new Error("serialNumber must be a nonempty string or null");
    if (!Number.isFinite(config.brightness) || config.brightness < 0 || config.brightness > 1)
        throw new Error("brightness must be between 0 and 1");
    if (!Number.isInteger(config.pollMs) || config.pollMs < 1000 || config.pollMs > 30000)
        throw new Error("pollMs must be between 1000 and 30000");
    if (!Number.isInteger(config.backgroundIdleMs) || config.backgroundIdleMs < 0 ||
        config.backgroundIdleMs > 86400000)
        throw new Error("backgroundIdleMs must be an integer between 0 and 86400000; 0 disables idle lighting");
    if (value.keys !== undefined && (!value.keys || typeof value.keys !== "object" ||
        Array.isArray(value.keys))) throw new Error("keys must be an object");
    for (const [key, action] of Object.entries(config.keys)) {
        if (!(key in DEFAULT_CONFIG.keys) || !ACTIONS.includes(action))
            throw new Error(`Invalid key mapping: ${key}`);
    }
    return config;
}

export function encodeReports(message) {
    const json = Buffer.from(JSON.stringify(message), "utf8");
    if (!json.length || json.length > 4096) throw new Error("JSON exceeds 4096 bytes");
    const wire = Buffer.concat([json, Buffer.from("\n")]);
    const reports = [];
    for (let offset = 0; offset < wire.length; offset += 61) {
        const fragment = wire.subarray(offset, offset + 61);
        const report = Buffer.alloc(64);
        report[0] = 6; report[1] = 2; report[2] = fragment.length;
        fragment.copy(report, 3);
        reports.push(report);
    }
    return reports;
}

// Match the firmware's object framing, including adjacent objects without a newline.
export class Decoder {
    constructor() { this.reset(); }
    reset() {
        this.bytes = []; this.closing = [];
        this.quoted = false; this.escaped = false; this.last = 0;
    }
    feed(report, now = Date.now()) {
        if (report.length !== 64 || report[0] !== 6 || report[1] !== 2 || report[2] > 61) {
            this.reset();
            throw new Error("Invalid HID Report 6 frame");
        }
        if (this.bytes.length && now - this.last > 1000) {
            this.reset();
            throw new Error("Partial HID message timed out");
        }
        this.last = now;
        const messages = [];
        try {
            for (const byte of report.subarray(3, 3 + report[2])) {
                if (!this.bytes.length && [9, 10, 13, 32].includes(byte)) continue;
                if (!this.bytes.length && byte !== 123) throw new Error("Expected JSON object");
                this.bytes.push(byte);
                if (byte === 0 || this.bytes.length > 4096) throw new Error("Invalid JSON size");
                if (this.quoted) {
                    if (this.escaped) this.escaped = false;
                    else if (byte === 92) this.escaped = true;
                    else if (byte === 34) this.quoted = false;
                } else if (byte === 34) this.quoted = true;
                else if (byte === 123 || byte === 91) {
                    this.closing.push(byte === 123 ? 125 : 93);
                    if (this.closing.length > 32) throw new Error("JSON nesting exceeds 32");
                } else if (byte === 125 || byte === 93) {
                    if (this.closing.pop() !== byte) throw new Error("Mismatched JSON bracket");
                    if (!this.closing.length) {
                        const text = new TextDecoder("utf-8", { fatal: true })
                            .decode(Buffer.from(this.bytes));
                        messages.push(JSON.parse(text));
                        this.reset();
                    }
                }
            }
            if (this.bytes.length) this.last = now;
            return messages;
        } catch (error) {
            this.reset();
            throw error;
        }
    }
}

export function sessionState(session) {
    if (!session) return "offline";
    if (session.awaiting_user_input || session.awaiting_plan_approval) return "waiting";
    if (session.activity?.status === "failed" || session.activity?.status === "error")
        return "error";
    // App can set is_running=false after a turn; explicit activity is authoritative.
    if (session.activity?.status === "busy") return "running";
    if (session.activity?.status === "idle") return "idle";
    if (session.is_running === false) return "offline";
    return "unknown";
}

export function lightsFor(slots, sessions, brightness, stale = false) {
    const palette = {
        empty: [0, "off"], offline: [0x303030, "solid"],
        unknown: [0x8050ff, "shallowBreath"], running: [0x0088ff, "breath"],
        waiting: [0xffaa00, "breath"], idle: [0x00cc66, "solid"],
        error: [0xff3030, "breath"],
    };
    const index = new Map(sessions.map(session => [session.id, session]));
    return slots.map((id, slot) => {
        const state = id === null ? "empty" : stale ? "unknown" : sessionState(index.get(id));
        const [c, e] = palette[state];
        return { id: slot, c, e, b: brightness, s: 0.5 };
    });
}

export function eventAction(message, config) {
    const p = message?.params;
    if (!p || typeof p !== "object") return null;
    if (message.method === "v.oai.hid") {
        if (typeof p.k !== "string") return null;
        const rotation = p.k === "ENC_CW" || p.k === "ENC_CC";
        if (p.act !== 1 && !(rotation && p.act === 2)) return null;
        if (/^AG0[0-5]$/.test(p.k)) {
            const slot = Number(p.k.at(-1));
            if (p.ag !== slot) throw new Error("Agent key/slot mismatch");
            return { action: "slot", slot };
        }
        const action = config.keys[p.k];
        return action ? { action } : null;
    }
    if (message.method === "v.oai.rad" && p.d === 1) {
        const key = { 0: "JOY_RIGHT", 0.25: "JOY_DOWN", 0.5: "JOY_LEFT", 0.75: "JOY_UP" }[p.a];
        const action = config.keys[key];
        return action ? { action } : null;
    }
    return null;
}

export function nextSlot(slots, selected, delta, eligible = () => true) {
    for (let step = 1; step <= 6; step++) {
        const slot = ((selected ?? (delta > 0 ? -1 : 0)) + step * delta + 12) % 6;
        if (slots[slot] !== null && eligible(slots[slot])) return slot;
    }
    throw new Error("No matching bound session");
}

export function parseSnapshot(value) {
    if (!value || !Array.isArray(value.sessions) ||
        value.sessions.some(s => !s || typeof s.id !== "string") ||
        new Set(value.sessions.map(s => s.id)).size !== value.sessions.length)
        throw new Error("Copilot App returned an unsupported session status format");
    return value.sessions;
}

export async function callApp(session, name, args = {}) {
    const result = await session.rpc.tools.execute({ name, arguments: args });
    if (typeof result !== "string" && (!result || result.resultType !== "success"))
        throw new Error(`${name}: ${result?.error || result?.textResultForLlm || "tool failed"}`);
    const value = typeof result === "string" ? result : result.structuredContent ?? result.textResultForLlm;
    if (typeof value !== "string" || !value.startsWith("Output too large to read at once")) return value;
    const match = /^Output too large to read at once \([^\r\n]+\)\. Saved to: ([^\r\n]+)(?:\r?\n|$)/.exec(value);
    if (!match) throw new Error(`${name}: unsupported oversized App output notice`);
    const path = match[1];
    if (!isAbsolute(path) || !/^\d+-copilot-tool-output-[a-f0-9]{32}\.txt$/i.test(basename(path)))
        throw new Error(`${name}: invalid saved App output path`);
    try {
        const [resolved, temp] = await Promise.all([realpath(path), realpath(tmpdir())]);
        const normalize = value => process.platform === "win32" ? value.toLowerCase() : value;
        if (normalize(dirname(resolved)) !== normalize(temp) || basename(resolved) !== basename(path))
            throw new Error("saved output must be an App output file in the local temporary directory");
        const file = await open(resolved, "r");
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
                throw new Error("saved output must be a regular file no larger than 16 MiB");
            return await file.readFile({ encoding: "utf8" });
        } finally { await file.close(); }
    } catch (error) {
        throw new Error(`${name}: cannot read saved App output: ${error.message}`, { cause: error });
    }
}

export async function readSessions(session) {
    const result = await callApp(session, "get_sessions_status");
    return parseSnapshot(typeof result === "string" ? JSON.parse(result) : result);
}
